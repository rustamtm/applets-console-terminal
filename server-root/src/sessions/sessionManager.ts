import crypto from "node:crypto";
import XtermHeadless from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { IPty } from "node-pty";
import type WebSocket from "ws";
import { spawn } from "node-pty";
import type { AccessUser } from "../auth/access.js";
import { resolveSpawnSpec, type CreateSessionRequest, type ModeConfig, type ModeName } from "./modes.js";

export type SessionId = string;

const HeadlessTerminalCtor = (
  XtermHeadless as unknown as { Terminal: typeof import("@xterm/headless").Terminal }
).Terminal;

export type Session = {
  id: SessionId;
  userId: string;
  email?: string;
  mode: ModeName;
  cwd: string;
  tmuxName?: string;
  resumeKey?: string;
  createdAt: number;
  lastActivityAt: number;
  lastSnapshotAt?: number;
  codexState?: "running" | "idle" | "done";
  codexStateSeen?: boolean;
  codexLocked?: boolean;
  codexIdleTimer?: NodeJS.Timeout;
  codexOscBuffer?: string;

  // Best-effort context capture from terminal output (used for AI naming/debug).
  lastTitle?: string;
  lastTitleAt?: number;
  lastCwd?: string;
  lastCwdAt?: number;
  outputTail?: string;
  outputTailAt?: number;
  oscBuffer?: string;

  pty: IPty;
  headless: HeadlessTerminal;
  serializer: SerializeAddon;
  pendingHeadlessResize?: { cols: number; rows: number };
  headlessResizeQueued?: boolean;

  connections: Set<WebSocket>;
  pendingConnections: Map<WebSocket, { seq: number; bytes: Buffer }[]>;
  outputSeq: number;
  writeChain: Promise<void>;
  killTimer?: NodeJS.Timeout;
  closed: boolean;
};

const ANSI_REGEX =
  /[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const CODEX_CLI_ACTIVITY_REGEX =
  /(esc to interrupt|context left|openai codex|codex\s*\(v|\b\/permissions\b|\b\/model\b|codex>)/i;
const CODEX_IDLE_TIMEOUT_MS = 20_000;
const OSC_BUFFER_MAX_CHARS = 4096;
const OUTPUT_TAIL_MAX_CHARS = 12_000;
const OSC_REGEX = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

function stripAnsi(input: string): string {
  return input.replace(ANSI_REGEX, "");
}

function sanitizeOutputTailChunk(raw: string): string {
  const noAnsi = stripAnsi(raw);
  const noOsc = noAnsi.replace(OSC_REGEX, "");
  const normalized = noOsc.replace(/\r/g, "\n");
  // Drop most control characters while keeping \n and \t.
  return normalized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

function normalizeCodexSignal(data: string): "running" | "idle" | "done" | null {
  const normalized = String(data ?? "").trim().toLowerCase();
  let value = normalized;
  if (value.startsWith("codex=") || value.startsWith("codex:")) {
    value = value.slice(6).trim();
  } else if (value.startsWith("codex ")) {
    value = value.slice(6).trim();
  }
  if (value === "running" || value === "idle" || value === "done") return value;
  return null;
}

function consumeOsc777(session: Session, chunk: string): string[] {
  const buffer = (session.codexOscBuffer ?? "") + chunk;
  const signals: string[] = [];
  let cursor = 0;
  while (true) {
    const start = buffer.indexOf("\u001b]777;", cursor);
    if (start === -1) break;
    const payloadStart = start + 6;
    const bel = buffer.indexOf("\u0007", payloadStart);
    const st = buffer.indexOf("\u001b\\", payloadStart);
    let end = -1;
    let termLen = 0;
    if (bel !== -1 && (st === -1 || bel < st)) {
      end = bel;
      termLen = 1;
    } else if (st !== -1) {
      end = st;
      termLen = 2;
    }
    if (end === -1) {
      cursor = start;
      break;
    }
    signals.push(buffer.slice(payloadStart, end));
    cursor = end + termLen;
  }
  let remaining = buffer.slice(cursor);
  if (remaining.length > 4096) remaining = remaining.slice(-4096);
  session.codexOscBuffer = remaining;
  return signals;
}

function normalizeCwdCandidate(raw: string): string | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("file://")) {
    try {
      const url = new URL(trimmed);
      if (url.protocol === "file:") {
        const pathname = decodeURIComponent(url.pathname || "");
        if (pathname) return pathname;
      }
    } catch {
      // ignore malformed file URLs
    }
  }

  const patterns = [
    /^(~(?:\/.*)?|\/\S+)$/,
    /^\S+@\S+:\s*(~(?:\/.*)?|\/\S+)$/,
    /^\S+@\S+\s+(~(?:\/.*)?|\/\S+)$/,
    /^\S+:\s*(~(?:\/.*)?|\/\S+)$/
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (!match?.[1]) continue;
    const cleaned = match[1].replace(/[)\],;]+$/, "");
    if (cleaned) return cleaned;
  }

  return null;
}

function consumeOscContext(session: Session, chunk: string) {
  const buffer = (session.oscBuffer ?? "") + chunk;
  let cursor = 0;
  while (true) {
    const start = buffer.indexOf("\u001b]", cursor);
    if (start === -1) break;

    const codeStart = start + 2;
    const semi = buffer.indexOf(";", codeStart);
    if (semi === -1) {
      cursor = start;
      break;
    }

    const codeRaw = buffer.slice(codeStart, semi);
    if (!/^[0-9]{1,4}$/.test(codeRaw)) {
      cursor = semi + 1;
      continue;
    }

    const code = Number(codeRaw);
    const payloadStart = semi + 1;
    const bel = buffer.indexOf("\u0007", payloadStart);
    const st = buffer.indexOf("\u001b\\", payloadStart);
    let end = -1;
    let termLen = 0;
    if (bel !== -1 && (st === -1 || bel < st)) {
      end = bel;
      termLen = 1;
    } else if (st !== -1) {
      end = st;
      termLen = 2;
    }

    if (end === -1) {
      cursor = start;
      break;
    }

    const payload = buffer.slice(payloadStart, end);
    const now = Date.now();

    if (code === 0 || code === 2) {
      const title = payload.trim().slice(0, 300);
      if (title) {
        session.lastTitle = title;
        session.lastTitleAt = now;
      }
      const cwdCandidate = normalizeCwdCandidate(payload);
      if (cwdCandidate) {
        session.lastCwd = cwdCandidate.slice(0, 300);
        session.lastCwdAt = now;
      }
    } else if (code === 7) {
      const cwdCandidate = normalizeCwdCandidate(payload);
      if (cwdCandidate) {
        session.lastCwd = cwdCandidate.slice(0, 300);
        session.lastCwdAt = now;
      }
    }

    cursor = end + termLen;
  }

  let remaining = buffer.slice(cursor);
  if (remaining.length > OSC_BUFFER_MAX_CHARS) remaining = remaining.slice(-OSC_BUFFER_MAX_CHARS);
  session.oscBuffer = remaining;
}

export type AttachTokenRecord = {
  sessionId: string;
  userId: string;
  expiresAt: number;
  cols?: number;
  rows?: number;
};

export type SessionManagerConfig = {
  modeConfig: ModeConfig;
  tmuxPrefix: string;
  attachTokenTtlMs: number;
  detachGraceMs: number;
  idleTimeoutMs: number;
  maxSessionsPerUser: number;
  snapshotIntervalMs?: number;
  onOutput?: (session: Session, data: string) => void;
  onSnapshot?: (session: Session, snapshot: string) => void | Promise<void>;
  onSessionClosed?: (sessionId: string, reason: string) => void;
};

export class SessionManager {
  private readonly cfg: SessionManagerConfig;
  private readonly sessions = new Map<SessionId, Session>();
  private readonly attachTokens = new Map<string, AttachTokenRecord>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(cfg: SessionManagerConfig) {
    this.cfg = cfg;
    this.sweeper = setInterval(() => this.sweep(), 30_000);
    this.sweeper.unref();
  }

  private normalizeSize(cols?: number, rows?: number) {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return undefined;
    const safeCols = Number(cols);
    const safeRows = Number(rows);
    if (safeCols < 10 || safeCols > 500 || safeRows < 5 || safeRows > 300) return undefined;
    return { cols: safeCols, rows: safeRows };
  }

  private enqueueHeadless(session: Session, opName: string, op: () => Promise<void>) {
    // Best-effort serialization of headless terminal ops (write/resize/serialize).
    // Important: never let this chain get permanently rejected, or new sessions
    // won't be able to snapshot/attach reliably.
    session.writeChain = session.writeChain
      .catch(() => {
        // swallow prior headless failures
      })
      .then(async () => {
        if (session.closed) return;
        try {
          await op();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn("[headless] op failed", { opName, sessionId: session.id, message });
        }
      })
      .catch(() => {
        // swallow to keep chain alive
      });
  }

  private queueHeadlessResize(session: Session, cols: number, rows: number) {
    session.pendingHeadlessResize = { cols, rows };
    if (session.headlessResizeQueued) return;
    session.headlessResizeQueued = true;

    this.enqueueHeadless(session, "resize", async () => {
      session.headlessResizeQueued = false;
      const pending = session.pendingHeadlessResize;
      session.pendingHeadlessResize = undefined;
      if (!pending) return;
      session.headless.resize(pending.cols, pending.rows);
    });
  }

  private sanitizePrefix(raw: string) {
    const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, "");
    return cleaned || "console";
  }

  private makeTmuxName(userId: string) {
    const prefix = this.sanitizePrefix(this.cfg.tmuxPrefix);
    const userPart = Buffer.from(userId).toString("base64url").replace(/=+$/g, "");
    const shortId = crypto.randomBytes(4).toString("hex");
    return `${prefix}-${userPart}-${shortId}`;
  }

  listForUser(userId: string) {
    return [...this.sessions.values()]
      .filter((s) => s.userId === userId && !s.closed)
      .map((s) => ({
        id: s.id,
        mode: s.mode,
        cwd: s.cwd,
        createdAt: s.createdAt,
        lastActivityAt: s.lastActivityAt,
        tmuxName: s.tmuxName,
        ...(s.codexStateSeen ? { codexState: s.codexState ?? "idle" } : {})
      }));
  }

  assertSessionOwner(userId: string, sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed || session.userId !== userId) {
      throw new Error("Not found");
    }
    return session;
  }

  create(user: AccessUser, req: CreateSessionRequest): Session {
    const activeCount = this.listForUser(user.userId).length;
    if (activeCount >= this.cfg.maxSessionsPerUser) {
      throw new Error(`Session limit exceeded (max ${this.cfg.maxSessionsPerUser})`);
    }

    let effectiveReq = req;
    if (req.mode === "tmux" && !req.tmuxName) {
      effectiveReq = { ...req, tmuxName: this.makeTmuxName(user.userId) };
    }

    const spawnSpec = resolveSpawnSpec(this.cfg.modeConfig, effectiveReq);

    const pty = spawn(spawnSpec.file, spawnSpec.args, {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd: spawnSpec.cwd,
      env: spawnSpec.env
    });

    const headless = new HeadlessTerminalCtor({
      cols: 120,
      rows: 30,
      allowProposedApi: true
    });
    const serializer = new SerializeAddon();
    headless.loadAddon(serializer);

    const now = Date.now();
    const id = crypto.randomUUID();

    const session: Session = {
      id,
      userId: user.userId,
      email: user.email,
      mode: req.mode,
      cwd: spawnSpec.cwd,
      tmuxName: effectiveReq.tmuxName,
      resumeKey: req.resumeKey,
      createdAt: now,
      lastActivityAt: now,
      pty,
      headless,
      serializer,
      connections: new Set(),
      pendingConnections: new Map(),
      outputSeq: 0,
      writeChain: Promise.resolve(),
      closed: false
    };

    if (req.initialSnapshot) {
      this.enqueueHeadless(
        session,
        "initial_snapshot",
        () =>
          new Promise<void>((resolve) => {
            try {
              headless.write(req.initialSnapshot!, resolve);
            } catch {
              resolve();
            }
          })
      );
      session.lastSnapshotAt = Date.now();
    }

    const size = this.normalizeSize(req.cols, req.rows);
    if (size) {
      try {
        pty.resize(size.cols, size.rows);
        headless.resize(size.cols, size.rows);
      } catch {
        // ignore resize failures
      }
    }

    pty.onData((data) => {
      if (session.closed) return;
      consumeOscContext(session, data);
      const tailChunk = sanitizeOutputTailChunk(data);
      if (tailChunk) {
        const next = (session.outputTail ?? "") + tailChunk;
        session.outputTail = next.length > OUTPUT_TAIL_MAX_CHARS ? next.slice(-OUTPUT_TAIL_MAX_CHARS) : next;
        session.outputTailAt = Date.now();
      }
      session.outputSeq += 1;
      const seq = session.outputSeq;
      session.lastActivityAt = Date.now();
      this.enqueueHeadless(
        session,
        "pty_write",
        () =>
          new Promise<void>((resolve) => {
            try {
              headless.write(data, resolve);
            } catch {
              resolve();
            }
          })
      );

      const bytes = Buffer.from(data, "binary");
      for (const ws of session.connections) {
        if (ws.readyState === ws.OPEN) ws.send(bytes);
      }
      for (const [ws, buf] of session.pendingConnections.entries()) {
        buf.push({ seq, bytes });
      }

      this.cfg.onOutput?.(session, data);
      this.handleCodexOutput(session, data);
      this.maybeSnapshot(session, false);
    });

    pty.onExit(({ exitCode, signal }) => {
      this.maybeSnapshot(session, true);
      this.clearCodexIdleTimer(session);
      session.closed = true;
      for (const ws of session.connections) {
        try {
          ws.send(
            JSON.stringify({
              type: "exit",
              exitCode,
              signal
            })
          );
        } catch {
          // ignore
        }
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
      session.connections.clear();
      this.cfg.onSessionClosed?.(session.id, "pty_exit");
    });

    this.sessions.set(id, session);
    return session;
  }

  findByResumeKey(userId: string, resumeKey: string): Session | undefined {
    for (const session of this.sessions.values()) {
      if (session.closed) continue;
      if (session.userId !== userId) continue;
      if (session.resumeKey !== resumeKey) continue;
      return session;
    }
    return undefined;
  }

  closeByResumeKey(userId: string, resumeKey: string) {
    const session = this.findByResumeKey(userId, resumeKey);
    if (!session) return;
    this.killSession(session, "user_close");
  }

  close(userId: string, sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) return;
    if (session.userId !== userId) throw new Error("Not found");
    this.killSession(session, "user_close");
  }

  mintAttachToken(userId: string, sessionId: string, size?: { cols?: number; rows?: number }): string {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) throw new Error("Not found");
    if (session.userId !== userId) throw new Error("Not found");

    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + this.cfg.attachTokenTtlMs;
    const normalized = this.normalizeSize(size?.cols, size?.rows);
    this.attachTokens.set(token, { sessionId, userId, expiresAt, ...normalized });
    return token;
  }

  consumeAttachToken(token: string): AttachTokenRecord {
    const record = this.attachTokens.get(token);
    if (!record) throw new Error("Invalid attach token");
    this.attachTokens.delete(token);
    if (Date.now() > record.expiresAt) throw new Error("Attach token expired");
    return record;
  }

  async attachWithSnapshot(sessionId: string, ws: WebSocket) {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) throw new Error("Not found");

    if (session.killTimer) {
      clearTimeout(session.killTimer);
      session.killTimer = undefined;
    }

    // Buffer output until we've sent a snapshot, so the client doesn't render
    // new output and then reset the screen.
    session.pendingConnections.set(ws, []);

    const snapshotSeq = session.outputSeq;
    const chain = session.writeChain;
    await chain;

    if (ws.readyState !== ws.OPEN) {
      session.pendingConnections.delete(ws);
      return;
    }

    const snapshot = session.serializer.serialize();
    ws.send(JSON.stringify({ type: "snapshot", data: snapshot }));

    const buffered = session.pendingConnections.get(ws) ?? [];
    for (const item of buffered) {
      if (item.seq > snapshotSeq && ws.readyState === ws.OPEN) {
        ws.send(item.bytes);
      }
    }

    session.pendingConnections.delete(ws);
    session.connections.add(ws);
  }

  detach(sessionId: string, ws: WebSocket) {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) return;

    session.pendingConnections.delete(ws);
    session.connections.delete(ws);
    if (session.connections.size === 0 && this.cfg.detachGraceMs > 0) {
      session.killTimer = setTimeout(() => {
        this.killSession(session, "detach_grace_expired");
      }, this.cfg.detachGraceMs);
      session.killTimer.unref();
    }
  }

  resize(userId: string, sessionId: string, cols: number, rows: number) {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) throw new Error("Not found");
    if (session.userId !== userId) throw new Error("Not found");
    const size = this.normalizeSize(cols, rows);
    if (!size) return;
    try {
      session.pty.resize(size.cols, size.rows);
    } catch {
      // ignore resize failures
    }
    this.queueHeadlessResize(session, size.cols, size.rows);
  }

  write(sessionId: string, data: Buffer) {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) throw new Error("Not found");
    session.lastActivityAt = Date.now();
    session.pty.write(data);
  }

  private handleCodexOutput(session: Session, raw: string) {
    const signals = consumeOsc777(session, raw);
    for (const signal of signals) {
      const state = normalizeCodexSignal(signal);
      if (!state) continue;
      this.setCodexState(session, state);
    }

    const cleaned = stripAnsi(raw);
    if (CODEX_CLI_ACTIVITY_REGEX.test(cleaned)) {
      this.bumpCodexActivity(session);
    }
  }

  private setCodexState(session: Session, state: "running" | "idle" | "done") {
    session.codexStateSeen = true;
    session.codexState = state;
    session.codexLocked = state === "running";
    this.clearCodexIdleTimer(session);
  }

  private bumpCodexActivity(session: Session) {
    if (session.codexLocked) return;
    session.codexStateSeen = true;
    session.codexState = "running";
    this.clearCodexIdleTimer(session);
    session.codexIdleTimer = setTimeout(() => {
      if (session.codexLocked) return;
      session.codexState = "idle";
    }, CODEX_IDLE_TIMEOUT_MS);
    session.codexIdleTimer.unref?.();
  }

  private clearCodexIdleTimer(session: Session) {
    if (!session.codexIdleTimer) return;
    clearTimeout(session.codexIdleTimer);
    session.codexIdleTimer = undefined;
  }

  private sweep() {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.closed) continue;
      if (this.cfg.idleTimeoutMs > 0 && now - session.lastActivityAt > this.cfg.idleTimeoutMs) {
        this.killSession(session, "idle_timeout");
      }
    }

    for (const [token, rec] of this.attachTokens.entries()) {
      if (now > rec.expiresAt) this.attachTokens.delete(token);
    }
  }

  private killSession(session: Session, reason: string) {
    if (session.closed) return;
    this.maybeSnapshot(session, true);
    this.clearCodexIdleTimer(session);
    session.closed = true;
    try {
      session.pty.kill();
    } catch {
      // ignore
    }
    for (const ws of session.connections) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    session.connections.clear();
    this.sessions.delete(session.id);
    this.cfg.onSessionClosed?.(session.id, reason);
  }

  shutdown() {
    clearInterval(this.sweeper);
    for (const session of this.sessions.values()) this.killSession(session, "shutdown");
    this.attachTokens.clear();
  }

  private maybeSnapshot(session: Session, force: boolean) {
    if (!this.cfg.onSnapshot) return;
    if (!session.resumeKey) return;
    const interval = this.cfg.snapshotIntervalMs ?? 0;
    const now = Date.now();
    if (!force && interval > 0) {
      if (session.lastSnapshotAt && now - session.lastSnapshotAt < interval) return;
    }
    session.lastSnapshotAt = now;
    const chain = session.writeChain;
    void chain
      .then(() => {
        const snapshot = session.serializer.serialize();
        return this.cfg.onSnapshot?.(session, snapshot);
      })
      .catch(() => {
        // ignore snapshot failures
      });
  }
}
