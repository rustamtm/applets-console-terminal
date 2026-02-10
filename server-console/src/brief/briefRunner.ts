import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type OpenAiResponseUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
};

export type BriefReport = {
  overall_summary: string;
  what_completed: string[];
  what_in_progress: string[];
  what_blocked: string[];
  next_actions: string[];
  confidence: number;
  followup_questions: string[];
  spoken_script: string;
};

export type BriefPrefsLike = {
  tmuxEnabled: boolean;
  tmuxMatchRegex: string;
  tmuxMaxSessions: number;
  tmuxRecentMinutes: number;
  tasksEnabled: boolean;
  tasksFolder: string;
  tasksMaxFiles: number;
  tasksRecentHours: number;
  tasksIncludeGlobs: string[];
  tasksExcludeGlobs: string[];
  openAiModel: string;
  ttsModel: string;
  voice: string;
  spokenSeconds: number;
  redactPaths: boolean;
  maxCharsPerFile: number;
};

export type BriefRunResult = {
  report: BriefReport;
  reportJsonText: string;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
  };
  cost: {
    currency: "USD";
    totalCents: number | null;
    responsesCents: number | null;
    ttsCents: number | null;
    note: string;
  };
  audio: {
    format: "pcm16";
    sampleRate: number;
    channels: 1;
    seconds: number;
    bytes: number;
    base64: string;
  };
};

type RunOptions = {
  userId: string;
  now: Date;
  codexExecCwd: string;
  prefs: BriefPrefsLike;
  openai: { apiKey: string; baseUrl: string; timeoutMs: number };
  tts: { apiKey: string; baseUrl: string };
  signal?: AbortSignal;
};

function clampInt(value: unknown, { min, max, fallback }: { min: number; max: number; fallback: number }): number {
  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(num)) return fallback;
  const rounded = Math.trunc(num);
  return Math.max(min, Math.min(max, rounded));
}

function clampBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

function clampString(value: unknown, max: number, fallback = ""): string {
  const s = String(value ?? "").trim();
  if (!s) return fallback;
  if (s.length <= max) return s;
  return s.slice(0, max);
}

function normalizeBaseUrl(raw: string): string {
  return String(raw || "").trim().replace(/\/+$/g, "") || "https://api.openai.com";
}

function redactSecrets(input: string): string {
  let out = input;
  out = out.replace(/\bsk-[A-Za-z0-9]{20,}\b/g, "sk-REDACTED");
  out = out.replace(/\bAuthorization:\s*Bearer\s+\S+/gi, "Authorization: Bearer REDACTED");
  out = out.replace(/\b(OPENAI_API_KEY|CONSOLE_APP_TOKEN|CF_ACCESS_CLIENT_SECRET)\s*=\s*\S+/g, "$1=REDACTED");
  return out;
}

function redactPaths(input: string, { homeDir, repoDir }: { homeDir: string; repoDir: string }): string {
  let out = input;
  if (homeDir) out = out.split(homeDir).join("~");
  if (repoDir) out = out.split(repoDir).join("<REPO>");
  return out;
}

function sanitizeForPrompt(text: string, redaction: { homeDir: string; repoDir: string }, enabled: boolean): string {
  const base = redactSecrets(String(text ?? ""));
  if (!enabled) return base;
  return redactPaths(base, redaction);
}

function parseRegex(raw: string, fallbackRaw: string): { re: RegExp; normalized: string } {
  const fallback = String(fallbackRaw || "codex").trim() || "codex";
  const trimmed = String(raw || "").trim();
  const candidate = trimmed || fallback;

  // Support /pattern/flags as well as Python-style inline flags: (?i)pattern
  const slashMatch = candidate.match(/^\/(.+)\/([a-z]*)$/i);
  if (slashMatch) {
    try {
      const pattern = slashMatch[1] ?? "";
      const flags = (slashMatch[2] ?? "").replace(/[^gimsuy]/g, "");
      const re = new RegExp(pattern, flags);
      return { re, normalized: `/${pattern}/${flags}` };
    } catch {
      // fall through to other parsing
    }
  }

  const inline = candidate.match(/^\(\?([a-z]+)\)(.*)$/i);
  if (inline) {
    const flagSet = new Set(String(inline[1] || "").toLowerCase().split(""));
    const flags = Array.from(new Set(["i", "m", "s", "u"].filter((f) => flagSet.has(f)))).join("");
    const pattern = String(inline[2] ?? "").trim() || fallback;
    try {
      const re = new RegExp(pattern, flags);
      const normalized = flags ? `(?${flags})${pattern}` : pattern;
      return { re, normalized };
    } catch {
      // fall through to fallback regex
    }
  }

  try {
    const re = new RegExp(candidate, "i");
    return { re, normalized: `(?i)${candidate}` };
  } catch {
    const re = new RegExp(fallback, "i");
    return { re, normalized: `(?i)${fallback}` };
  }
}

function compileGlob(glob: string): { re: RegExp; basenameOnly: boolean; raw: string } | null {
  const cleaned = String(glob || "").trim().replace(/\\/g, "/");
  if (!cleaned) return null;
  const basenameOnly = !cleaned.includes("/");
  let out = "^";
  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (ch === "*") {
      const next = cleaned[i + 1];
      if (next === "*") {
        out += ".*";
        i += 1;
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  out += "$";
  try {
    return { re: new RegExp(out, "i"), basenameOnly, raw: cleaned };
  } catch {
    return null;
  }
}

function matchesGlobs(rel: string, globs: { re: RegExp; basenameOnly: boolean }[]): boolean {
  if (!globs.length) return false;
  const normalized = rel.replace(/\\/g, "/");
  const basename = normalized.split("/").pop() || normalized;
  for (const g of globs) {
    const target = g.basenameOnly ? basename : normalized;
    if (g.re.test(target)) return true;
  }
  return false;
}

function uniqKeepOrder(values: string[], max = 8): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const v = String(raw ?? "").trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

function fmtIso(ms: number | undefined): string {
  if (!Number.isFinite(ms) || !ms) return "";
  try {
    return new Date(ms).toISOString();
  } catch {
    return "";
  }
}

function execFileText(
  file: string,
  args: string[],
  opts: { timeoutMs: number; maxBufferBytes: number; signal?: AbortSignal }
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: opts.timeoutMs, maxBuffer: opts.maxBufferBytes, encoding: "utf8", signal: opts.signal as any },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(String(stdout ?? ""));
      }
    );
  });
}

async function discoverTmux(
  prefs: BriefPrefsLike,
  nowMs: number,
  redaction: { enabled: boolean; homeDir: string; repoDir: string }
): Promise<
  {
    name: string;
    createdAt: string;
    lastActivityAt: string;
    topCommands: string[];
    paths: string[];
    notes: string[];
  }[]
> {
  if (!prefs.tmuxEnabled) return [];

  const timeoutMs = 850;
  const { re: matchRe, normalized } = parseRegex(prefs.tmuxMatchRegex, "(?i)codex");
  const recentCutoffMs = nowMs - Math.max(1, prefs.tmuxRecentMinutes) * 60_000;

  let sessionsRaw = "";
  try {
    sessionsRaw = await execFileText(
      "tmux",
      ["list-sessions", "-F", "#{session_name}\t#{session_created}\t#{session_activity}"],
      { timeoutMs, maxBufferBytes: 512 * 1024 }
    );
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    if (typeof err?.stdout === "string" && err.stdout.trim() === "") return [];
    return [];
  }

  const sessions = sessionsRaw
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const [name, createdRaw, activityRaw] = line.split("\t");
      const createdS = createdRaw ? Number(createdRaw) : Number.NaN;
      const activityS = activityRaw ? Number(activityRaw) : Number.NaN;
      return {
        name: String(name || "").trim(),
        createdAtMs: Number.isFinite(createdS) ? createdS * 1000 : undefined,
        lastActivityAtMs: Number.isFinite(activityS) ? activityS * 1000 : undefined
      };
    })
    .filter((s) => s.name && matchRe.test(s.name));

  const filtered = sessions
    .filter((s) => {
      const stamp = s.lastActivityAtMs ?? s.createdAtMs ?? 0;
      return stamp >= recentCutoffMs;
    })
    .sort((a, b) => {
      const aAct = a.lastActivityAtMs ?? a.createdAtMs ?? 0;
      const bAct = b.lastActivityAtMs ?? b.createdAtMs ?? 0;
      if (aAct !== bAct) return bAct - aAct;
      return a.name.localeCompare(b.name);
    })
    .slice(0, Math.max(1, prefs.tmuxMaxSessions));

  const out: {
    name: string;
    createdAt: string;
    lastActivityAt: string;
    topCommands: string[];
    paths: string[];
    notes: string[];
  }[] = [];

  for (const session of filtered) {
    const topCommands: string[] = [];
    const paths: string[] = [];
    const notes: string[] = [];
    const safeNotes = [`match=${normalized}`];

    try {
      const windowsRaw = await execFileText(
        "tmux",
        ["list-windows", "-t", session.name, "-F", "#I\t#W\t#{window_active}\t#{window_last_activity}"],
        { timeoutMs, maxBufferBytes: 512 * 1024 }
      );
      const windows = windowsRaw
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [idxRaw, name, activeRaw, lastRaw] = l.split("\t");
          const idx = idxRaw ? Number(idxRaw) : Number.NaN;
          const lastS = lastRaw ? Number(lastRaw) : Number.NaN;
          return {
            idx: Number.isFinite(idx) ? idx : 0,
            name: String(name || "").trim(),
            active: activeRaw === "1",
            lastActivityAtMs: Number.isFinite(lastS) ? lastS * 1000 : undefined
          };
        });

      const activeWin = windows.find((w) => w.active) ?? windows[0];
      if (activeWin?.name) safeNotes.push(`active_window=${activeWin.name}`);

      // Inspect panes for top commands + paths.
      for (const win of windows.slice(0, 3)) {
        const target = `${session.name}:${win.idx}`;
        let panesRaw = "";
        try {
          panesRaw = await execFileText(
            "tmux",
            [
              "list-panes",
              "-t",
              target,
              "-F",
              "#{pane_active}\t#{pane_current_command}\t#{pane_title}\t#{pane_current_path}"
            ],
            { timeoutMs, maxBufferBytes: 512 * 1024 }
          );
        } catch {
          continue;
        }

        for (const line of panesRaw
          .split("\n")
          .map((l) => l.trimEnd())
          .filter(Boolean)) {
          const [activeRaw, cmdRaw, titleRaw, pathRaw] = line.split("\t");
          const cmd = String(cmdRaw || "").trim();
          const title = String(titleRaw || "").trim();
          const cwd = String(pathRaw || "").trim();
          if (cmd && cmd !== "tmux") topCommands.push(cmd);
          if (cwd) paths.push(sanitizeForPrompt(cwd, redaction, redaction.enabled));
          if (activeRaw === "1" && title) safeNotes.push(`active_pane=${title}`);
        }
      }
    } catch {
      // ignore window inspection failures
    }

    notes.push(...uniqKeepOrder(safeNotes, 6));

    out.push({
      name: session.name,
      createdAt: fmtIso(session.createdAtMs),
      lastActivityAt: fmtIso(session.lastActivityAtMs ?? session.createdAtMs),
      topCommands: uniqKeepOrder(topCommands, 5),
      paths: uniqKeepOrder(paths, 5),
      notes
    });
  }

  return out;
}

function readUtf8Snippet(absPath: string, maxChars: number): string {
  const limit = Math.max(200, Math.min(20_000, Math.trunc(maxChars)));
  try {
    const fd = fs.openSync(absPath, "r");
    try {
      const buf = Buffer.alloc(Math.min(256_000, limit * 4));
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      const text = buf.subarray(0, Math.max(0, bytesRead)).toString("utf8");
      return text.length > limit ? text.slice(0, limit) : text;
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  } catch {
    return "";
  }
}

function extractTaskMarkers(text: string): string[] {
  const lines = String(text || "")
    .split("\n")
    .map((l) => l.replace(/\r/g, "").trimEnd());
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of lines.slice(0, 220)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const candidates: string[] = [];
    if (/^(#{1,6})\s+\S+/.test(trimmed)) candidates.push(trimmed);
    if (/^[-*]\s+\[[ xX]\]\s+/.test(trimmed)) candidates.push(trimmed);
    if (/\b(TODO|NEXT|BLOCKED|DONE)\b/i.test(trimmed)) candidates.push(trimmed);
    for (const c of candidates) {
      const key = c.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
      if (out.length >= 12) return out;
    }
  }
  return out;
}

async function discoverTasks(
  prefs: BriefPrefsLike,
  codexExecCwd: string,
  nowMs: number,
  redaction: { enabled: boolean; homeDir: string; repoDir: string }
): Promise<
  {
    path: string;
    mtime: string;
    snippet: string;
    markers: string[];
  }[]
> {
  if (!prefs.tasksEnabled) return [];

  const folderRaw = String(prefs.tasksFolder || "").trim();
  const envFolder = String(process.env.CODEX_TASKS_DIR || "").trim();
  const tasksRoot = path.resolve(codexExecCwd, folderRaw || envFolder || "tasks");
  const include = (prefs.tasksIncludeGlobs ?? []).map(compileGlob).filter(Boolean) as any[];
  const exclude = (prefs.tasksExcludeGlobs ?? []).map(compileGlob).filter(Boolean) as any[];
  const cutoffMs = nowMs - Math.max(1, prefs.tasksRecentHours) * 60 * 60_000;

  type Entry = { rel: string; abs: string; mtimeMs: number; sizeBytes: number };
  const candidates: Entry[] = [];
  const MAX_SCAN = 20_000;

  const toForwardSlashes = (p: string) => p.replace(/\\/g, "/");

  const walk = (dirAbs: string) => {
    if (candidates.length >= MAX_SCAN) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (candidates.length >= MAX_SCAN) return;
      const name = entry.name || "";
      if (!name || name.startsWith(".")) {
        if (name === "." || name === "..") continue;
        // still allow ".git" exclusion via globs.
      }
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(dirAbs, name);
      const rel = toForwardSlashes(path.relative(tasksRoot, abs));
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
      if (matchesGlobs(rel, exclude)) continue;
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;

      const shouldInclude =
        include.length === 0 ? true : matchesGlobs(rel, include);
      if (!shouldInclude) continue;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.mtimeMs < cutoffMs) continue;
      candidates.push({ rel, abs, mtimeMs: stat.mtimeMs, sizeBytes: stat.size });
    }
  };

  try {
    if (fs.existsSync(tasksRoot)) walk(tasksRoot);
  } catch {
    // ignore
  }

  candidates.sort((a, b) => {
    if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return a.rel.localeCompare(b.rel);
  });

  const picked = candidates.slice(0, Math.max(1, prefs.tasksMaxFiles));
  const out: { path: string; mtime: string; snippet: string; markers: string[] }[] = [];
  for (const file of picked) {
    const ext = path.extname(file.abs).toLowerCase();
    let snippet = "";
    if (ext === ".json" && file.sizeBytes <= 200_000) {
      try {
        const raw = fs.readFileSync(file.abs, "utf8");
        const parsed = JSON.parse(raw);
        snippet = JSON.stringify(parsed, null, 2);
      } catch {
        snippet = readUtf8Snippet(file.abs, prefs.maxCharsPerFile);
      }
    } else {
      snippet = readUtf8Snippet(file.abs, prefs.maxCharsPerFile);
    }

    const sanitized = sanitizeForPrompt(snippet, redaction, redaction.enabled);
    out.push({
      path: sanitizeForPrompt(file.rel, redaction, false),
      mtime: fmtIso(file.mtimeMs),
      snippet: sanitized,
      markers: extractTaskMarkers(sanitized)
    });
  }
  return out;
}

function briefSchemaJson() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      overall_summary: { type: "string" },
      what_completed: { type: "array", items: { type: "string" }, maxItems: 12 },
      what_in_progress: { type: "array", items: { type: "string" }, maxItems: 12 },
      what_blocked: { type: "array", items: { type: "string" }, maxItems: 12 },
      next_actions: { type: "array", items: { type: "string" }, maxItems: 12 },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      followup_questions: { type: "array", items: { type: "string" }, maxItems: 8 },
      spoken_script: { type: "string" }
    },
    required: [
      "overall_summary",
      "what_completed",
      "what_in_progress",
      "what_blocked",
      "next_actions",
      "confidence",
      "followup_questions",
      "spoken_script"
    ]
  };
}

function extractOutputText(responseJson: any): string {
  const raw = responseJson;
  if (raw && typeof raw.output_text === "string") return raw.output_text;
  const output = Array.isArray(raw?.output) ? raw.output : [];
  const texts: string[] = [];
  for (const item of output) {
    if (!item || item.type !== "message") continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (part?.type === "output_text" && typeof part.text === "string") {
        texts.push(part.text);
      }
    }
  }
  return texts.join("\n").trim();
}

function normalizeReport(input: any): BriefReport | null {
  if (!input || typeof input !== "object") return null;
  const report = input as Partial<BriefReport>;
  const cleanList = (v: any) =>
    Array.isArray(v) ? v.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 24) : [];
  const confidence = typeof report.confidence === "number" && Number.isFinite(report.confidence) ? report.confidence : 0.35;
  return {
    overall_summary: String(report.overall_summary ?? "").trim(),
    what_completed: cleanList(report.what_completed),
    what_in_progress: cleanList(report.what_in_progress),
    what_blocked: cleanList(report.what_blocked),
    next_actions: cleanList(report.next_actions),
    confidence: Math.max(0, Math.min(1, confidence)),
    followup_questions: cleanList(report.followup_questions),
    spoken_script: String(report.spoken_script ?? "").trim()
  };
}

function fallbackReportFromText(text: string): BriefReport {
  const line = String(text || "").trim();
  const one = line.length > 500 ? `${line.slice(0, 500).trim()}…` : line;
  return {
    overall_summary: one || "No summary produced.",
    what_completed: [],
    what_in_progress: [],
    what_blocked: [],
    next_actions: [],
    confidence: 0.2,
    followup_questions: [],
    spoken_script: one || "No status available."
  };
}

function estimateResponsesCostCents(model: string, usage: OpenAiResponseUsage | null): { cents: number | null; note: string } {
  const inputTokens = usage?.input_tokens;
  const outputTokens = usage?.output_tokens;
  if (
    typeof inputTokens !== "number" ||
    typeof outputTokens !== "number" ||
    !Number.isFinite(inputTokens) ||
    !Number.isFinite(outputTokens)
  ) {
    return { cents: null, note: "No token usage returned by Responses API." };
  }

  const m = String(model || "").trim();
  const resolved = (() => {
    const table: Array<{ re: RegExp; key: string; inPer1M: number; outPer1M: number }> = [
      { re: /^gpt-5\.2-pro\b/i, key: "gpt-5.2-pro", inPer1M: 21.0, outPer1M: 168.0 },
      { re: /^gpt-5\.2\b/i, key: "gpt-5.2", inPer1M: 1.75, outPer1M: 14.0 },
      { re: /^gpt-5\.1\b/i, key: "gpt-5.1", inPer1M: 1.25, outPer1M: 10.0 },
      { re: /^gpt-5\b/i, key: "gpt-5", inPer1M: 1.25, outPer1M: 10.0 },
      { re: /^gpt-5-mini\b/i, key: "gpt-5-mini", inPer1M: 0.25, outPer1M: 2.0 },
      { re: /^gpt-5-nano\b/i, key: "gpt-5-nano", inPer1M: 0.05, outPer1M: 0.4 },

      { re: /^gpt-4\.1-mini\b/i, key: "gpt-4.1-mini", inPer1M: 0.4, outPer1M: 1.6 },
      { re: /^gpt-4\.1-nano\b/i, key: "gpt-4.1-nano", inPer1M: 0.1, outPer1M: 0.4 },
      { re: /^gpt-4\.1\b/i, key: "gpt-4.1", inPer1M: 2.0, outPer1M: 8.0 },

      { re: /^gpt-4o-mini\b/i, key: "gpt-4o-mini", inPer1M: 0.15, outPer1M: 0.6 },
      // Treat the May 2024 snapshot as standard gpt-4o pricing (per platform pricing).
      { re: /^gpt-4o-2024-05-13\b/i, key: "gpt-4o-2024-05-13", inPer1M: 2.5, outPer1M: 10.0 },
      { re: /^gpt-4o\b/i, key: "gpt-4o", inPer1M: 2.5, outPer1M: 10.0 },

      { re: /^gpt-5-pro\b/i, key: "gpt-5-pro", inPer1M: 15.0, outPer1M: 120.0 },
      { re: /^o4-mini\b/i, key: "o4-mini", inPer1M: 1.1, outPer1M: 4.4 },
      { re: /^o3\b/i, key: "o3", inPer1M: 2.0, outPer1M: 8.0 },
      { re: /^o1-pro\b/i, key: "o1-pro", inPer1M: 150.0, outPer1M: 600.0 },
      { re: /^o1\b/i, key: "o1", inPer1M: 15.0, outPer1M: 60.0 },

      { re: /^codex-mini-latest\b/i, key: "codex-mini-latest", inPer1M: 1.5, outPer1M: 6.0 },
      { re: /^gpt-4\b/i, key: "gpt-4", inPer1M: 30.0, outPer1M: 60.0 }
    ];

    for (const entry of table) {
      if (entry.re.test(m)) return { ...entry, assumed: false };
    }

    // Fallback assumption (keeps cost visible even for unknown models).
    return { key: "gpt-4o-mini", inPer1M: 0.15, outPer1M: 0.6, assumed: true };
  })();

  const usd = (inputTokens / 1_000_000) * resolved.inPer1M + (outputTokens / 1_000_000) * resolved.outPer1M;
  const cents = Math.round(usd * 100 * 100) / 100;
  const note = resolved.assumed
    ? `Assumed standard pricing for ${resolved.key}.`
    : `Standard pricing for ${resolved.key}.`;
  return { cents, note };
}

function estimateTtsCostCents(
  model: string,
  input: { audioSeconds: number; textChars: number }
): { cents: number | null; note: string } {
  const audioSeconds = input.audioSeconds;
  const textChars = input.textChars;
  if (!Number.isFinite(audioSeconds) || audioSeconds <= 0) {
    return { cents: null, note: "No audio duration available." };
  }
  const m = String(model || "").trim();
  const resolved = (() => {
    if (/^gpt-4o-mini-tts\b/i.test(m)) return { key: "gpt-4o-mini-tts", perMinuteUsd: 0.015, per1MCharsUsd: null, assumed: false };
    if (/^tts-1-hd\b/i.test(m)) return { key: "tts-1-hd", perMinuteUsd: null, per1MCharsUsd: 30, assumed: false };
    if (/^tts-1\b/i.test(m)) return { key: "tts-1", perMinuteUsd: null, per1MCharsUsd: 15, assumed: false };
    // Fallback assumption (keeps cost visible even for unknown TTS models).
    return { key: "gpt-4o-mini-tts", perMinuteUsd: 0.015, per1MCharsUsd: null, assumed: true };
  })();

  const usd =
    typeof resolved.perMinuteUsd === "number"
      ? (audioSeconds / 60) * resolved.perMinuteUsd
      : typeof resolved.per1MCharsUsd === "number" && Number.isFinite(textChars) && textChars > 0
        ? (textChars / 1_000_000) * resolved.per1MCharsUsd
        : 0;
  const cents = Math.round(usd * 100 * 100) / 100;
  const note = resolved.assumed
    ? `Assumed pricing for ${resolved.key}.`
    : resolved.per1MCharsUsd
      ? `Pricing for ${resolved.key} (per 1M characters).`
      : `Pricing for ${resolved.key}.`;
  return { cents, note };
}

function buildFallbackSpokenScript(report: BriefReport): string {
  const parts: string[] = [];
  if (report.overall_summary) parts.push(report.overall_summary);
  if (report.next_actions.length) {
    parts.push(`Next: ${report.next_actions.slice(0, 3).join("; ")}.`);
  }
  return parts.join(" ").trim();
}

function clampSpokenScript(raw: string, maxChars: number): string {
  const cleaned = redactSecrets(String(raw ?? "")).replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars).trim()}…`;
}

async function openAiResponsesJsonSchema(
  cfg: { apiKey: string; baseUrl: string; model: string; timeoutMs: number },
  input: any,
  signal?: AbortSignal
): Promise<{ json: any; usage: OpenAiResponseUsage | null; outputText: string; rawText: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1_000, cfg.timeoutMs));
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const response = await fetch(`${normalizeBaseUrl(cfg.baseUrl)}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(input),
      signal: controller.signal
    });

    const text = await response.text().catch(() => "");
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      const errText = typeof parsed?.error?.message === "string" ? parsed.error.message : text || response.statusText;
      throw new Error(`OpenAI Responses failed (${response.status}): ${errText}`);
    }

    const outputText = extractOutputText(parsed);
    const usage = parsed?.usage && typeof parsed.usage === "object" ? (parsed.usage as OpenAiResponseUsage) : null;
    return { json: parsed, usage, outputText, rawText: text };
  } finally {
    clearTimeout(timeout);
    if (signal) {
      try {
        signal.removeEventListener("abort", onAbort as any);
      } catch {
        // ignore
      }
    }
  }
}

async function openAiTtsPcm(
  cfg: { apiKey: string; baseUrl: string; model: string; voice: string; timeoutMs: number },
  text: string,
  signal?: AbortSignal
): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1_000, cfg.timeoutMs));
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const response = await fetch(`${normalizeBaseUrl(cfg.baseUrl)}/v1/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: cfg.model,
        voice: cfg.voice,
        input: text,
        response_format: "pcm"
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`OpenAI TTS failed (${response.status}): ${errText || response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } finally {
    clearTimeout(timeout);
    if (signal) {
      try {
        signal.removeEventListener("abort", onAbort as any);
      } catch {
        // ignore
      }
    }
  }
}

export async function runCodexBrief(opts: RunOptions): Promise<BriefRunResult> {
  const nowMs = opts.now.getTime();
  const homeDir = String(process.env.HOME || "").trim();
  const repoDir = path.resolve(opts.codexExecCwd);
  const redaction = { enabled: Boolean(opts.prefs.redactPaths), homeDir, repoDir };

  const prefs: BriefPrefsLike = {
    tmuxEnabled: clampBool(opts.prefs.tmuxEnabled, true),
    tmuxMatchRegex: clampString(opts.prefs.tmuxMatchRegex, 180, "(?i)codex"),
    tmuxMaxSessions: clampInt(opts.prefs.tmuxMaxSessions, { min: 1, max: 25, fallback: 8 }),
    tmuxRecentMinutes: clampInt(opts.prefs.tmuxRecentMinutes, { min: 10, max: 24 * 60, fallback: 360 }),
    tasksEnabled: clampBool(opts.prefs.tasksEnabled, true),
    tasksFolder: clampString(opts.prefs.tasksFolder, 4096, ""),
    tasksMaxFiles: clampInt(opts.prefs.tasksMaxFiles, { min: 1, max: 60, fallback: 12 }),
    tasksRecentHours: clampInt(opts.prefs.tasksRecentHours, { min: 1, max: 24 * 14, fallback: 72 }),
    tasksIncludeGlobs: Array.isArray(opts.prefs.tasksIncludeGlobs) ? opts.prefs.tasksIncludeGlobs.slice(0, 20) : [],
    tasksExcludeGlobs: Array.isArray(opts.prefs.tasksExcludeGlobs) ? opts.prefs.tasksExcludeGlobs.slice(0, 40) : [],
    openAiModel: clampString(opts.prefs.openAiModel, 120, "gpt-4o-mini"),
    ttsModel: clampString(opts.prefs.ttsModel, 120, "gpt-4o-mini-tts"),
    voice: clampString(opts.prefs.voice, 60, "alloy"),
    spokenSeconds: clampInt(opts.prefs.spokenSeconds, { min: 10, max: 180, fallback: 50 }),
    redactPaths: clampBool(opts.prefs.redactPaths, true),
    maxCharsPerFile: clampInt(opts.prefs.maxCharsPerFile, { min: 200, max: 20_000, fallback: 2000 })
  };

  const [tmuxSessions, tasks] = await Promise.all([
    discoverTmux(prefs, nowMs, redaction),
    discoverTasks(prefs, repoDir, nowMs, redaction)
  ]);

  const contextPayload = {
    now: opts.now.toISOString(),
    tmux: tmuxSessions,
    tasks,
    preferences: {
      spoken_seconds: prefs.spokenSeconds,
      redact_paths: prefs.redactPaths
    }
  };

  const requestId = crypto.randomBytes(8).toString("hex");
  const system = fs.readFileSync(
  path.join(__dirname, "../../../prompts/codex-brief.system.v3.txt"),
  "utf8"
);
  const user = fs
  .readFileSync(path.join(__dirname, "../../../prompts/codex-brief.user.v3.txt"), "utf8")
  .replace("{{CONTEXT_JSON}}", sanitizeForPrompt(JSON.stringify(contextPayload), redaction, prefs.redactPaths));

  const schema = briefSchemaJson();
  const input = {
    model: prefs.openAiModel,
    temperature: 0.2,
    max_output_tokens: 700,
    input: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "codex_brief",
        schema,
        strict: true
      }
    },
    metadata: { request_id: requestId }
  };

  let reportText = "";
  let usage: OpenAiResponseUsage | null = null;
  try {
    const result = await openAiResponsesJsonSchema(
      {
        apiKey: opts.openai.apiKey,
        baseUrl: opts.openai.baseUrl,
        model: prefs.openAiModel,
        timeoutMs: opts.openai.timeoutMs
      },
      input,
      opts.signal
    );
    usage = result.usage;
    reportText = result.outputText;
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    // Retry using JSON mode if Structured Outputs isn't supported by the chosen model.
    if (/json_schema|response_format|structured/i.test(message)) {
      const fallbackInput = {
        ...input,
        text: { format: { type: "json_object" } }
      };
      const retried = await openAiResponsesJsonSchema(
        {
          apiKey: opts.openai.apiKey,
          baseUrl: opts.openai.baseUrl,
          model: prefs.openAiModel,
          timeoutMs: opts.openai.timeoutMs
        },
        fallbackInput,
        opts.signal
      );
      usage = retried.usage;
      reportText = retried.outputText;
    } else {
      throw err;
    }
  }

  let reportJsonText = reportText;
  let report: BriefReport | null = null;
  try {
    report = normalizeReport(JSON.parse(reportText));
  } catch {
    report = null;
  }
  if (!report) {
    report = fallbackReportFromText(reportText);
    reportJsonText = JSON.stringify(report, null, 2);
  }

  const spoken =
    clampSpokenScript(report.spoken_script, 1200) ||
    clampSpokenScript(buildFallbackSpokenScript(report), 1200) ||
    "No status available.";

  const pcm = await openAiTtsPcm(
    {
      apiKey: opts.tts.apiKey,
      baseUrl: opts.tts.baseUrl,
      model: prefs.ttsModel,
      voice: prefs.voice,
      timeoutMs: Math.max(5_000, opts.openai.timeoutMs)
    },
    spoken,
    opts.signal
  );

  const sampleRate = 24_000;
  const seconds = pcm.length > 0 ? pcm.length / (2 * sampleRate) : 0;

  const responsesCost = estimateResponsesCostCents(prefs.openAiModel, usage);
  const ttsCost = estimateTtsCostCents(prefs.ttsModel, { audioSeconds: seconds, textChars: spoken.length });
  const totalCents =
    typeof responsesCost.cents === "number" && typeof ttsCost.cents === "number"
      ? Math.round((responsesCost.cents + ttsCost.cents) * 100) / 100
      : typeof responsesCost.cents === "number"
        ? responsesCost.cents
        : typeof ttsCost.cents === "number"
          ? ttsCost.cents
          : null;

  const noteParts = [
    responsesCost.note,
    ttsCost.note,
    "Prices are hardcoded and may drift from current OpenAI pricing."
  ].filter(Boolean);

  return {
    report,
    reportJsonText,
    usage: {
      inputTokens: typeof usage?.input_tokens === "number" ? usage.input_tokens : null,
      outputTokens: typeof usage?.output_tokens === "number" ? usage.output_tokens : null,
      totalTokens: typeof usage?.total_tokens === "number" ? usage.total_tokens : null
    },
    cost: {
      currency: "USD",
      totalCents,
      responsesCents: responsesCost.cents,
      ttsCents: ttsCost.cents,
      note: noteParts.join(" ")
    },
    audio: {
      format: "pcm16",
      sampleRate,
      channels: 1,
      seconds: Math.round(seconds * 100) / 100,
      bytes: pcm.length,
      base64: pcm.toString("base64")
    }
  };
}
