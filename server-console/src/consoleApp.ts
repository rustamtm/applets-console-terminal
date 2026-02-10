import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { promisify } from "node:util";
import express from "express";
import MarkdownIt from "markdown-it";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { loadConfig, type ConsoleConfig } from "./config.js";
import { createAuditLogger } from "./logging/audit.js";
import { makeCloudflareAccessVerifier, makeNoAuthVerifier, type AccessVerifier } from "./auth/access.js";
import { requireAppToken } from "./auth/appToken.js";
import { isBasicAuthConfigured, verifyBasicAuth } from "./auth/basicAuth.js";
import { UserPrefsStore, type AudioPrefs, type BriefPrefs } from "./prefs/userPrefs.js";
import { SessionManager } from "./sessions/sessionManager.js";
import { TtsManager } from "./tts/ttsManager.js";
import { OpenAiTtsEngine } from "./tts/engines/openai.js";
import { PiperTtsEngine } from "./tts/engines/piper.js";
import { SttManager } from "./stt/sttManager.js";
import { WhisperCppEngine } from "./stt/engines/whisperCpp.js";
import { OpenAiSttEngine } from "./stt/engines/openai.js";
import { suggestSessionName } from "./ai/sessionNamer.js";
import { captureTmuxTail } from "./ai/tmuxCapture.js";
import { DEFAULT_TTS_SAMPLE_RATE, type TtsEngine, type TtsSynthesisConfig } from "./tts/ttsEngine.js";
import { pcm16ToWav } from "./tts/wav.js";
import type { SttEngine } from "./stt/sttEngine.js";
import { ChatSessionManager } from "./chat/chatSessionManager.js";
import { runCodexBrief } from "./brief/briefRunner.js";

export type ConsoleAppOptions = {
  basePath?: string;
  env?: NodeJS.ProcessEnv;
  uiDist?: string;
};

export type ConsoleApp = {
  router: express.Router;
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  shutdown: () => void;
  config: ConsoleConfig;
  basePath: string;
};

function normalizeBasePath(raw?: string): string {
  if (!raw) return "";
  let base = raw.trim();
  if (!base || base === "/") return "";
  if (!base.startsWith("/")) base = `/${base}`;
  if (base.endsWith("/")) base = base.slice(0, -1);
  return base;
}

function withBase(base: string, suffix: string): string {
  return base ? `${base}${suffix}` : suffix;
}

function withAttachToken(wsUrl: string, attachToken: string): string {
  if (!attachToken) return wsUrl;
  try {
    if (wsUrl.startsWith("/")) {
      const url = new URL(wsUrl, "http://localhost");
      url.searchParams.set("attachToken", attachToken);
      return `${url.pathname}${url.search}`;
    }
    const url = new URL(wsUrl);
    url.searchParams.set("attachToken", attachToken);
    return url.toString();
  } catch {
    return wsUrl;
  }
}

export function createConsoleApp(opts: ConsoleAppOptions = {}): ConsoleApp {
  const env = opts.env ?? process.env;
  const config = loadConfig(env);
  const basePath = normalizeBasePath(opts.basePath);
  const wsOrigin = (env.CONSOLE_WS_ORIGIN || "").trim().replace(/\/+$/, "");
  const debugWs = (() => {
    const raw = (env.CONSOLE_DEBUG_WS || "").trim().toLowerCase();
    return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
  })();
  const audit = createAuditLogger(config.auditLogPath);
  const prefsStore = new UserPrefsStore(config.prefsPath);
  const uploadDir = path.resolve(env.CONSOLE_UPLOAD_DIR || "uploads/console");
  const codexExecCwd = config.codexExecCwd ? path.resolve(config.codexExecCwd) : process.cwd();
  const execFileAsync = promisify(execFile);
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const parseCookieNames = (header?: string): string[] => {
    if (!header) return [];
    return header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => part.split("=")[0]?.trim())
      .filter(Boolean);
  };

  const accessVerifier: AccessVerifier =
    config.authMode === "cloudflare"
      ? makeCloudflareAccessVerifier(config.cfAccessIssuer!, config.cfAccessAud!)
      : makeNoAuthVerifier();

  const requireBasicAuth = isBasicAuthConfigured(config.basicAuthUser, config.basicAuthPass);

  type AiNameEntry = { at: number; name: string };
  const aiNameHistory = new Map<string, AiNameEntry[]>();
  const recordAiName = (userId: string, name: string) => {
    const trimmed = String(name ?? "").trim();
    if (!trimmed) return;
    const prev = aiNameHistory.get(userId) ?? [];
    const next: AiNameEntry[] = [{ at: Date.now(), name: trimmed }, ...prev];
    // Keep most recent entries and avoid unbounded growth.
    aiNameHistory.set(userId, next.slice(0, 30));
  };
  const recentAiNames = (userId: string, limit = 8): string[] => {
    const entries = aiNameHistory.get(userId) ?? [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      const n = String(entry?.name ?? "").trim();
      if (!n || seen.has(n)) continue;
      seen.add(n);
      out.push(n);
      if (out.length >= limit) break;
    }
    return out;
  };

  const router = express.Router();
  router.use(express.json({ limit: "2mb" }));
  router.use((req, res, next) => {
    if (!req.path.startsWith("/api/sessions")) return next();
    const start = Date.now();
    res.on("finish", () => {
      if (res.statusCode < 400) return;
      const err = (res.locals as any)?.apiError;
      const ms = Date.now() - start;
      const suffix = err ? ` error="${err}"` : "";
      console.warn(`[api] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)${suffix}`);
    });
    next();
  });

  const ensureUploadDir = () => {
    fs.mkdirSync(uploadDir, { recursive: true });
  };

  const sanitizeFilename = (name: string) =>
    name
      .replace(/[/\\]+/g, "_")
      .replace(/[^\w.\-]+/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 180);

  const isAllowedImageExt = (ext: string) => {
    const allowed = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg", ".bmp", ".heic", ".heif"];
    return allowed.includes(ext.toLowerCase());
  };

  const extFromContentType = (contentType: string) => {
    const ct = contentType.toLowerCase();
    if (ct.includes("image/jpeg")) return ".jpg";
    if (ct.includes("image/png")) return ".png";
    if (ct.includes("image/webp")) return ".webp";
    if (ct.includes("image/gif")) return ".gif";
    if (ct.includes("image/svg+xml")) return ".svg";
    if (ct.includes("image/bmp")) return ".bmp";
    if (ct.includes("image/heic")) return ".heic";
    if (ct.includes("image/heif")) return ".heif";
    return "";
  };

  const normalizeCodexImages = (inputs?: string[]) => {
    if (!inputs || inputs.length === 0) return [];
    const unique = Array.from(new Set(inputs));
    const out: string[] = [];
    for (const raw of unique) {
      if (!raw) continue;
      const resolved = path.resolve(raw);
      const relative = path.relative(uploadDir, resolved);
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      if (!isAllowedImageExt(path.extname(resolved))) continue;
      try {
        const stat = fs.statSync(resolved);
        if (!stat.isFile()) continue;
      } catch {
        continue;
      }
      out.push(resolved);
    }
    return out;
  };

  const sanitizePrefix = (raw: string) => raw.replace(/[^A-Za-z0-9._-]/g, "") || "console";
  const tmuxPrefixBase = sanitizePrefix(config.tmuxPrefix);
  const tmuxPrefixForUser = (userId: string) => {
    const encoded = Buffer.from(userId).toString("base64url").replace(/=+$/g, "");
    return `${tmuxPrefixBase}-${encoded}-`;
  };

  const buildWsUrl = (path: string, attachToken: string) => {
    const relative = withAttachToken(withBase(basePath, path), attachToken);
    if (!wsOrigin) return relative;
    try {
      return new URL(relative, wsOrigin).toString();
    } catch {
      return relative;
    }
  };
  const isValidTmuxName = (name: string) => /^[A-Za-z0-9._-]+$/.test(name);
  const makeTmuxName = (userId: string) => `${tmuxPrefixForUser(userId)}${crypto.randomBytes(4).toString("hex")}`;
  const tmuxAllowsAllSessions = config.tmuxSessionScope === "all";
  const isAllowedTmuxNameForUser = (userId: string, name: string) => {
    if (!isValidTmuxName(name)) return false;
    if (tmuxAllowsAllSessions) return true;
    const prefix = tmuxPrefixForUser(userId);
    return name.startsWith(prefix);
  };
  const isManagedTmuxSessionName = (name: string) => {
    if (!name) return false;
    return (
      name.startsWith(`${tmuxPrefixBase}-`) ||
      name.startsWith("console-") ||
      name.startsWith("root-console-") ||
      name.startsWith("applets_")
    );
  };

  const enforceManagedTmuxMouse = async (name: string) => {
    const desired = config.tmuxManagedMouse;
    if (desired === "inherit") return;
    if (!isManagedTmuxSessionName(name)) return;

    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        await execFileAsync("tmux", ["set-option", "-t", name, "mouse", desired]);
        return;
      } catch (err: any) {
        if (err?.code === "ENOENT") return;
        const stderr = typeof err?.stderr === "string" ? err.stderr : "";
        if (/can't find session|no such session/i.test(stderr)) {
          await sleep(30 * (attempt + 1));
          continue;
        }
        return;
      }
    }
  };

  const isMacos = process.platform === "darwin";
  const sanitizeAppleScriptAppName = (raw?: string) => {
    const candidate = String(raw ?? "").trim();
    if (!candidate) return "Terminal";
    // Avoid AppleScript injection via env config.
    if (!/^[A-Za-z0-9 ._-]{1,80}$/.test(candidate)) return "Terminal";
    return candidate;
  };
  const macosTerminalApp = sanitizeAppleScriptAppName(config.macosTerminalApp);

  const launchMacosTerminalForTmux = async (tmuxName: string) => {
    if (!config.enableMacosTerminalLaunch) throw new Error("terminal launch disabled");
    if (!isMacos) throw new Error("terminal launch unsupported");
    if (!isValidTmuxName(tmuxName)) throw new Error("invalid tmux session");

    const tmuxCmd = `tmux new-session -A -s ${tmuxName}`;
    const args = [
      "-e",
      `tell application "${macosTerminalApp}"`,
      "-e",
      "activate",
      "-e",
      `do script ${JSON.stringify(tmuxCmd)}`,
      "-e",
      "end tell"
    ];
    await execFileAsync("osascript", args);
  };

  const isHiddenTmuxSessionName = (name: string) => {
    if (!name) return false;
    // Hide applets webapp orchestration sessions from the Console Terminal UI.
    if (name.startsWith("applets_")) return true;
    // Hide the configured stack session name even if it doesn't follow the prefix convention.
    if (name === config.appletsStackTmuxSession) return true;
    return false;
  };

  const listTmuxSessions = async (prefix?: string) => {
    try {
      const { stdout } = await execFileAsync("tmux", [
        "list-sessions",
        "-F",
        "#{session_name}\t#{session_created}\t#{session_activity}\t#{session_attached}\t#{session_windows}"
      ]);
      const sessions = stdout
        .split("\n")
        .map((line) => line.trimEnd())
        .filter(Boolean)
        .map((line) => {
          const [name, createdRaw, activityRaw, attachedRaw, windowsRaw] = line.split("\t");
          const createdS = createdRaw ? Number(createdRaw) : Number.NaN;
          const activityS = activityRaw ? Number(activityRaw) : Number.NaN;
          const attachedCount = attachedRaw ? Number(attachedRaw) : 0;
          const windows = windowsRaw ? Number(windowsRaw) : Number.NaN;
          const attachedCountSafe = Number.isFinite(attachedCount) ? attachedCount : 0;
          return {
            name,
            createdAt: Number.isFinite(createdS) ? createdS * 1000 : undefined,
            lastActivityAt: Number.isFinite(activityS) ? activityS * 1000 : undefined,
            attached: attachedCountSafe > 0,
            attachedCount: attachedCountSafe,
            windows: Number.isFinite(windows) ? windows : undefined
          };
        });

      const visible = sessions.filter((s) => !isHiddenTmuxSessionName(s.name));
      const filtered = prefix ? visible.filter((s) => s.name.startsWith(prefix)) : visible;
      filtered.sort((a, b) => {
        const aAttached = a.attachedCount ?? (a.attached ? 1 : 0);
        const bAttached = b.attachedCount ?? (b.attached ? 1 : 0);
        if (aAttached !== bAttached) return bAttached - aAttached;
        const aActivity = a.lastActivityAt ?? 0;
        const bActivity = b.lastActivityAt ?? 0;
        if (aActivity !== bActivity) return bActivity - aActivity;
        const aCreated = a.createdAt ?? 0;
        const bCreated = b.createdAt ?? 0;
        if (aCreated !== bCreated) return bCreated - aCreated;
        return a.name.localeCompare(b.name);
      });
      return filtered;
    } catch (err: any) {
      if (err?.code === "ENOENT") return [];
      if (typeof err?.stdout === "string" && err.stdout.trim() === "") return [];
      return [];
    }
  };

  router.get("/healthz", (_req, res) => res.json({ ok: true }));

  // Optional basic auth (protects UI + API).
  router.use((req, res, next) => {
    if (!requireBasicAuth) return next();
    try {
      verifyBasicAuth(req.headers, config.basicAuthUser!, config.basicAuthPass!);
      next();
    } catch {
      (res.locals as any).apiError = "basic_auth_required";
      res.setHeader("WWW-Authenticate", "Basic realm=\"console\"");
      res.status(401).send("Unauthorized");
    }
  });

  // Require Cloudflare Access (or dev no-auth) for everything else.
  router.use(async (req, res, next) => {
    try {
      const user = await accessVerifier(req.headers);
      (req as any).user = user;
      audit.log({ type: "auth_ok", at: new Date().toISOString(), userId: user.userId, email: user.email });
      next();
    } catch (err) {
      const message = err instanceof Error ? err.message : "auth error";
      audit.log({ type: "auth_fail", at: new Date().toISOString(), reason: message });
      (res.locals as any).apiError = "unauthorized";
      res.status(401).json({ error: "unauthorized" });
    }
  });

  // API app-token (optional).
  router.use("/api", (req, res, next) => {
    try {
      if (config.requireAppToken || config.appToken) requireAppToken(req, config.appToken);
      next();
    } catch (err) {
      const status = (err as any)?.statusCode ?? 401;
      (res.locals as any).apiError = "unauthorized";
      res.status(status).json({ error: "unauthorized" });
    }
  });

  router.get("/api/debug/access", (req, res) => {
    const headers = req.headers;
    const cookieHeader = typeof headers.cookie === "string" ? headers.cookie : "";
    const cookieNames = parseCookieNames(cookieHeader);
    const hasCfAuthorization = cookieNames.some((name) => name.toLowerCase() === "cf_authorization");
    res.json({
      note: "Header and cookie values are redacted; presence only.",
      request: {
        method: req.method,
        path: req.path
      },
      headers: {
        hasCfAccessJwtAssertion: typeof headers["cf-access-jwt-assertion"] === "string",
        hasCfAccessUserId: typeof headers["cf-access-authenticated-user-id"] === "string",
        hasCfAccessEmail: typeof headers["cf-access-authenticated-user-email"] === "string",
        hasCfAccessClientId: typeof headers["cf-access-client-id"] === "string",
        hasCfAccessClientSecret: typeof headers["cf-access-client-secret"] === "string",
        hasAuthorization: typeof headers.authorization === "string",
        hasCookie: Boolean(cookieHeader)
      },
      cookies: {
        names: cookieNames,
        hasCfAuthorization
      },
      cf: {
        ray: headers["cf-ray"],
        connectingIp: headers["cf-connecting-ip"],
        country: headers["cf-ipcountry"],
        visitor: headers["cf-visitor"]
      }
    });
  });

  const ttsEngines: Record<string, TtsEngine> = {};
  if (config.ttsOpenAiApiKey) {
    ttsEngines.openai = new OpenAiTtsEngine({
      apiKey: config.ttsOpenAiApiKey,
      baseUrl: config.ttsOpenAiBaseUrl
    });
  }
  if (config.ttsPiperBin && config.ttsPiperModel) {
    ttsEngines.piper = new PiperTtsEngine({
      binPath: config.ttsPiperBin,
      modelPath: config.ttsPiperModel,
      configPath: config.ttsPiperConfig
    });
  }
  const ttsManager = new TtsManager(
    {
      enabled: config.ttsEnabled,
      defaultEngine: config.ttsEngine,
      model: config.ttsModel,
      voice: config.ttsVoice,
      maxChunkChars: config.ttsMaxChunkChars,
      maxQueueDepth: config.ttsMaxQueueDepth
    },
    ttsEngines,
    audit.log
  );

  const TtsSynthesizeSchema = z
    .object({
      text: z.string().trim().min(1).max(800),
      engine: z.enum(["openai", "piper"]).optional(),
      model: z.string().trim().min(1).max(120).optional(),
      voice: z.string().trim().min(1).max(80).optional()
    })
    .strict();

  router.post("/api/tts/synthesize", async (req, res) => {
    const requestId =
      typeof crypto.randomUUID === "function" ? crypto.randomUUID() : crypto.randomBytes(12).toString("hex");
    const userId = (req as any)?.user?.userId;
    const startedAt = Date.now();
    res.setHeader("X-Console-TTS-Request-Id", requestId);

    if (!config.ttsEnabled) {
      res.status(404).json({ error: "tts_disabled", requestId });
      return;
    }

    const parsed = TtsSynthesizeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", requestId });
      return;
    }

    const { text } = parsed.data;
    const requestedEngine = String(parsed.data.engine ?? config.ttsEngine);
    const availableEngines = Object.keys(ttsEngines);
    let engineName = requestedEngine;
    let engine = ttsEngines[engineName];
    if (!engine) {
      const fallbackName = availableEngines[0];
      if (parsed.data.engine || !fallbackName) {
        res
          .status(400)
          .json({ error: "tts_engine_unavailable", requestId, engine: requestedEngine, availableEngines });
        return;
      }
      engineName = fallbackName;
      engine = ttsEngines[engineName];
    }

    const cfg: TtsSynthesisConfig = {
      model: parsed.data.model ?? config.ttsModel,
      voice: parsed.data.voice ?? config.ttsVoice,
      format: "pcm"
    };
    const sampleRate = (() => {
      try {
        return engine.getSampleRate?.(cfg) ?? DEFAULT_TTS_SAMPLE_RATE;
      } catch {
        return DEFAULT_TTS_SAMPLE_RATE;
      }
    })();

    console.log("[tts] synthesize start", {
      requestId,
      userId,
      engine: engineName,
      voice: cfg.voice || "",
      model: cfg.model || "",
      textChars: text.length
    });

    const controller = new AbortController();
    const timeoutMs = 25_000;
    const maxPcmBytes = 8 * 1024 * 1024;
    let tooLarge = false;

    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      await engine.synthesize(
        text,
        cfg,
        (chunk) => {
          if (controller.signal.aborted) return;
          chunks.push(chunk);
          total += chunk.length;
          if (total > maxPcmBytes) {
            tooLarge = true;
            controller.abort();
          }
        },
        controller.signal
      );
    } catch (err: any) {
      if (controller.signal.aborted && tooLarge) {
        console.warn("[tts] synthesize failed", {
          requestId,
          userId,
          engine: engineName,
          why: "audio_too_large",
          pcmBytes: total,
          tookMs: Date.now() - startedAt
        });
        res.status(413).json({ error: "audio_too_large", requestId });
        return;
      }
      if (controller.signal.aborted) {
        console.warn("[tts] synthesize failed", {
          requestId,
          userId,
          engine: engineName,
          why: "timeout",
          pcmBytes: total,
          tookMs: Date.now() - startedAt
        });
        res.status(504).json({ error: "tts_timeout", requestId });
        return;
      }
      console.warn("[tts] synthesize failed", {
        requestId,
        userId,
        engine: engineName,
        why: "tts_failed",
        error: err instanceof Error ? err.message : String(err),
        tookMs: Date.now() - startedAt
      });
      res.status(500).json({ error: "tts_failed", requestId });
      return;
    } finally {
      clearTimeout(timer);
    }

    if (controller.signal.aborted && tooLarge) {
      console.warn("[tts] synthesize aborted", {
        requestId,
        userId,
        engine: engineName,
        why: "audio_too_large",
        pcmBytes: total,
        tookMs: Date.now() - startedAt
      });
      res.status(413).json({ error: "audio_too_large", requestId });
      return;
    }
    if (controller.signal.aborted) {
      console.warn("[tts] synthesize aborted", {
        requestId,
        userId,
        engine: engineName,
        why: "timeout",
        pcmBytes: total,
        tookMs: Date.now() - startedAt
      });
      res.status(504).json({ error: "tts_timeout", requestId });
      return;
    }

    const pcm = Buffer.concat(chunks);
    const durationMs = sampleRate > 0 ? Math.round((pcm.length / 2 / sampleRate) * 1000) : 0;
    const wav = pcm16ToWav(pcm, sampleRate, 1);

    console.log("[tts] synthesize done", {
      requestId,
      userId,
      engine: engineName,
      voice: cfg.voice || "",
      model: cfg.model || "",
      textChars: text.length,
      sampleRate,
      durationMs,
      pcmBytes: pcm.length,
      wavBytes: wav.length,
      tookMs: Date.now() - startedAt
    });
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Console-TTS-Engine", engineName);
    res.setHeader("X-Console-TTS-Sample-Rate", String(sampleRate));
    res.setHeader("X-Console-TTS-Duration-Ms", String(durationMs));
    res.send(wav);
  });

  // Chat output forwarding reference (set after chatManager is created)
  let chatOutputHandler: ((sessionId: string, data: string) => void) | null = null;
  let chatExitHandler: ((sessionId: string, exitCode: number | null, signal: number | null) => void) | null = null;
  let chatCloseHandler: ((sessionId: string) => void) | null = null;

  const manager = new SessionManager({
    modeConfig: {
      enableNode: config.enableNode,
      enableShell: config.enableShell,
      enableReadonlyTail: config.enableReadonlyTail,
      enableTmux: config.enableTmux,
      defaultShell: config.defaultShell,
      defaultCwd: config.defaultCwd
    },
    tmuxPrefix: config.tmuxPrefix,
    attachTokenTtlMs: config.attachTokenTtlMs,
    detachGraceMs: config.detachGraceMs,
    idleTimeoutMs: config.idleTimeoutMs,
    maxSessionsPerUser: config.maxSessionsPerUser,
    onOutput: (session, data) => {
      ttsManager.handleOutput(session.id, data);
      // Forward to chat manager if available
      chatOutputHandler?.(session.id, data);
    },
    onExit: (sessionId, exitCode, signal) => {
      chatExitHandler?.(sessionId, exitCode, signal);
    },
    onSessionClosed: (sessionId) => {
      ttsManager.closeSession(sessionId);
      chatCloseHandler?.(sessionId);
    }
  });

  const sttEngines: Record<string, SttEngine> = {
    cpp: new WhisperCppEngine({
      binPath: config.sttWhisperCppBin,
      modelPath: config.sttWhisperCppModel
    })
  };
  if (config.sttOpenAiApiKey) {
    sttEngines.openai = new OpenAiSttEngine({
      apiKey: config.sttOpenAiApiKey,
      baseUrl: config.sttOpenAiBaseUrl
    });
  }
  const sttManager = new SttManager(
    {
      enabled: config.sttEnabled,
      defaultEngine: config.sttEngine,
      model: config.sttModel,
      lang: config.sttLang,
      minAudioBytes: config.sttMinAudioBytes,
      energyThreshold: config.sttEnergyThreshold,
      windowBytes: config.sttWindowBytes,
      overlapBytes: config.sttOverlapBytes,
      sampleRate: 16_000,
      finalizeMs: config.sttFinalizeMs,
      debug: config.sttDebug
    },
    sttEngines,
    (sessionId, text) => manager.write(sessionId, Buffer.from(text)),
    audit.log
  );

	  const defaultAudioPrefs: Partial<AudioPrefs> = {
	    ttsEnabled: config.ttsEnabled,
	    ttsEngine: config.ttsEngine,
	    ttsSource: "codex",
	    ttsVoice: config.ttsVoice,
	    ttsVolume: 1,
	    ttsRate: 1,
	    ttsFallbackEnabled: true,
	    sttEnabled: config.sttEnabled,
	    sttEngine: config.sttEngine,
	    sttModel: config.sttModel,
	    sttLang: config.sttLang
	  };

	  const defaultBriefPrefs: Partial<BriefPrefs> = {
	    tmuxEnabled: true,
	    tmuxMatchRegex: "(?i)codex",
	    tmuxMaxSessions: 8,
	    tmuxRecentMinutes: 360,
	    tasksEnabled: true,
	    // Empty means "auto": prefer CODEX_TASKS_DIR if set, otherwise <codexExecCwd>/tasks.
	    tasksFolder: "",
	    tasksMaxFiles: 12,
	    tasksRecentHours: 72,
	    tasksIncludeGlobs: ["*.md", "*.txt", "*.json"],
	    tasksExcludeGlobs: ["**/archive/**", "**/.git/**"],
	    openAiModel: config.aiModel,
	    ttsModel: config.ttsModel,
	    voice: config.ttsVoice,
	    spokenSeconds: 50,
	    redactPaths: true,
	    maxCharsPerFile: 2000
	  };

  router.get("/api/me", (req, res) => {
    const user = (req as any).user;
    res.json({ userId: user.userId, email: user.email });
  });

  router.get("/api/prefs/audio", (req, res) => {
    const user = (req as any).user;
    const audio = prefsStore.getAudio(user.userId);
    res.json({ audio: audio ?? { ...defaultAudioPrefs } });
  });

	  router.post("/api/prefs/audio", (req, res) => {
	    const user = (req as any).user;
	    const patch = AudioPrefsSchema.parse(req.body ?? {});
	    const audio = prefsStore.updateAudio(user.userId, patch);
	    res.json({ audio });
	  });

	  router.get("/api/prefs/brief", (req, res) => {
	    const user = (req as any).user;
	    const brief = prefsStore.getBrief(user.userId);
	    res.json({ brief: brief ?? { ...defaultBriefPrefs } });
	  });

	  router.post("/api/prefs/brief", (req, res) => {
	    const user = (req as any).user;
	    const patch = BriefPrefsSchema.parse(req.body ?? {});
	    const brief = prefsStore.updateBrief(user.userId, patch);
	    res.json({ brief });
	  });

	  router.post("/api/brief/run", async (req, res) => {
	    const user = (req as any).user as { userId: string; email?: string };
	    const body = BriefRunBodySchema.parse(req.body ?? {});
	    const stored = prefsStore.getBrief(user.userId) ?? {};
	    const prefs = { ...defaultBriefPrefs, ...stored, ...(body.prefs ?? {}) } as any;

	    const openAiKey = String(config.aiOpenAiApiKey || config.ttsOpenAiApiKey || "").trim();
	    const ttsKey = String(config.ttsOpenAiApiKey || openAiKey || "").trim();
	    if (!openAiKey || !ttsKey) {
	      res.status(500).json({ error: "openai_key_missing" });
	      return;
	    }

	    const controller = new AbortController();
	    req.on("close", () => controller.abort());
	    try {
	      const result = await runCodexBrief({
	        userId: user.userId,
	        now: new Date(),
	        codexExecCwd,
	        prefs,
	        openai: {
	          apiKey: openAiKey,
	          baseUrl: config.aiOpenAiBaseUrl,
	          timeoutMs: Math.max(12_000, config.aiTimeoutMs)
	        },
	        tts: {
	          apiKey: ttsKey,
	          baseUrl: config.ttsOpenAiBaseUrl
	        },
	        signal: controller.signal
	      });
	      res.json({ ok: true, ...result });
	    } catch (err: any) {
	      const message = err instanceof Error ? err.message : String(err);
	      res.status(500).json({ error: "brief_failed", message });
	    }
	  });

  router.get("/api/codex/status", (_req, res) => {
    res.json({
      enabled: config.enableCodexExec,
      allowFullAuto: config.codexExecAllowFullAuto,
      allowDanger: config.codexExecAllowDanger
    });
  });

  router.get("/api/applets/status", (_req, res) => {
    const cwd = config.appletsStackCwd ? path.resolve(config.appletsStackCwd) : process.cwd();
    res.json({
      restartEnabled: config.enableAppletsStackRestart,
      keepTunnel: config.appletsStackKeepTunnel,
      method: "spawn",
      logPath: path.join(cwd, "logs", "start-stack.log")
    });
  });

  router.post("/api/applets/restart", async (req, res) => {
    if (!config.enableAppletsStackRestart) {
      res.status(404).json({ error: "applets_restart_disabled" });
      return;
    }

    const user = (req as any).user as { userId: string; email?: string };
    const cwd = config.appletsStackCwd ? path.resolve(config.appletsStackCwd) : process.cwd();
    const scriptPath = path.join(cwd, "start-stack.sh");
    if (!fs.existsSync(scriptPath)) {
      res.status(500).json({ error: "start_stack_missing" });
      return;
    }

    try {
      // Best-effort cleanup: if a previous tmux-backed stack session exists, remove it so it
      // doesn't clutter the persistent tmux session list.
      const tmuxSession = config.appletsStackTmuxSession;
      if (tmuxSession && tmuxSession.startsWith("applets_")) {
        try {
          await execFileAsync("tmux", ["kill-session", "-t", tmuxSession]);
        } catch (err: any) {
          if (err?.code !== "ENOENT") {
            const stderr = typeof err?.stderr === "string" ? err.stderr : "";
            if (!/can't find session|no such session/i.test(stderr)) {
              console.warn("applets_restart_tmux_cleanup_failed", {
                tmuxSession,
                error: String(err?.message ?? err)
              });
            }
          }
        }
      }

      const logsDir = path.join(cwd, "logs");
      fs.mkdirSync(logsDir, { recursive: true });
      const logPath = path.join(logsDir, "start-stack.log");
      const pidPath = path.join(logsDir, "start-stack.pid");
      const args = [scriptPath, ...(config.appletsStackKeepTunnel ? ["--keep-tunnel"] : [])];

      const logFd = fs.openSync(logPath, "a");
      let pid: number | undefined;
      try {
        const child = spawn("/bin/bash", args, {
          cwd,
          env: process.env,
          detached: true,
          stdio: ["ignore", logFd, logFd]
        });
        pid = child.pid ?? undefined;
        child.unref();
      } finally {
        try {
          fs.closeSync(logFd);
        } catch {
          // ignore
        }
      }

      if (!pid) {
        res.status(500).json({ error: "start_stack_spawn_failed" });
        return;
      }

      try {
        fs.writeFileSync(pidPath, String(pid), "utf8");
      } catch {
        // ignore best-effort pidfile write failures
      }

      audit.log({
        type: "applets_restart",
        at: new Date().toISOString(),
        userId: user.userId,
        email: user.email,
        method: "spawn",
        pid,
        logPath
      });

      res.json({ ok: true, pid, logPath });
    } catch (err: any) {
      console.warn("applets_restart_spawn_failed", { error: String(err?.message ?? err) });
      res.status(500).json({ error: "start_stack_spawn_failed" });
    }
  });

  const killTmuxSessionBestEffort = async (name: string) => {
    if (!name) return;
    try {
      await execFileAsync("tmux", ["kill-session", "-t", name]);
    } catch (err: any) {
      if (err?.code === "ENOENT") throw err;
      const stderr = typeof err?.stderr === "string" ? err.stderr : "";
      if (/can't find session|no such session/i.test(stderr)) return;
      // ignore other best-effort failures
    }
  };

  const restartConsoleTmuxBounce = async (opts: { tmuxSession: string; cwd: string; command: string }) => {
    await killTmuxSessionBestEffort(opts.tmuxSession);
    await execFileAsync("tmux", ["new-session", "-d", "-s", opts.tmuxSession, "-c", opts.cwd, opts.command]);
  };

  router.post("/api/applets/restart/prod", async (req, res) => {
    if (!config.enableAppletsStackRestart) {
      res.status(404).json({ error: "applets_restart_disabled" });
      return;
    }
    const user = (req as any).user as { userId: string; email?: string };
    const cwd = config.appletsStackCwd ? path.resolve(config.appletsStackCwd) : process.cwd();
    const scriptPath = path.join(cwd, "start-console-tunnel.sh");
    if (!fs.existsSync(scriptPath)) {
      res.status(500).json({ error: "start_console_tunnel_missing" });
      return;
    }

    try {
      const tmuxSession = "applets_console_bounce";
      const cmd = `CONSOLE_PORT=18080 ./start-console-tunnel.sh start --keep-tunnel; exec zsh`;
      await restartConsoleTmuxBounce({ tmuxSession, cwd, command: cmd });
      audit.log({
        type: "applets_restart",
        at: new Date().toISOString(),
        userId: user.userId,
        email: user.email,
        method: "tmux",
        tmuxSession
      });
      res.json({ ok: true, tmuxSession });
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        res.status(500).json({ error: "tmux_missing" });
        return;
      }
      res.status(500).json({ error: "restart_prod_failed" });
    }
  });

  router.post("/api/applets/restart/root", async (req, res) => {
    if (!config.enableAppletsStackRestart) {
      res.status(404).json({ error: "applets_restart_disabled" });
      return;
    }
    const user = (req as any).user as { userId: string; email?: string };
    const cwd = config.appletsStackCwd ? path.resolve(config.appletsStackCwd) : process.cwd();
    const scriptPath = path.join(cwd, "start-root-console-tunnel.sh");
    if (!fs.existsSync(scriptPath)) {
      res.status(500).json({ error: "start_root_console_tunnel_missing" });
      return;
    }

    try {
      const tmuxSession = "applets_root_bounce";
      const cmd = `CONSOLE_PORT=18082 ROOT_PORT=18082 ./start-root-console-tunnel.sh start --keep-tunnel; exec zsh`;
      await restartConsoleTmuxBounce({ tmuxSession, cwd, command: cmd });
      audit.log({
        type: "applets_restart",
        at: new Date().toISOString(),
        userId: user.userId,
        email: user.email,
        method: "tmux",
        tmuxSession
      });
      res.json({ ok: true, tmuxSession });
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        res.status(500).json({ error: "tmux_missing" });
        return;
      }
      res.status(500).json({ error: "restart_root_failed" });
    }
  });

  router.post("/api/applets/restart/dev", async (req, res) => {
    if (!config.enableAppletsStackRestart) {
      res.status(404).json({ error: "applets_restart_disabled" });
      return;
    }
    const user = (req as any).user as { userId: string; email?: string };
    const cwd = config.appletsStackCwd ? path.resolve(config.appletsStackCwd) : process.cwd();

    const ports = [18081, 5174, 18083, 5175];
    const pidsOnPort = async (port: number): Promise<number[]> => {
      try {
        const { stdout } = await execFileAsync("lsof", ["-ti", `tcp:${port}`]);
        return stdout
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => Number(s))
          .filter((n) => Number.isFinite(n) && n > 1);
      } catch {
        return [];
      }
    };

    const killPids = (pids: number[], signal: NodeJS.Signals) => {
      for (const pid of pids) {
        try {
          process.kill(pid, signal);
        } catch {
          // ignore
        }
      }
    };

    try {
      for (const p of ports) {
        const pids = await pidsOnPort(p);
        if (pids.length > 0) killPids(pids, "SIGTERM");
      }
      await sleep(1000);
      for (const p of ports) {
        const pids = await pidsOnPort(p);
        if (pids.length > 0) killPids(pids, "SIGKILL");
      }

      const tmuxSession = "applets_dev";
      await killTmuxSessionBestEffort(tmuxSession);
      await execFileAsync("tmux", ["new-session", "-d", "-s", tmuxSession, "-c", cwd]);
      await execFileAsync("tmux", ["rename-window", "-t", `${tmuxSession}:0`, "console-server"]);
      await execFileAsync("tmux", [
        "send-keys",
        "-t",
        `${tmuxSession}:0`,
        "CONSOLE_PORT=18081 npm run dev:console:server",
        "C-m"
      ]);
      await execFileAsync("tmux", ["new-window", "-t", tmuxSession, "-n", "console-ui", "-c", cwd]);
      await execFileAsync("tmux", [
        "send-keys",
        "-t",
        `${tmuxSession}:console-ui`,
        "CONSOLE_PORT=18081 npm run dev:console:ui",
        "C-m"
      ]);
      await execFileAsync("tmux", ["new-window", "-t", tmuxSession, "-n", "root-server", "-c", cwd]);
      await execFileAsync("tmux", [
        "send-keys",
        "-t",
        `${tmuxSession}:root-server`,
        "CONSOLE_PORT=18083 npm run dev:root-console:server",
        "C-m"
      ]);
      await execFileAsync("tmux", ["new-window", "-t", tmuxSession, "-n", "root-ui", "-c", cwd]);
      await execFileAsync("tmux", [
        "send-keys",
        "-t",
        `${tmuxSession}:root-ui`,
        "ROOT_PORT=18083 CONSOLE_PORT=18083 npm run dev:root:ui",
        "C-m"
      ]);

      audit.log({
        type: "applets_restart",
        at: new Date().toISOString(),
        userId: user.userId,
        email: user.email,
        method: "tmux",
        tmuxSession
      });
      res.json({ ok: true, tmuxSession });
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        res.status(500).json({ error: "tmux_missing" });
        return;
      }
      res.status(500).json({ error: "restart_dev_failed" });
    }
  });

  router.get("/api/ai/status", (_req, res) => {
    res.json({
      namingEnabled: config.enableAiNaming,
      model: config.aiModel
    });
  });

  router.get("/api/ai/sessions/:id/context", (req, res) => {
    const user = (req as any).user;
    const sessionId = String(req.params.id || "").trim();
    const rawInclude = String((req.query as any)?.includeOutput ?? "").trim().toLowerCase();
    const includeOutput =
      rawInclude === "1" || rawInclude === "true" || rawInclude === "yes" || rawInclude === "on";
    const session = manager.assertSessionOwner(user.userId, sessionId);
    res.json({
      sessionId: session.id,
      mode: session.mode,
      tmuxName: session.tmuxName,
      cwd: session.cwd,
      lastTitle: session.lastTitle,
      lastTitleAt: session.lastTitleAt,
      lastCwd: session.lastCwd,
      lastCwdAt: session.lastCwdAt,
      ...(includeOutput ? { outputTail: session.outputTail, outputTailAt: session.outputTailAt } : {})
    });
  });

  const SuggestNameBody = z
    .object({
      includeOutput: z.boolean().optional(),
      codexPrompt: z.string().min(1).max(4_000).optional(),
      codexLogTail: z.string().min(1).max(4_000).optional(),
      codexModel: z.string().min(1).max(80).optional(),
      recentLimit: z.coerce.number().int().min(0).max(12).optional(),
      recentNames: z.array(z.string().min(1).max(160)).max(12).optional()
    })
    .partial()
    .strict();

  router.post("/api/ai/sessions/:id/suggest-name", async (req, res) => {
    if (!config.enableAiNaming) {
      const err: any = new Error("ai_disabled");
      err.statusCode = 404;
      throw err;
    }

    const user = (req as any).user;
    const sessionId = String(req.params.id || "").trim();
    const body = SuggestNameBody.parse(req.body ?? {});
    const session = manager.assertSessionOwner(user.userId, sessionId);

    const recentLimit = typeof body.recentLimit === "number" ? body.recentLimit : 8;
    const includeOutput = Boolean(body.includeOutput);
    const recentNames =
      Array.isArray(body.recentNames) && body.recentNames.length > 0
        ? body.recentNames
        : recentAiNames(user.userId, recentLimit);

    let outputTail: string | undefined = includeOutput ? session.outputTail : undefined;
    if (includeOutput && session.tmuxName) {
      try {
        const tmuxTail = await captureTmuxTail(session.tmuxName);
        if (tmuxTail) outputTail = tmuxTail;
      } catch {
        // Ignore tmux capture failures; fall back to the PTY tail we track in-session.
      }
    }

    const result = await suggestSessionName(
      {
        mode: session.mode,
        tmuxName: session.tmuxName,
        cwd: session.cwd,
        lastCwd: session.lastCwd,
        lastTitle: session.lastTitle,
        outputTail,
        codexPrompt: body.codexPrompt,
        codexLogTail: body.codexLogTail,
        codexModel: body.codexModel,
        recentNames
      },
      {
        apiKey: config.aiOpenAiApiKey!,
        baseUrl: config.aiOpenAiBaseUrl,
        model: config.aiModel,
        timeoutMs: config.aiTimeoutMs
      }
    );

    recordAiName(user.userId, result.name);
    res.json({ name: result.name, requestId: result.requestId });
  });

  router.get("/api/sessions", (req, res) => {
    const user = (req as any).user;
    res.json({ sessions: manager.listForUser(user.userId) });
  });

  router.get("/api/sessions/persistent", async (req, res) => {
    if (!config.enableTmux) {
      res.json({ sessions: [] });
      return;
    }
    const user = (req as any).user;
    const prefix = tmuxPrefixForUser(user.userId);
    const sessions = await listTmuxSessions(tmuxAllowsAllSessions ? undefined : prefix);
    res.json({ sessions });
  });

  router.post("/api/sessions/persistent/:name/close", async (req, res) => {
    if (!config.enableTmux) {
      res.status(404).json({ error: "tmux_disabled" });
      return;
    }
    const user = (req as any).user;
    const name = req.params.name;
    if (!isAllowedTmuxNameForUser(user.userId, name)) {
      res.status(400).json({ error: "invalid_tmux" });
      return;
    }

    const force = Boolean((req.body as any)?.force);
    // If the user wants to delete a tmux session, it's almost always because it's no longer needed.
    // Best-effort close any active web sessions that are currently attached to it (these keep a tmux
    // client attached even after the browser disconnects due to detach-grace).
    const activeWeb = manager.listForUser(user.userId).filter((session) => session.tmuxName === name);
    for (const session of activeWeb) {
      try {
        manager.close(user.userId, session.id);
      } catch {
        // ignore best-effort close failures
      }
    }
    if (!force) {
      let attachedCount = 0;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const visible = await listTmuxSessions(tmuxAllowsAllSessions ? undefined : tmuxPrefixForUser(user.userId));
        const current = visible.find((s) => s.name === name);
        attachedCount = current ? (current.attachedCount ?? (current.attached ? 1 : 0)) : 0;
        if (attachedCount <= 0) break;
        await sleep(50 * (attempt + 1));
      }
      if (attachedCount > 0) {
        res.status(409).json({ error: "tmux_attached" });
        return;
      }
    }
    try {
      await execFileAsync("tmux", ["kill-session", "-t", name]);
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        res.status(500).json({ error: "tmux_missing" });
        return;
      }
      const stderr = typeof err?.stderr === "string" ? err.stderr : "";
      if (/can't find session|no such session/i.test(stderr)) {
        res.json({ ok: true });
        return;
      }
      res.status(500).json({ error: "tmux_kill_failed" });
      return;
    }
    res.json({ ok: true });
  });

  router.post("/api/sessions/persistent/:name/open-terminal", async (req, res) => {
    if (!config.enableTmux) {
      res.status(404).json({ error: "tmux_disabled" });
      return;
    }
    if (!config.enableMacosTerminalLaunch) {
      res.status(404).json({ error: "terminal_launch_disabled" });
      return;
    }
    if (!isMacos) {
      res.status(404).json({ error: "terminal_launch_unsupported" });
      return;
    }

    const user = (req as any).user;
    const name = req.params.name;
    if (!isAllowedTmuxNameForUser(user.userId, name)) {
      res.status(400).json({ error: "invalid_tmux" });
      return;
    }

    try {
      await launchMacosTerminalForTmux(name);
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("terminal_launch_failed", { tmuxName: name, error: message });
      res.status(500).json({ error: "terminal_launch_failed" });
    }
  });

  const ResumeKeySchema = z.string().min(1).max(200);
  const SnapshotSchema = z.string().max(1_000_000);
  const AudioPrefsSchema = z
    .object({
      ttsEnabled: z.boolean().optional(),
      ttsEngine: z.enum(["openai", "piper", "browser"]).optional(),
      ttsSource: z.enum(["terminal", "codex"]).optional(),
      ttsVoice: z.string().max(120).optional(),
      ttsBrowserVoice: z.string().max(200).optional(),
      ttsVolume: z.number().min(0).max(1).optional(),
      ttsRate: z.number().min(0.5).max(2).optional(),
      ttsFallbackEnabled: z.boolean().optional(),
      sttEnabled: z.boolean().optional(),
      sttEngine: z.enum(["cpp", "openai"]).optional(),
      sttModel: z.string().max(160).optional(),
      sttLang: z.string().max(64).optional()
    })
    .partial()
    .strict();

  const BriefPrefsSchema = z
    .object({
      tmuxEnabled: z.boolean(),
      tmuxMatchRegex: z.string().max(240),
      tmuxMaxSessions: z.number().int().min(1).max(25),
      tmuxRecentMinutes: z.number().int().min(10).max(24 * 60),
      tasksEnabled: z.boolean(),
      tasksFolder: z.string().max(4096),
      tasksMaxFiles: z.number().int().min(1).max(60),
      tasksRecentHours: z.number().int().min(1).max(24 * 14),
      tasksIncludeGlobs: z.array(z.string().max(240)).max(20),
      tasksExcludeGlobs: z.array(z.string().max(240)).max(40),
      openAiModel: z.string().max(120),
      ttsModel: z.string().max(120),
      voice: z.string().max(80),
      spokenSeconds: z.number().int().min(10).max(180),
      redactPaths: z.boolean(),
      maxCharsPerFile: z.number().int().min(200).max(20_000)
    })
    .partial()
    .strict();

  const BriefRunBodySchema = z
    .object({
      prefs: BriefPrefsSchema.optional()
    })
    .strict();

  const CreateSessionBody = z.object({
    mode: z.enum(["node", "shell", "readonly_tail", "tmux"]),
    cwd: z.string().min(1).max(4096).optional(),
    readonlyPath: z.string().optional(),
    tmuxName: z.string().optional(),
    launchTerminal: z.boolean().optional(),
    cols: z.number().int().min(10).max(500).optional(),
    rows: z.number().int().min(5).max(300).optional(),
    resumeKey: ResumeKeySchema.optional(),
    initialSnapshot: SnapshotSchema.optional()
  });

  const AttachSessionBody = z.object({
    cols: z.number().int().min(10).max(500).optional(),
    rows: z.number().int().min(5).max(300).optional()
  });

  const AttachOrCreateBody = CreateSessionBody.extend({
    resumeKey: ResumeKeySchema
  });

  router.post(
    "/api/uploads",
    express.raw({ type: ["image/*", "application/octet-stream"], limit: "20mb" }),
    (req, res) => {
      const contentType = req.headers["content-type"] || "";
      if (!contentType || (!contentType.startsWith("image/") && contentType !== "application/octet-stream")) {
        res.status(415).json({ error: "unsupported_media_type" });
        return;
      }

      const buf = req.body as Buffer;
      if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) {
        res.status(400).json({ error: "empty_upload" });
        return;
      }

      let rawName = String(req.headers["x-filename"] || "image");
      try {
        rawName = decodeURIComponent(rawName);
      } catch {
        // ignore malformed encoding
      }
      const safeName = sanitizeFilename(path.basename(rawName || "image"));
      const ext = path.extname(safeName) || extFromContentType(contentType) || ".bin";
      if (contentType === "application/octet-stream" && !isAllowedImageExt(ext)) {
        res.status(415).json({ error: "unsupported_media_type" });
        return;
      }
      const base = safeName.replace(/\.[^/.]+$/, "") || "image";
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const shortId = crypto.randomBytes(6).toString("hex");
      const filename = `${stamp}_${shortId}_${base}${ext}`;

      ensureUploadDir();
      const filePath = path.join(uploadDir, filename);
      fs.writeFileSync(filePath, buf);

      res.json({
        ok: true,
        filename,
        path: filePath,
        url: withBase(basePath, `/uploads/${filename}`)
      });
    }
  );

  router.post("/api/sessions", (req, res) => {
    const user = (req as any).user;
    const body = CreateSessionBody.parse(req.body);

    let createBody = body;
    if (body.mode === "tmux") {
      if (!config.enableTmux) {
        throw new Error("Mode disabled: tmux");
      }
      if (body.tmuxName) {
        if (!isAllowedTmuxNameForUser(user.userId, body.tmuxName)) {
          throw new Error("Invalid tmux session");
        }
      }
      createBody = {
        ...body,
        tmuxName: body.tmuxName || makeTmuxName(user.userId)
      };
    }

    const session = manager.create(user, createBody);
    if (session.mode === "tmux" && session.tmuxName) {
      void enforceManagedTmuxMouse(session.tmuxName);
    }
    const attachToken = manager.mintAttachToken(user.userId, session.id, {
      cols: body.cols,
      rows: body.rows
    });
    const wsUrl = buildWsUrl(`/ws/sessions/${session.id}`, attachToken);

    audit.log({
      type: "session_create",
      at: new Date().toISOString(),
      userId: user.userId,
      sessionId: session.id,
      mode: session.mode,
      pid: session.pty.pid
    });

    if (
      body.mode === "tmux" &&
      config.enableMacosTerminalLaunch &&
      isMacos &&
      session.tmuxName &&
      (body.launchTerminal ?? config.macosTerminalLaunchOnTmuxCreate)
    ) {
      void launchMacosTerminalForTmux(session.tmuxName).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn("terminal_launch_failed", { tmuxName: session.tmuxName, error: message });
      });
    }

    const payload: Record<string, unknown> = { sessionId: session.id, attachToken, wsUrl };
    if (session.tmuxName) payload.tmuxName = session.tmuxName;
    res.json(payload);
  });

  router.post("/api/sessions/attach-or-create", async (req, res) => {
    const user = (req as any).user;
    const body = AttachOrCreateBody.parse(req.body);
    const existing = manager.findByResumeKey(user.userId, body.resumeKey);
    if (existing) {
      if (existing.mode === "tmux" && existing.tmuxName) {
        void enforceManagedTmuxMouse(existing.tmuxName);
      }
      const attachToken = manager.mintAttachToken(user.userId, existing.id, {
        cols: body.cols,
        rows: body.rows
      });
      const wsUrl = buildWsUrl(`/ws/sessions/${existing.id}`, attachToken);
      const payload: Record<string, unknown> = { sessionId: existing.id, attachToken, wsUrl, created: false };
      if (existing.tmuxName) payload.tmuxName = existing.tmuxName;
      res.json(payload);
      return;
    }

    let createBody = body;
    if (body.mode === "tmux") {
      if (!config.enableTmux) {
        throw new Error("Mode disabled: tmux");
      }
      let tmuxName = body.tmuxName;
      if (tmuxName) {
        if (!isAllowedTmuxNameForUser(user.userId, tmuxName)) {
          throw new Error("Invalid tmux session");
        }
      }
      // If the UI is trying to resume a tmux-backed session after a server restart,
      // it may only have the resumeKey. Prefer reusing an existing tmux session for
      // this user rather than creating a fresh tmux session every time.
      if (!tmuxName) {
        const pickMostRecentName = (sessions: Array<{ name: string; lastActivityAt?: number; createdAt?: number }>) => {
          let best: { name: string; score: number; created: number } | null = null;
          for (const s of sessions) {
            const activity = typeof s.lastActivityAt === "number" ? s.lastActivityAt : 0;
            const created = typeof s.createdAt === "number" ? s.createdAt : 0;
            const score = activity || created;
            if (!best) {
              best = { name: s.name, score, created };
              continue;
            }
            if (score !== best.score) {
              if (score > best.score) best = { name: s.name, score, created };
              continue;
            }
            if (created > best.created) best = { name: s.name, score, created };
          }
          return best?.name ?? null;
        };

        if (tmuxAllowsAllSessions) {
          const visible = await listTmuxSessions();
          const userPrefix = tmuxPrefixForUser(user.userId);
          const appPrefix = `${tmuxPrefixBase}-`;
          const byUser = pickMostRecentName(visible.filter((s) => s.name.startsWith(userPrefix)));
          const byApp = pickMostRecentName(visible.filter((s) => s.name.startsWith(appPrefix)));
          const any = pickMostRecentName(visible);
          const candidate = byUser || byApp || any;
          if (candidate && isAllowedTmuxNameForUser(user.userId, candidate)) tmuxName = candidate;
        } else {
          const visible = await listTmuxSessions(tmuxPrefixForUser(user.userId));
          const candidate = pickMostRecentName(visible);
          if (candidate && isAllowedTmuxNameForUser(user.userId, candidate)) tmuxName = candidate;
        }
      }
      createBody = {
        ...body,
        tmuxName: tmuxName || makeTmuxName(user.userId)
      };
    }

    const session = manager.create(user, createBody);
    if (session.mode === "tmux" && session.tmuxName) {
      void enforceManagedTmuxMouse(session.tmuxName);
    }
    const attachToken = manager.mintAttachToken(user.userId, session.id, {
      cols: body.cols,
      rows: body.rows
    });
    const wsUrl = buildWsUrl(`/ws/sessions/${session.id}`, attachToken);

    audit.log({
      type: "session_create",
      at: new Date().toISOString(),
      userId: user.userId,
      sessionId: session.id,
      mode: session.mode,
      pid: session.pty.pid
    });

    if (
      body.mode === "tmux" &&
      config.enableMacosTerminalLaunch &&
      isMacos &&
      session.tmuxName &&
      (body.launchTerminal ?? config.macosTerminalLaunchOnTmuxCreate)
    ) {
      void launchMacosTerminalForTmux(session.tmuxName).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn("terminal_launch_failed", { tmuxName: session.tmuxName, error: message });
      });
    }

    const payload: Record<string, unknown> = { sessionId: session.id, attachToken, wsUrl, created: true };
    if (session.tmuxName) payload.tmuxName = session.tmuxName;
    res.json(payload);
  });

  router.post("/api/sessions/:id/attach", (req, res) => {
    const user = (req as any).user;
    const sessionId = req.params.id;
    const body = AttachSessionBody.parse(req.body ?? {});
    const attachToken = manager.mintAttachToken(user.userId, sessionId, {
      cols: body.cols,
      rows: body.rows
    });
    const wsUrl = buildWsUrl(`/ws/sessions/${sessionId}`, attachToken);
    res.json({ sessionId, attachToken, wsUrl });
  });

  // Chat-specific attach endpoint - returns both terminal and chat WebSocket URLs
  router.post("/api/sessions/:id/attach-chat", (req, res) => {
    const user = (req as any).user;
    const sessionId = req.params.id;
    const body = AttachSessionBody.parse(req.body ?? {});
    const attachToken = manager.mintAttachToken(user.userId, sessionId, {
      cols: body.cols,
      rows: body.rows
    });
    const wsUrl = buildWsUrl(`/ws/sessions/${sessionId}`, attachToken);
    const chatWsUrl = buildWsUrl(`/ws/chat/sessions/${sessionId}`, attachToken);
    res.json({ sessionId, attachToken, wsUrl, chatWsUrl });
  });

  router.post("/api/sessions/:id/close", (req, res) => {
    const user = (req as any).user;
    const sessionId = req.params.id;
    manager.close(user.userId, sessionId);
    audit.log({
      type: "session_close",
      at: new Date().toISOString(),
      userId: user.userId,
      sessionId,
      mode: "unknown"
    });
    res.json({ ok: true });
  });

  // Markdown task library (server-rendered).
  // This is intentionally a non-API route so it doesn't require X-App-Token (if enabled).
  type MarkdownLibraryKey = "tasks" | "docs" | "sn_docs";
  type TaskDocExt = "md" | "html" | "htm";
  const markdownLibraryRoots: Record<MarkdownLibraryKey, string> = {
    tasks: path.resolve(codexExecCwd, "tasks"),
    docs: path.resolve(codexExecCwd, "docs"),
    sn_docs: path.resolve(codexExecCwd, "ServiceNow", "nisourcedev", "docs")
  };
  const markdownLibraryExts: Record<MarkdownLibraryKey, TaskDocExt[]> = {
    tasks: ["md"],
    docs: ["md", "html", "htm"],
    sn_docs: ["md", "html", "htm"]
  };
  const md = new MarkdownIt({ html: false, linkify: true });

  type TaskDocEntry = {
    rel: string;
    abs: string;
    ext: TaskDocExt;
    dayKey: number;
    createdMs: number;
    modifiedMs: number;
    sizeBytes: number;
  };

  const toForwardSlashes = (p: string) => p.replace(/\\/g, "/");

  const escapeHtml = (raw: string) =>
    raw
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  const parseDayKey = (rel: string): number => {
    const first = rel.split("/")[0] || "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(first)) return 0;
    return Number(first.replace(/-/g, ""));
  };

  const pickCreatedMs = (stat: fs.Stats): number => {
    const birth = stat.birthtimeMs;
    if (Number.isFinite(birth) && birth > 0) return birth;
    const changed = stat.ctimeMs;
    if (Number.isFinite(changed) && changed > 0) return changed;
    return stat.mtimeMs;
  };

  const fmtMs = (ms: number): string => {
    if (!Number.isFinite(ms) || ms <= 0) return "";
    try {
      return new Date(ms).toISOString().replace("T", " ").replace("Z", "Z");
    } catch {
      return "";
    }
  };

  const firstQueryValue = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (Array.isArray(value) && typeof value[0] === "string") return value[0];
    return "";
  };

  const parseMarkdownLibraryKey = (value: unknown): MarkdownLibraryKey | null => {
    const raw = firstQueryValue(value).trim().toLowerCase();
    if (!raw) return "tasks";
    if (raw === "tasks" || raw === "docs" || raw === "sn_docs") return raw;
    return null;
  };

  const hasSymlinkSegment = (rootDir: string, abs: string): boolean => {
    const rel = path.relative(rootDir, abs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return true;
    const parts = rel.split(path.sep).filter(Boolean);
    let current = rootDir;
    for (const part of parts) {
      current = path.join(current, part);
      try {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) return true;
      } catch {
        // If the path does not exist we won't follow anything.
        return false;
      }
    }
    return false;
  };

  const normalizeDocExt = (p: string): TaskDocExt | "" => {
    const ext = path.extname(String(p || "")).toLowerCase();
    if (ext === ".md") return "md";
    if (ext === ".html") return "html";
    if (ext === ".htm") return "htm";
    return "";
  };

  const resolveDocFileAbs = (
    rootDir: string,
    rawRel: string,
    allowedExts: readonly TaskDocExt[]
  ): string | null => {
    const cleaned = toForwardSlashes(String(rawRel || ""))
      .replace(/^\/+/, "")
      .trim();
    if (!cleaned || cleaned.includes("\0")) return null;
    const ext = normalizeDocExt(cleaned);
    if (!ext || !allowedExts.includes(ext)) return null;

    const abs = path.resolve(rootDir, cleaned);
    const relative = path.relative(rootDir, abs);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
    if (fs.existsSync(abs) && hasSymlinkSegment(rootDir, abs)) return null;
    return abs;
  };

  const MAX_TASK_FILES = 5000;
  const tasksIndexCache: Record<MarkdownLibraryKey, { atMs: number; items: TaskDocEntry[] }> = {
    tasks: { atMs: 0, items: [] },
    docs: { atMs: 0, items: [] },
    sn_docs: { atMs: 0, items: [] }
  };
  const getTasksIndex = (lib: MarkdownLibraryKey): TaskDocEntry[] => {
    const rootDir = markdownLibraryRoots[lib];
    const allowedExts = markdownLibraryExts[lib];
    const cache = tasksIndexCache[lib];
    const now = Date.now();
    const ttlMs = lib === "tasks" ? 5000 : 1500;
    if (now - cache.atMs < ttlMs && cache.items.length > 0) {
      return cache.items;
    }

    const shouldSkipDirName = (name: string): boolean => {
      if (!name) return true;
      if (name.startsWith(".")) return true;
      const lowered = name.toLowerCase();
      if (lowered === "node_modules") return true;
      if (lowered === "site-packages") return true;
      if (lowered === "__pycache__") return true;
      if (lowered === "t5x") return true;
      if (lowered === "diffsinger") return true;
      if (lowered === "venv") return true;
      if (lowered.endsWith("-venv")) return true;
      if (lowered.includes(".venv")) return true;
      return false;
    };

    const items: TaskDocEntry[] = [];
    const walk = (dirAbs: string) => {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dirAbs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (items.length >= MAX_TASK_FILES) return;
        const name = entry.name || "";
        if (!name || name.startsWith(".")) continue;
        const abs = path.join(dirAbs, name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (shouldSkipDirName(name)) continue;
          walk(abs);
          continue;
        }
        if (!entry.isFile()) continue;
        const ext = normalizeDocExt(name);
        if (!ext || !allowedExts.includes(ext)) continue;
        try {
          const stat = fs.statSync(abs);
          const rel = toForwardSlashes(path.relative(rootDir, abs));
          items.push({
            rel,
            abs,
            ext,
            dayKey: parseDayKey(rel),
            createdMs: pickCreatedMs(stat),
            modifiedMs: stat.mtimeMs,
            sizeBytes: stat.size
          });
        } catch {
          // ignore unreadable files
        }
      }
    };

    try {
      if (fs.existsSync(rootDir)) walk(rootDir);
    } catch {
      // ignore missing tasks root
    }

    items.sort((a, b) => {
      if (a.dayKey !== b.dayKey) return b.dayKey - a.dayKey;
      if (a.createdMs !== b.createdMs) return b.createdMs - a.createdMs;
      if (a.modifiedMs !== b.modifiedMs) return b.modifiedMs - a.modifiedMs;
      return a.rel.localeCompare(b.rel);
    });

    cache.atMs = now;
    cache.items = items;
    return items;
  };

  // Legacy docs viewer entrypoint - redirect to the Markdown library.
  router.get("/docs.html", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, "/tasks?lib=docs");
  });

  router.get("/tasks", (req, res) => {
    const lib = parseMarkdownLibraryKey((req as any).query?.lib);
    const q = firstQueryValue((req as any).query?.q).trim();
    const fileRaw = firstQueryValue((req as any).query?.file).trim();

    const rootDir = lib ? markdownLibraryRoots[lib] : markdownLibraryRoots.tasks;
    const allowedExts = lib ? markdownLibraryExts[lib] : markdownLibraryExts.tasks;
    const allItems = lib ? getTasksIndex(lib) : [];
    const needle = q.toLowerCase();
    const items = needle ? allItems.filter((it) => it.rel.toLowerCase().includes(needle)) : allItems;

    const selectedAbs = lib && fileRaw ? resolveDocFileAbs(rootDir, fileRaw, allowedExts) : null;
    const selectedRel = selectedAbs ? toForwardSlashes(path.relative(rootDir, selectedAbs)) : "";

    let status = 200;
    let error: string | null = null;
    let renderedMarkdown: string | null = null;
    let renderedHtml: string | null = null;
    let selectedInfo: TaskDocEntry | null = null;

    if (!lib) {
      status = 400;
      error = "Invalid lib param (must be one of: tasks, docs).";
    } else if (fileRaw && !selectedAbs) {
      status = 400;
      error = `Invalid file path (must be a .md/.html within the ${lib} library root).`;
    }

    if (selectedAbs) {
      try {
        const stat = fs.statSync(selectedAbs);
        const ext = normalizeDocExt(selectedAbs);
        if (!ext || !allowedExts.includes(ext)) throw new Error("Invalid file extension.");
        const raw = fs.readFileSync(selectedAbs, "utf8");
        if (ext === "md") renderedMarkdown = md.render(raw);
        else renderedHtml = raw;
        selectedInfo = {
          rel: selectedRel,
          abs: selectedAbs,
          ext,
          dayKey: parseDayKey(selectedRel),
          createdMs: pickCreatedMs(stat),
          modifiedMs: stat.mtimeMs,
          sizeBytes: stat.size
        };
      } catch (err) {
        status = 404;
        error = err instanceof Error ? err.message : String(err);
      }
    }

    const title = lib === "docs" ? "Docs Library" : lib === "sn_docs" ? "ServiceNow Docs" : "Task Library";
    const rootLabel =
      lib === "docs" ? "docs/" : lib === "sn_docs" ? "ServiceNow/nisourcedev/docs/" : "tasks/";
    const libParam = lib ? `lib=${encodeURIComponent(lib)}` : "";
    const tabsHtml = lib
      ? `
        <nav class="tabs" aria-label="Document libraries">
          <a class="pill tab ${lib === "tasks" ? "active" : ""}" href="?lib=tasks&q=${encodeURIComponent(q)}">Tasks</a>
          <a class="pill tab ${lib === "docs" ? "active" : ""}" href="?lib=docs&q=${encodeURIComponent(q)}">Docs</a>
          <a class="pill tab ${lib === "sn_docs" ? "active" : ""}" href="?lib=sn_docs&q=${encodeURIComponent(
            q
          )}">SN Docs</a>
        </nav>
      `.trim()
      : "";
    const listHtml =
      items.length === 0
        ? `<div class="empty">No matching documents.</div>`
        : items
            .map((it) => {
              const isActive = selectedRel && it.rel === selectedRel;
              const href = `?${libParam}&q=${encodeURIComponent(q)}&file=${encodeURIComponent(it.rel)}`;
              const created = fmtMs(it.createdMs);
              const modified = fmtMs(it.modifiedMs);
              return `
                <a class="item ${isActive ? "active" : ""}" href="${href}">
                  <div class="itemPath">${escapeHtml(it.rel)}</div>
                  <div class="itemMeta">
                    <span>created ${escapeHtml(created || "?")}</span>
                    <span>modified ${escapeHtml(modified || "?")}</span>
                  </div>
                </a>
              `;
            })
            .join("");

    const contentHtml = (() => {
      if (error) {
        return `<div class="notice error"><strong>Error:</strong> ${escapeHtml(error)}</div>`;
      }
      if (!selectedAbs || !selectedInfo || (selectedInfo.ext === "md" ? !renderedMarkdown : !renderedHtml)) {
        return `<div class="notice"><strong>Select a document</strong> from the list to view it.</div>`;
      }
      const created = fmtMs(selectedInfo.createdMs);
      const modified = fmtMs(selectedInfo.modifiedMs);
      const rawHref = `raw?${libParam}&file=${encodeURIComponent(selectedInfo.rel)}`;
      const selectedIndex = items.findIndex((it) => it.rel === selectedInfo.rel);
      const prevRel = selectedIndex > 0 ? items[selectedIndex - 1]?.rel : "";
      const nextRel = selectedIndex >= 0 && selectedIndex < items.length - 1 ? items[selectedIndex + 1]?.rel : "";
      const prevHref = prevRel ? `?${libParam}&q=${encodeURIComponent(q)}&file=${encodeURIComponent(prevRel)}` : "";
      const nextHref = nextRel ? `?${libParam}&q=${encodeURIComponent(q)}&file=${encodeURIComponent(nextRel)}` : "";
      const prevHtml = prevHref
        ? `<a class="pill nav" id="docPrev" href="${prevHref}" title="Previous note (swipe right)">&larr; Prev</a>`
        : `<span class="pill nav disabled" id="docPrev" aria-disabled="true">&larr; Prev</span>`;
      const nextHtml = nextHref
        ? `<a class="pill nav" id="docNext" href="${nextHref}" title="Next note (swipe left)">Next &rarr;</a>`
        : `<span class="pill nav disabled" id="docNext" aria-disabled="true">Next &rarr;</span>`;
      const bodyHtml =
        selectedInfo.ext === "md"
          ? `<article class="markdown">${renderedMarkdown || ""}</article>`
          : `<iframe class="docHtmlFrame" sandbox referrerpolicy="no-referrer" src="${rawHref}"></iframe>`;
      return `
        <div class="docHeader">
          <div class="docTitle">${escapeHtml(selectedInfo.rel)}</div>
          <div class="docMeta">
            <span>created ${escapeHtml(created || "?")}</span>
            <span>modified ${escapeHtml(modified || "?")}</span>
            <span>${escapeHtml(String(selectedInfo.sizeBytes))} bytes</span>
            <span class="docNav" aria-label="Navigate notes">
              ${prevHtml}
              ${nextHtml}
            </span>
            <a class="pill" href="${rawHref}" target="_blank" rel="noreferrer">raw</a>
          </div>
        </div>
        ${bodyHtml}
      `;
    })();

    const cspNonce = crypto.randomBytes(16).toString("base64");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${cspNonce}'; img-src 'self' data: https: http:; frame-src 'self' about:; base-uri 'none'; form-action 'self'`
    );

    const tasksScript = String.raw`
(() => {
  const STORAGE_KEY = "console.tasks.sidebar.v1";
  const FONT_KEY = "console.tasks.fontScale.v1";
  const NAV_INTENT_KEY = "console.tasks.navIntent.v1";
  const NAV_INTENT_TTL_MS = 2000;
  const EXIT_ANIM_MS = 170;
  const FONT_MIN = 0.8;
  const FONT_MAX = 1.8;
  const FONT_STEP = 0.1;

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const setNav = (value, persist) => {
    document.documentElement.dataset.nav = value;
    if (persist === false) return;
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // ignore storage failures
    }
  };

  const readStored = () => {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  };

  const stored = readStored();
  const hasSelection = ${selectedAbs ? "true" : "false"};
  const shouldDefaultCollapsed = () => {
    try {
      return hasSelection && window.matchMedia && window.matchMedia("(max-width: 920px)").matches;
    } catch {
      return false;
    }
  };

  if (stored === "open" || stored === "collapsed") setNav(stored, false);
  else setNav(shouldDefaultCollapsed() ? "collapsed" : "open", false);

  const loadFontScale = () => {
    try {
      const raw = localStorage.getItem(FONT_KEY);
      const parsed = raw ? Number.parseFloat(raw) : Number.NaN;
      if (!Number.isFinite(parsed)) return 1;
      return clamp(Math.round(parsed * 10) / 10, FONT_MIN, FONT_MAX);
    } catch {
      return 1;
    }
  };

  let fontScale = loadFontScale();
  document.documentElement.style.setProperty("--font-scale", fontScale.toFixed(2));

  const updateTopHeight = () => {
    const top = document.querySelector(".top");
    if (!(top instanceof HTMLElement)) return;
    const rect = top.getBoundingClientRect();
    if (!rect.height) return;
    document.documentElement.style.setProperty("--top-h", String(Math.round(rect.height)) + "px");
  };

  const syncToggle = () => {
    const toggle = document.getElementById("navToggle");
    if (!toggle) return;
    const open = document.documentElement.dataset.nav !== "collapsed";
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  };

  const renderFontScale = () => {
    const label = document.getElementById("fontPct");
    if (!label) return;
    label.textContent = String(Math.round(fontScale * 100)) + "%";
  };

  const applyFontScale = (next) => {
    fontScale = clamp(Math.round(next * 10) / 10, FONT_MIN, FONT_MAX);
    document.documentElement.style.setProperty("--font-scale", fontScale.toFixed(2));
    renderFontScale();
    try {
      localStorage.setItem(FONT_KEY, fontScale.toFixed(1));
    } catch {
      // ignore storage failures
    }
  };

  const splitTextForTts = (text) => {
    const cleaned = String(text ?? "")
      .replace(/\\r/g, "\\n")
      .replace(/[ \\t]+\\n/g, "\\n")
      .replace(/\\n{3,}/g, "\\n\\n")
      .trim();
    if (!cleaned) return [];

    const MAX_CHARS = 260;
    const MIN_SLICE = 120;
    const out = [];
    const paragraphs = cleaned.split(/\\n{2,}/g);

    const pushChunk = (chunk) => {
      const trimmed = String(chunk ?? "").trim();
      if (trimmed) out.push(trimmed);
    };

    const breakIndex = (s) => {
      const hard = Math.min(MAX_CHARS, s.length);
      if (s.length <= hard) return s.length;
      const candidates = [". ", "? ", "! ", "; ", ": ", ", ", " - ", " "];
      let best = -1;
      for (const c of candidates) {
        const idx = s.lastIndexOf(c, hard);
        if (idx < MIN_SLICE) continue;
        if (idx + c.length > best) best = idx + c.length;
      }
      return best > 0 ? best : hard;
    };

    for (const paraRaw of paragraphs) {
      let para = paraRaw.replace(/\\s+/g, " ").trim();
      while (para.length > MAX_CHARS) {
        const idx = breakIndex(para);
        pushChunk(para.slice(0, idx));
        para = para.slice(idx).trim();
      }
      pushChunk(para);
    }
    return out;
  };

  const makeTtsController = () => {
    const supported =
      typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
    const btn = document.getElementById("ttsToggle");
    if (!btn) return { supported, stop: () => {}, sync: () => {} };

    let active = false;
    let chunks = [];
    let idx = 0;

    const updateButton = () => {
      btn.textContent = active ? "Stop" : "Read";
      btn.classList.toggle("active", active);
    };

    const stop = () => {
      if (!supported) return;
      try {
        window.speechSynthesis.cancel();
      } catch {
        // ignore
      }
      active = false;
      chunks = [];
      idx = 0;
      updateButton();
    };

    const next = () => {
      if (!supported || !active) return;
      if (idx >= chunks.length) {
        stop();
        return;
      }
      const utter = new SpeechSynthesisUtterance(chunks[idx] || "");
      utter.rate = 1;
      utter.pitch = 1;
      utter.volume = 1;
      utter.onend = () => {
        idx += 1;
        window.setTimeout(next, 0);
      };
      utter.onerror = () => stop();
      try {
        window.speechSynthesis.resume();
      } catch {
        // ignore
      }
      window.speechSynthesis.speak(utter);
    };

    const start = () => {
      if (!supported) return;
      const article = document.querySelector("article.markdown");
      const text = article && article instanceof HTMLElement ? article.innerText : "";
      chunks = splitTextForTts(text);
      if (chunks.length === 0) return;
      idx = 0;
      active = true;
      updateButton();
      try {
        window.speechSynthesis.cancel();
      } catch {
        // ignore
      }
      next();
    };

    const toggle = () => {
      if (!supported) return;
      if (active) stop();
      else start();
    };

    btn.addEventListener("click", (event) => {
      event.preventDefault();
      toggle();
    });

    window.addEventListener("pagehide", () => stop());

    const sync = () => {
      const hasDoc = Boolean(document.querySelector("article.markdown"));
      if (typeof btn.toggleAttribute === "function") {
        btn.toggleAttribute("disabled", !supported || !hasDoc);
      } else {
        btn.disabled = !supported || !hasDoc;
      }
      if (!hasDoc && active) stop();
      updateButton();
    };

    sync();
    return { supported, stop, sync };
  };

  const storeNavIntent = (dir) => {
    try {
      sessionStorage.setItem(NAV_INTENT_KEY, JSON.stringify({ dir, at: Date.now() }));
    } catch {
      // ignore storage failures
    }
  };

  const readNavIntent = () => {
    try {
      const raw = sessionStorage.getItem(NAV_INTENT_KEY);
      if (!raw) return null;
      sessionStorage.removeItem(NAV_INTENT_KEY);
      const parsed = JSON.parse(raw);
      const dir = parsed && typeof parsed.dir === "string" ? parsed.dir : "";
      const at = parsed && typeof parsed.at === "number" ? parsed.at : 0;
      if (!at || Date.now() - at > NAV_INTENT_TTL_MS) return null;
      return dir === "next" || dir === "prev" ? dir : null;
    } catch {
      return null;
    }
  };

  const isInteractiveTarget = (target) => {
    if (!(target instanceof HTMLElement)) return false;
    return Boolean(target.closest("a,button,input,textarea,select,summary,details,label"));
  };

  const isSwipeBlockedTarget = (target) => {
    if (!(target instanceof HTMLElement)) return false;
    if (isInteractiveTarget(target)) return true;
    if (target.closest("pre")) return true;
    if (target.closest("table")) return true;
    return false;
  };

  const setupDocNavigation = (tts) => {
    const content = document.querySelector("main.content");
    if (!(content instanceof HTMLElement)) return;
    const hasDoc = Boolean(document.querySelector("article.markdown, iframe.docHtmlFrame"));
    if (!hasDoc) return;

    const intent = readNavIntent();
    if (intent) content.dataset.enter = intent;

    const prevEl = document.getElementById("docPrev");
    const nextEl = document.getElementById("docNext");
    const prevHref = prevEl instanceof HTMLAnchorElement ? prevEl.href : "";
    const nextHref = nextEl instanceof HTMLAnchorElement ? nextEl.href : "";

    let navigating = false;
    const navigate = (dir) => {
      if (navigating) return;
      const href = dir === "prev" ? prevHref : nextHref;
      if (!href) return;
      navigating = true;
      try {
        tts.stop();
      } catch {
        // ignore
      }
      storeNavIntent(dir);
      content.dataset.exit = dir;
      window.setTimeout(() => {
        window.location.href = href;
      }, EXIT_ANIM_MS);
    };

    if (prevEl instanceof HTMLAnchorElement) {
      prevEl.addEventListener("click", (event) => {
        event.preventDefault();
        navigate("prev");
      });
    }
    if (nextEl instanceof HTMLAnchorElement) {
      nextEl.addEventListener("click", (event) => {
        event.preventDefault();
        navigate("next");
      });
    }

    const swipe = { active: false, triggered: false, startX: 0, startY: 0, lastX: 0, lastY: 0 };
    const EDGE_GUARD_PX = 24; // avoid Safari back/forward edge swipes

    const isNavOverlayOpen = () => {
      try {
        return (
          document.documentElement.dataset.nav === "open" &&
          window.matchMedia &&
          window.matchMedia("(max-width: 920px)").matches
        );
      } catch {
        return false;
      }
    };

    const handleTouchStart = (event) => {
      if (!prevHref && !nextHref) return;
      if (isNavOverlayOpen()) return;
      if (isSwipeBlockedTarget(event.target)) return;
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (!touch) return;
      const x = touch.clientX;
      if (x <= EDGE_GUARD_PX || x >= window.innerWidth - EDGE_GUARD_PX) return;
      const sel = window.getSelection && window.getSelection();
      if (sel && sel.type === "Range") return;
      swipe.active = true;
      swipe.triggered = false;
      swipe.startX = x;
      swipe.startY = touch.clientY;
      swipe.lastX = x;
      swipe.lastY = touch.clientY;
    };

    const handleTouchMove = (event) => {
      if (!swipe.active) return;
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      swipe.lastX = touch.clientX;
      swipe.lastY = touch.clientY;
      const dx = swipe.lastX - swipe.startX;
      const dy = swipe.lastY - swipe.startY;
      if (!swipe.triggered) {
        if (Math.abs(dx) > 28 && Math.abs(dx) > Math.abs(dy) * 1.4) {
          swipe.triggered = true;
        } else if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
          swipe.active = false;
          return;
        }
      }
      if (swipe.triggered && event.cancelable) event.preventDefault();
    };

    const handleTouchEnd = () => {
      if (!swipe.active) return;
      const dx = swipe.lastX - swipe.startX;
      swipe.active = false;
      if (!swipe.triggered) return;
      swipe.triggered = false;
      if (Math.abs(dx) < 60) return;
      if (dx > 0) navigate("prev");
      else navigate("next");
    };

    content.addEventListener("touchstart", handleTouchStart, { passive: true });
    content.addEventListener("touchmove", handleTouchMove, { passive: false });
    content.addEventListener("touchend", handleTouchEnd);
    content.addEventListener("touchcancel", handleTouchEnd);

    // Trackpad horizontal swipe -> wheel deltaX.
    let wheelDx = 0;
    let wheelAt = 0;
    const WHEEL_WINDOW_MS = 180;
    const WHEEL_TRIGGER_PX = 140;
    const handleWheel = (event) => {
      if (!prevHref && !nextHref) return;
      if (isNavOverlayOpen()) return;
      if (event.ctrlKey) return;
      if (isSwipeBlockedTarget(event.target)) return;
      const dx = typeof event.deltaX === "number" ? event.deltaX : 0;
      const dy = typeof event.deltaY === "number" ? event.deltaY : 0;
      if (!dx) return;
      if (Math.abs(dx) < 8) return;
      if (Math.abs(dx) <= Math.abs(dy) * 1.4) return;
      const now = Date.now();
      if (!wheelAt || now - wheelAt > WHEEL_WINDOW_MS) wheelDx = 0;
      wheelAt = now;
      wheelDx += dx;
      if (Math.abs(wheelDx) >= WHEEL_TRIGGER_PX) {
        if (event.cancelable) event.preventDefault();
        // Natural scrolling: finger swipe left => deltaX positive. Mirror touch behavior.
        if (wheelDx > 0) navigate("next");
        else navigate("prev");
        wheelDx = 0;
      }
    };
    content.addEventListener("wheel", handleWheel, { passive: false });

    window.addEventListener("keydown", (event) => {
      if (event.defaultPrevented) return;
      if (isInteractiveTarget(event.target)) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        navigate("prev");
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        navigate("next");
      }
    });
  };

  window.addEventListener("DOMContentLoaded", () => {
    updateTopHeight();
    syncToggle();
    renderFontScale();
    const tts = makeTtsController();
    setupDocNavigation(tts);

    const toggle = document.getElementById("navToggle");
    const backdrop = document.getElementById("navBackdrop");
    const fontDown = document.getElementById("fontDown");
    const fontUp = document.getElementById("fontUp");
    const close = () => {
      setNav("collapsed");
      syncToggle();
    };
    const toggleNav = () => {
      const open = document.documentElement.dataset.nav !== "collapsed";
      setNav(open ? "collapsed" : "open");
      syncToggle();
    };

    if (toggle) toggle.addEventListener("click", toggleNav);
    if (backdrop) backdrop.addEventListener("click", close);
    if (fontDown) {
      fontDown.addEventListener("click", (event) => {
        event.preventDefault();
        applyFontScale(fontScale - FONT_STEP);
      });
    }
    if (fontUp) {
      fontUp.addEventListener("click", (event) => {
        event.preventDefault();
        applyFontScale(fontScale + FONT_STEP);
      });
    }
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close();
    });
    window.addEventListener("resize", () => {
      updateTopHeight();
      tts.sync();
    });
  });
})();
`.trim();

    const html = `<!doctype html>
<html lang="en" data-nav="open">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
	    <title>${escapeHtml(title)}</title>
	    <script nonce="${cspNonce}">${tasksScript}</script>
	    <style>
	      :root {
	        color-scheme: dark;
	        --bg: #0b0d12;
	        --panel: rgba(12, 15, 20, 0.92);
	        --border: rgba(255, 255, 255, 0.12);
	        --text: #e5e7eb;
	        --muted: rgba(229, 231, 235, 0.72);
	        --accent: #31d07c;
	        --link: #7dd3fc;
	        --code: rgba(0, 0, 0, 0.35);
	        --top-h: 56px;
	        --font-scale: 1;
	      }
      html, body { height: 100%; }
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji";
        background: var(--bg);
        color: var(--text);
      }
      a { color: var(--link); }
	      .top {
	        display: flex;
	        align-items: center;
	        gap: 12px;
	        padding: 12px 14px;
        border-bottom: 1px solid var(--border);
        background: rgba(255, 255, 255, 0.02);
      }
      .top h1 {
        margin: 0;
        font-size: 14px;
        letter-spacing: 0.02em;
        text-transform: uppercase;
        opacity: 0.9;
      }
      .tabs { display: inline-flex; align-items: center; gap: 8px; }
      .pill.tab.active { border-color: rgba(125, 211, 252, 0.55); background: rgba(125, 211, 252, 0.14); }
	      .top a.home {
	        color: inherit;
	        text-decoration: none;
	        padding: 8px 10px;
	        border: 1px solid var(--border);
	        border-radius: 10px;
	        background: rgba(255, 255, 255, 0.04);
	      }
	      .tools { display: inline-flex; align-items: center; gap: 8px; }
	      .toolLabel { font-size: 12px; color: var(--muted); min-width: 3ch; text-align: right; }
	      button.active { border-color: rgba(49, 208, 124, 0.5); background: rgba(49, 208, 124, 0.14); }
	      button:disabled { opacity: 0.5; cursor: not-allowed; }
	      .spacer { flex: 1; }
	      form.search { display: inline-flex; gap: 8px; align-items: center; }
      input[type="search"] {
        width: min(420px, 42vw);
        padding: 10px 12px;
        border-radius: 10px;
        border: 1px solid var(--border);
        background: rgba(255, 255, 255, 0.04);
        color: inherit;
        outline: none;
      }
      button {
        padding: 10px 12px;
        border-radius: 10px;
        border: 1px solid var(--border);
        background: rgba(255, 255, 255, 0.06);
        color: inherit;
        cursor: pointer;
      }
      .navToggle {
        padding: 8px 10px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        touch-action: manipulation;
      }
      .navToggleIcon { display: inline-flex; transition: transform 160ms ease; }
      html[data-nav="collapsed"] .navToggleIcon { transform: rotate(180deg); }
      .navToggle svg { width: 18px; height: 18px; }
      .wrap { display: flex; height: calc(100vh - var(--top-h, 56px)); min-height: 0; }
      .sidebar {
        width: 420px;
        max-width: 44vw;
        border-right: 1px solid var(--border);
        background: var(--panel);
        overflow: auto;
        transition: width 180ms ease, max-width 180ms ease, transform 180ms ease;
        will-change: width, max-width, transform;
        transform: translateX(0);
      }
      html[data-nav="collapsed"] .sidebar {
        width: 0;
        max-width: 0;
        border-right: 0;
        overflow: hidden;
        transform: translateX(-8px);
      }
      .backdrop { display: none; }
      @media (max-width: 920px) {
        .sidebar {
          position: fixed;
          top: var(--top-h, 56px);
          bottom: 0;
          left: 0;
          width: min(420px, 92vw);
          max-width: none;
          z-index: 10;
          transform: translateX(-105%);
        }
        html[data-nav="open"] .sidebar { transform: translateX(0); }
        html[data-nav="collapsed"] .sidebar {
          width: min(420px, 92vw);
          max-width: none;
          border-right: 1px solid var(--border);
          overflow: auto;
          transform: translateX(-105%);
        }
        .backdrop {
          display: block;
          position: fixed;
          top: var(--top-h, 56px);
          bottom: 0;
          left: 0;
          right: 0;
          background: rgba(0, 0, 0, 0.35);
          z-index: 9;
          opacity: 0;
          pointer-events: none;
          transition: opacity 180ms ease;
        }
        html[data-nav="open"] .backdrop {
          opacity: 1;
          pointer-events: auto;
        }
      }
      .content {
        flex: 1;
        min-width: 0;
        overflow: auto;
        padding: 18px 18px 40px 18px;
      }
      .content[data-enter="next"] { animation: docEnterFromRight 220ms ease-out both; }
      .content[data-enter="prev"] { animation: docEnterFromLeft 220ms ease-out both; }
      .content[data-exit="next"] { animation: docExitToLeft 170ms ease-in both; }
      .content[data-exit="prev"] { animation: docExitToRight 170ms ease-in both; }
      @keyframes docEnterFromRight { from { transform: translateX(18px); opacity: 0.35; } to { transform: translateX(0); opacity: 1; } }
      @keyframes docEnterFromLeft { from { transform: translateX(-18px); opacity: 0.35; } to { transform: translateX(0); opacity: 1; } }
      @keyframes docExitToLeft { from { transform: translateX(0); opacity: 1; } to { transform: translateX(-14px); opacity: 0.2; } }
      @keyframes docExitToRight { from { transform: translateX(0); opacity: 1; } to { transform: translateX(14px); opacity: 0.2; } }
      @media (prefers-reduced-motion: reduce) {
        .content[data-enter], .content[data-exit] { animation: none !important; }
      }
	      .summary {
	        padding: 10px 12px;
	        border-bottom: 1px solid var(--border);
	        color: var(--muted);
	        font-size: calc(12px * var(--font-scale));
	        display: flex;
	        gap: 10px;
	        flex-wrap: wrap;
	      }
      .item {
        display: block;
        padding: 10px 12px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        text-decoration: none;
        color: inherit;
      }
      .item:hover { background: rgba(255, 255, 255, 0.04); }
      .item.active {
        background: rgba(49, 208, 124, 0.12);
        box-shadow: inset 3px 0 0 0 var(--accent);
      }
	      .itemPath { font-size: calc(13px * var(--font-scale)); line-height: 1.35; word-break: break-word; }
	      .itemMeta {
	        margin-top: 6px;
	        display: flex;
	        gap: 10px;
	        flex-wrap: wrap;
	        font-size: calc(11px * var(--font-scale));
	        color: var(--muted);
	      }
	      .empty { padding: 12px; color: var(--muted); font-size: calc(12px * var(--font-scale)); }
	      .notice {
	        border: 1px solid var(--border);
	        background: rgba(255, 255, 255, 0.04);
	        border-radius: 14px;
	        padding: 14px 14px;
	        color: var(--muted);
	        font-size: calc(14px * var(--font-scale));
	      }
	      .notice.error { border-color: rgba(255, 107, 107, 0.45); background: rgba(255, 107, 107, 0.08); color: #ffd7d7; }
	      .docHeader { margin-bottom: 14px; }
	      .docTitle { font-size: calc(16px * var(--font-scale)); font-weight: 650; margin-bottom: 8px; word-break: break-word; }
	      .docMeta {
	        display: flex;
	        gap: 10px;
	        flex-wrap: wrap;
	        font-size: calc(12px * var(--font-scale));
	        color: var(--muted);
	        align-items: center;
	      }
        .docNav { display: inline-flex; gap: 8px; align-items: center; }
        .pill.nav { font-size: calc(12px * var(--font-scale)); }
        .pill.nav.disabled { opacity: 0.45; pointer-events: none; }
      .pill {
        display: inline-flex;
        align-items: center;
        padding: 4px 10px;
        border-radius: 999px;
        border: 1px solid var(--border);
        background: rgba(255, 255, 255, 0.04);
        color: inherit;
        text-decoration: none;
      }
	      .markdown { font-size: calc(14px * var(--font-scale)); }
	      .markdown :is(h1,h2,h3) { margin: 18px 0 10px; }
	      .markdown h1 { font-size: calc(22px * var(--font-scale)); }
	      .markdown h2 { font-size: calc(18px * var(--font-scale)); }
	      .markdown h3 { font-size: calc(15px * var(--font-scale)); }
	      .markdown p { line-height: 1.55; }
      .markdown pre {
        background: var(--code);
        border: 1px solid rgba(255, 255, 255, 0.1);
        padding: 12px;
        border-radius: 12px;
        overflow: auto;
      }
      .markdown code {
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.08);
        padding: 1px 6px;
        border-radius: 8px;
      }
      .markdown pre code { background: transparent; border: 0; padding: 0; }
      .markdown blockquote {
        margin: 12px 0;
        padding: 6px 12px;
        border-left: 3px solid rgba(255, 255, 255, 0.2);
        color: var(--muted);
      }
      .markdown table { border-collapse: collapse; }
      .markdown th, .markdown td { border: 1px solid rgba(255, 255, 255, 0.12); padding: 6px 8px; }
      .docHtmlFrame {
        width: 100%;
        min-height: 72vh;
        border: 1px solid var(--border);
        border-radius: 14px;
        background: #ffffff;
      }
    </style>
  </head>
	  <body>
	    <div class="top">
      <button
        class="navToggle"
        type="button"
        id="navToggle"
        aria-label="Toggle task list"
        aria-expanded="true"
        title="Toggle task list"
      >
        <span class="navToggleIcon" aria-hidden="true">
          <svg viewBox="0 0 24 24" role="img" focusable="false">
            <path
              d="M15 6l-6 6 6 6"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </span>
	      </button>
	      <h1>${escapeHtml(title)}</h1>
        ${tabsHtml}
	      <div class="spacer"></div>
	      <div class="tools" aria-label="Reader controls">
	        <button class="navToggle" type="button" id="fontDown" aria-label="Decrease font size" title="Smaller text">
	          A-
	        </button>
	        <button class="navToggle" type="button" id="fontUp" aria-label="Increase font size" title="Larger text">
	          A+
	        </button>
	        <span class="toolLabel" id="fontPct" aria-hidden="true"></span>
	        <button class="navToggle" type="button" id="ttsToggle" aria-label="Read note aloud" title="Read note aloud">
	          Read
	        </button>
	      </div>
	      <form class="search" method="get" action="">
          <input type="hidden" name="lib" value="${escapeHtml(lib || "tasks")}" />
	        <input type="search" name="q" placeholder="Filter (path contains…)" value="${escapeHtml(q)}" />
	        <button type="submit">Filter</button>
	      </form>
	    </div>
    <div class="backdrop" id="navBackdrop" aria-hidden="true"></div>
    <div class="wrap">
      <aside class="sidebar">
        <div class="summary">
          <span>root ${escapeHtml(rootLabel)}</span>
          <span>${escapeHtml(String(items.length))} shown</span>
          <span>${escapeHtml(String(allItems.length))} total</span>
          <span>sorted by day folder, then created</span>
        </div>
        ${listHtml}
      </aside>
      <main class="content">
        ${contentHtml}
      </main>
    </div>
  </body>
</html>`;

    res.status(status).type("text/html").send(html);
  });

  router.get("/tasks/raw", (req, res) => {
    const lib = parseMarkdownLibraryKey((req as any).query?.lib);
    const fileRaw = firstQueryValue((req as any).query?.file).trim();
    const rootDir = lib ? markdownLibraryRoots[lib] : markdownLibraryRoots.tasks;
    const allowedExts = lib ? markdownLibraryExts[lib] : markdownLibraryExts.tasks;
    const abs = lib && fileRaw ? resolveDocFileAbs(rootDir, fileRaw, allowedExts) : null;
    if (!abs) {
      res.setHeader("Cache-Control", "no-store");
      res.status(400).type("text/plain").send("invalid_file");
      return;
    }
    try {
      const ext = normalizeDocExt(abs);
      const raw = fs.readFileSync(abs, "utf8");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (ext === "html" || ext === "htm") {
        // HTML assets are rendered in an iframe with sandboxing. Still set a strict CSP for defense-in-depth.
        res.setHeader(
          "Content-Security-Policy",
          "default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'; sandbox; base-uri 'none'; form-action 'none'"
        );
        res.status(200).type("text/html").send(raw);
      } else {
        res.status(200).type("text/plain").send(raw);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.setHeader("Cache-Control", "no-store");
      res.status(404).type("text/plain").send(message || "not_found");
    }
  });

  // JSON error handler for API routes (avoid HTML error pages).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  router.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    let status = (err as any)?.statusCode ?? (err as any)?.status ?? 500;
    let message = err instanceof Error ? err.message : "error";

    if (err instanceof z.ZodError) {
      status = 400;
      message = "invalid_request";
    }

    if (status === 500 && err instanceof Error) {
      if (message === "Not found") status = 404;
      else if (message.startsWith("Mode disabled:")) status = 403;
      else if (message.startsWith("Session limit exceeded")) status = 429;
      else if (message.startsWith("Invalid tmux")) status = 400;
      else if (message.includes("requires") || message.includes("must")) status = 400;
    }

    if (req.path.startsWith("/api")) {
      (res.locals as any).apiError = message;
      res.status(status).json({ error: message });
      return;
    }
    res.status(status).type("text/plain").send("error");
  });

  const rewriteAssetPaths = (html: string, base: string) => {
    if (!base) return html;
    return html
      .replace(/src="\/assets\//g, `src="${base}/assets/`)
      .replace(/href="\/assets\//g, `href="${base}/assets/`)
      .replace(/src="\/chat\/assets\//g, `src="${base}/chat/assets/`)
      .replace(/href="\/chat\/assets\//g, `href="${base}/chat/assets/`);
  };

  const injectBasePath = (html: string, base: string) => {
    if (!base) return html;
    if (html.includes("window.__CONSOLE_BASE_PATH__")) return html;
    const snippet = `<script>window.__CONSOLE_BASE_PATH__=${JSON.stringify(base)};</script>`;
    if (html.includes("</head>")) return html.replace("</head>", `${snippet}</head>`);
    return `${snippet}${html}`;
  };

  // Serve chat UI if present (at /chat path).
  const chatUiDist = path.resolve(opts.uiDist ? opts.uiDist.replace("/ui/", "/ui-chat/").replace("/ui-chat/", "/ui-chat/") : "console-terminal/ui-chat/dist");
  const chatUiIndex = path.join(chatUiDist, "index.html");
  if (fs.existsSync(chatUiIndex)) {
    const getChatRenderedIndex = (() => {
      let cachedMtimeMs = -1;
      let cachedHtml = "";
      return () => {
        try {
          const stat = fs.statSync(chatUiIndex);
          if (stat.mtimeMs !== cachedMtimeMs) {
            const rawIndex = fs.readFileSync(chatUiIndex, "utf8");
            cachedHtml = injectBasePath(rewriteAssetPaths(rawIndex, basePath), basePath);
            cachedMtimeMs = stat.mtimeMs;
          }
        } catch {
          // If the UI is being rebuilt, keep serving the last-good HTML.
        }
        return cachedHtml;
      };
    })();

    const serveChatIndex = (_req: express.Request, res: express.Response) => {
      res.setHeader("Cache-Control", "no-store");
      res.status(200).type("text/html").send(getChatRenderedIndex());
    };

    // Chat UI entry points
    router.get("/chat", serveChatIndex);
    router.get("/chat/", serveChatIndex);
    router.get("/chat/index.html", serveChatIndex);

    // Chat UI static assets
    router.use(
      "/chat/assets",
      express.static(path.join(chatUiDist, "assets"), {
        fallthrough: false
      })
    );
    router.use(
      "/chat",
      express.static(chatUiDist, {
        index: false
      })
    );
  }

  // Serve built UI if present (use Vite dev server in development).
  const uiDist = path.resolve(opts.uiDist || "console-terminal/ui/dist");
  const uiIndex = path.join(uiDist, "index.html");
  if (fs.existsSync(uiIndex)) {
    router.use("/uploads", express.static(uploadDir));
    // Shared SVG icon library (used by multiple UIs in this repo).
    const svgAssetsDir = path.resolve("svg-buttons-assets");
    if (fs.existsSync(svgAssetsDir)) {
      router.use(
        "/svg-buttons-assets",
        express.static(svgAssetsDir, {
          fallthrough: false
        })
      );
    }
    const svgVariantsDir = path.resolve("svg-buttons-variants");
    if (fs.existsSync(svgVariantsDir)) {
      router.use(
        "/svg-buttons-variants",
        express.static(svgVariantsDir, {
          fallthrough: false
        })
      );
    }
    const getRenderedIndex = (() => {
      let cachedMtimeMs = -1;
      let cachedHtml = "";
      return () => {
        try {
          const stat = fs.statSync(uiIndex);
          if (stat.mtimeMs !== cachedMtimeMs) {
            const rawIndex = fs.readFileSync(uiIndex, "utf8");
            cachedHtml = injectBasePath(rewriteAssetPaths(rawIndex, basePath), basePath);
            cachedMtimeMs = stat.mtimeMs;
          }
        } catch {
          // If the UI is being rebuilt, keep serving the last-good HTML.
        }
        return cachedHtml;
      };
    })();

    const serveIndex = (_req: express.Request, res: express.Response) => {
      // Never cache HTML entrypoints. Static assets are hashed and may be cached separately.
      res.setHeader("Cache-Control", "no-store");
      res.status(200).type("text/html").send(getRenderedIndex());
    };

    // Entry points.
    router.get("/", serveIndex);
    router.get("/index.html", serveIndex);

    // Static assets. Do not allow SPA fallback to swallow missing assets and return HTML.
    router.use(
      "/assets",
      express.static(path.join(uiDist, "assets"), {
        fallthrough: false
      })
    );
    router.use(
      express.static(uiDist, {
        index: false
      })
    );

    const shouldServeSpa = (req: express.Request) => {
      const pathname = req.path || "/";
      if (
        pathname.startsWith("/api") ||
        pathname.startsWith("/ws") ||
        pathname.startsWith("/uploads") ||
        pathname.startsWith("/assets") ||
        pathname.startsWith("/chat") ||
        pathname.startsWith("/svg-buttons-assets") ||
        pathname.startsWith("/svg-buttons-variants")
      )
        return false;
      // If it looks like a file request (has an extension), don't serve HTML.
      if (path.extname(pathname)) return false;

      // Only serve the SPA shell when the client accepts HTML.
      const accept = req.headers.accept;
      if (typeof accept === "string" && accept.length > 0) {
        if (!accept.includes("text/html") && !accept.includes("*/*")) return false;
      }
      return true;
    };

    router.get(/.*/, (req, res, next) => {
      if (!shouldServeSpa(req)) return next();
      return serveIndex(req, res);
    });
  } else {
    router.get("/", (_req, res) => {
      res
        .status(200)
        .type("text/plain")
        .send(
          "console-terminal UI not built.\n\nBuild it with:\n  npm run build:console:ui\n\nOr run the UI dev server:\n  npm run dev:console:ui\n"
        );
    });
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxWsMessageBytes });
  const ttsWss = new WebSocketServer({ noServer: true, maxPayload: config.maxWsMessageBytes });
  const sttWss = new WebSocketServer({ noServer: true, maxPayload: config.maxWsMessageBytes });
  const chatWss = new WebSocketServer({ noServer: true, maxPayload: config.maxWsMessageBytes });
  const wsPrefix = withBase(basePath, "/ws/sessions/");
  const ttsPrefix = withBase(basePath, "/ws/tts/");
  const sttPrefix = withBase(basePath, "/ws/stt/");
  const chatPrefix = withBase(basePath, "/ws/chat/sessions/");
  const codexPrefix = withBase(basePath, "/ws/codex/exec");
  const codexWss = new WebSocketServer({ noServer: true, maxPayload: config.maxWsMessageBytes });

  // Chat session manager for stream shaping
  const chatManager = new ChatSessionManager(manager);

  // Wire up the chat output handler
  chatOutputHandler = (sessionId: string, data: string) => {
    chatManager.processOutput(sessionId, data);
  };
  chatExitHandler = (sessionId: string, exitCode: number | null, signal: number | null) => {
    chatManager.processExit(sessionId, exitCode, signal);
  };
  chatCloseHandler = (sessionId: string) => {
    chatManager.closeSession(sessionId);
  };

  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = req.url;
    if (!url) return false;
    const parsedUrl = new URL(url, "http://localhost");
    const pathname = parsedUrl.pathname;
    const logWs = (message: string, data?: Record<string, unknown>) => {
      if (!debugWs) return;
      if (data) {
        console.log(message, data);
        return;
      }
      console.log(message);
    };

    logWs("[ws] upgrade request", {
      method: req.method,
      url,
      pathname,
      hasProtocol: typeof req.headers["sec-websocket-protocol"] === "string",
      protocolLen:
        typeof req.headers["sec-websocket-protocol"] === "string"
          ? req.headers["sec-websocket-protocol"].length
          : undefined,
      hasAccessJwt: typeof req.headers["cf-access-jwt-assertion"] === "string",
      hasAccessUser: typeof req.headers["cf-access-authenticated-user-id"] === "string",
      hasAccessEmail: typeof req.headers["cf-access-authenticated-user-email"] === "string",
      hasAccessClientId: typeof req.headers["cf-access-client-id"] === "string",
      hasAccessClientSecret: typeof req.headers["cf-access-client-secret"] === "string",
      hasCookie: typeof req.headers["cookie"] === "string",
      origin: req.headers.origin,
      cfRay: req.headers["cf-ray"],
      cfConnectingIp: req.headers["cf-connecting-ip"],
      xForwardedFor: req.headers["x-forwarded-for"]
    });
    if (
      !pathname.startsWith(wsPrefix) &&
      !pathname.startsWith(ttsPrefix) &&
      !pathname.startsWith(sttPrefix) &&
      !pathname.startsWith(chatPrefix) &&
      pathname !== codexPrefix
    )
      return false;

    void (async () => {
      try {
        if (requireBasicAuth) {
          verifyBasicAuth(req.headers, config.basicAuthUser!, config.basicAuthPass!);
        }
        if (pathname.startsWith(wsPrefix)) {
          let user: { userId: string; email?: string } | null = null;
          let accessError: unknown;
          try {
            user = await accessVerifier(req.headers);
          } catch (err) {
            accessError = err;
          }

          // Attach token is provided via Sec-WebSocket-Protocol or query string.
          const protoHeader = req.headers["sec-websocket-protocol"];
          let token = typeof protoHeader === "string" ? protoHeader.split(",")[0]?.trim() : undefined;
          if (!token) {
            const queryToken = parsedUrl.searchParams.get("attachToken");
            if (queryToken) token = queryToken;
          }
          if (!token) throw new Error("Missing attach token");

          const record = manager.consumeAttachToken(token);
          if (user && record.userId !== user.userId) throw new Error("Attach token user mismatch");
          if (!user) {
            logWs("[ws] access fallback (no access headers)", {
              error: accessError instanceof Error ? accessError.message : "unknown"
            });
            user = { userId: record.userId };
          }

          const sessionId = pathname.split("/").pop()!;
          if (sessionId !== record.sessionId) throw new Error("Attach token session mismatch");
          if (typeof record.cols === "number" && typeof record.rows === "number") {
            try {
              manager.resize(user.userId, sessionId, record.cols, record.rows);
            } catch {
              // ignore resize failures
            }
          }

          wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, { sessionId, user });
          });
          return;
        }

        if (pathname.startsWith(chatPrefix)) {
          let user: { userId: string; email?: string } | null = null;
          let accessError: unknown;
          try {
            user = await accessVerifier(req.headers);
          } catch (err) {
            accessError = err;
          }

          // Attach token is provided via Sec-WebSocket-Protocol or query string.
          const protoHeader = req.headers["sec-websocket-protocol"];
          let token = typeof protoHeader === "string" ? protoHeader.split(",")[0]?.trim() : undefined;
          if (!token) {
            const queryToken = parsedUrl.searchParams.get("attachToken");
            if (queryToken) token = queryToken;
          }
          if (!token) throw new Error("Missing attach token");

          const record = manager.consumeAttachToken(token);
          if (user && record.userId !== user.userId) throw new Error("Attach token user mismatch");
          if (!user) {
            logWs("[chat-ws] access fallback (no access headers)", {
              error: accessError instanceof Error ? accessError.message : "unknown"
            });
            user = { userId: record.userId };
          }

          const sessionId = pathname.split("/").pop()!;
          if (sessionId !== record.sessionId) throw new Error("Attach token session mismatch");
          if (typeof record.cols === "number" && typeof record.rows === "number") {
            try {
              manager.resize(user.userId, sessionId, record.cols, record.rows);
            } catch {
              // ignore resize failures
            }
          }

          const rawAfterSeq = parsedUrl.searchParams.get("afterSeq");
          const afterSeq = rawAfterSeq ? Number(rawAfterSeq) : undefined;
          const safeAfterSeq = Number.isFinite(afterSeq) && (afterSeq as number) > 0 ? (afterSeq as number) : 0;

          chatWss.handleUpgrade(req, socket, head, (ws) => {
            chatWss.emit("connection", ws, { sessionId, user, afterSeq: safeAfterSeq });
          });
          return;
        }

        const user = await accessVerifier(req.headers);

        if (pathname.startsWith(ttsPrefix)) {
          const sessionId = pathname.split("/").pop()!;
          manager.assertSessionOwner(user.userId, sessionId);
          ttsWss.handleUpgrade(req, socket, head, (ws) => {
            ttsWss.emit("connection", ws, { sessionId, user });
          });
          return;
        }

        if (pathname.startsWith(sttPrefix)) {
          const sessionId = pathname.split("/").pop()!;
          manager.assertSessionOwner(user.userId, sessionId);
          sttWss.handleUpgrade(req, socket, head, (ws) => {
            sttWss.emit("connection", ws, { sessionId, user });
          });
          return;
        }

        codexWss.handleUpgrade(req, socket, head, (ws) => {
          codexWss.emit("connection", ws, { user });
        });
      } catch (err) {
        logWs("[ws] upgrade failed", {
          error: err instanceof Error ? err.message : "unknown"
        });
        try {
          socket.destroy();
        } catch {
          // ignore
        }
      }
    })();

    return true;
  };

  const HEARTBEAT_MS = 25_000;
  const heartbeatInterval = setInterval(() => {
    for (const ws of wss.clients) {
      const anyWs = ws as any;
      if (anyWs.isAlive === false) {
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        continue;
      }
      anyWs.isAlive = false;
      try {
        ws.ping();
      } catch {
        // ignore
      }
    }
  }, HEARTBEAT_MS);

  wss.on("connection", (ws, ctx: any) => {
    const { sessionId, user } = ctx as { sessionId: string; user: { userId: string; email?: string } };
    const anyWs = ws as any;
    anyWs.isAlive = true;
    ws.on("pong", () => {
      anyWs.isAlive = true;
    });

    if (debugWs) {
      console.log("[ws] connection open", { sessionId, userId: user.userId, pid: process.pid });
      ws.on("error", (err) => {
        console.log("[ws] connection error", { sessionId, message: err instanceof Error ? err.message : "unknown" });
      });
      ws.on("close", (code, reason) => {
        const reasonText = Buffer.isBuffer(reason) ? reason.toString() : String(reason ?? "");
        console.log("[ws] connection close", { sessionId, code, reason: reasonText, pid: process.pid });
      });
    }

    try {
      ws.send(JSON.stringify({ type: "hello", at: Date.now() }));
    } catch {
      // ignore
    }

    void manager
      .attachWithSnapshot(sessionId, ws)
      .then(() => {
        audit.log({ type: "session_attach", at: new Date().toISOString(), userId: user.userId, sessionId });
      })
      .catch((err) => {
        if (debugWs) {
          console.log("[ws] attach failed", {
            sessionId,
            error: err instanceof Error ? err.message : "unknown"
          });
        }
        try {
          ws.close();
        } catch {
          // ignore
        }
      });

    ws.on("message", (data, isBinary) => {
      try {
        if (isBinary) {
          manager.write(sessionId, Buffer.from(data as any));
          return;
        }

        const text = data.toString();
        const msg = JSON.parse(text);
        if (msg?.type === "resize") {
          const cols = Number(msg.cols);
          const rows = Number(msg.rows);
          if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
          if (cols < 10 || cols > 500 || rows < 5 || rows > 300) return;
          manager.resize(user.userId, sessionId, cols, rows);
          audit.log({
            type: "session_resize",
            at: new Date().toISOString(),
            userId: user.userId,
            sessionId,
            cols,
            rows
          });
        }
      } catch {
        // ignore malformed frames
      }
    });

    ws.on("close", () => {
      manager.detach(sessionId, ws);
      audit.log({ type: "session_detach", at: new Date().toISOString(), userId: user.userId, sessionId });
    });
  });

  ttsWss.on("connection", (ws, ctx: any) => {
    const { sessionId, user } = ctx as { sessionId: string; user: { userId: string; email?: string } };
    ttsManager.attach(sessionId, ws, user.userId);
  });

  sttWss.on("connection", (ws, ctx: any) => {
    const { sessionId, user } = ctx as { sessionId: string; user: { userId: string; email?: string } };
    sttManager.attach(sessionId, ws, user);
  });

  // Chat WebSocket connection handler
  chatWss.on("connection", (ws, ctx: any) => {
    const { sessionId, user, afterSeq } = ctx as {
      sessionId: string;
      user: { userId: string; email?: string };
      afterSeq?: number;
    };
    const anyWs = ws as any;
    anyWs.isAlive = true;
    ws.on("pong", () => {
      anyWs.isAlive = true;
    });

    if (debugWs) {
      console.log("[chat-ws] connection open", { sessionId, userId: user.userId, pid: process.pid });
    }

    // Get session and attach with shaper
    try {
      const session = manager.assertSessionOwner(user.userId, sessionId);
      chatManager.attachWithShaper(sessionId, ws, user.userId, session, afterSeq);
      audit.log({ type: "chat_attach", at: new Date().toISOString(), userId: user.userId, sessionId });
    } catch (err) {
      if (debugWs) {
        console.log("[chat-ws] attach failed", {
          sessionId,
          error: err instanceof Error ? err.message : "unknown"
        });
      }
      try {
        ws.close();
      } catch {
        // ignore
      }
      return;
    }

    // Handle incoming messages (user input)
    ws.on("message", (data, isBinary) => {
      try {
        if (isBinary) {
          // Binary input goes directly to PTY
          manager.write(sessionId, Buffer.from(data as any));
          // Also notify chat manager for display
          const text = Buffer.from(data as any).toString("utf8");
          chatManager.processUserInput(sessionId, text);
          return;
        }

        // JSON messages (resize, etc.)
        const text = data.toString();
        const msg = JSON.parse(text);
        if (msg?.type === "user_input" && typeof msg.text === "string") {
          const input = msg.text;
          const messageId = typeof msg.messageId === "string" ? msg.messageId : undefined;
          const enter = msg.enter !== false;
          const payload = enter ? `${input}\n` : input;
          manager.write(sessionId, Buffer.from(payload, "utf8"));
          chatManager.processUserInput(sessionId, input, messageId);
          return;
        }
        if (msg?.type === "resize") {
          const cols = Number(msg.cols);
          const rows = Number(msg.rows);
          if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
          if (cols < 10 || cols > 500 || rows < 5 || rows > 300) return;
          manager.resize(user.userId, sessionId, cols, rows);
        }
      } catch {
        // ignore malformed frames
      }
    });

    ws.on("close", () => {
      audit.log({ type: "chat_detach", at: new Date().toISOString(), userId: user.userId, sessionId });
    });
  });

  const CodexStartBody = z.object({
    type: z.literal("start"),
    prompt: z.string().min(1).max(16_000),
    model: z.string().optional(),
    sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
    fullAuto: z.boolean().optional(),
    images: z.array(z.string().min(1).max(4096)).max(5).optional()
  });

  const CodexCancelBody = z.object({
    type: z.literal("cancel")
  });

  codexWss.on("connection", (ws, ctx: any) => {
    const { user } = ctx as { user: { userId: string; email?: string } };
    let child: ReturnType<typeof spawn> | null = null;

    const send = (payload: any) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
    };

    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const text = data.toString();
      try {
        const raw = JSON.parse(text);
        if (raw?.type === "cancel") {
          if (child) {
            child.kill("SIGTERM");
          }
          return;
        }

        const body = CodexStartBody.parse(raw);
        if (!config.enableCodexExec) {
          send({ type: "error", message: "Codex exec is disabled on this server." });
          return;
        }
        if (child) {
          send({ type: "error", message: "Codex exec already running." });
          return;
        }

        const args: string[] = ["exec"];
        const requestedSandbox = body.sandbox ?? "read-only";
        const sandboxAllowed =
          requestedSandbox !== "danger-full-access" || config.codexExecAllowDanger;
        if (!sandboxAllowed) {
          send({ type: "error", message: "danger-full-access is disabled on this server." });
          return;
        }
        if (body.fullAuto && !config.codexExecAllowFullAuto) {
          send({ type: "error", message: "full-auto is disabled on this server." });
          return;
        }

        if (body.fullAuto) {
          args.push("--full-auto");
        } else {
          args.push("--sandbox", requestedSandbox);
        }
        if (body.model) {
          args.push("--model", body.model);
        }

        args.push("--cd", codexExecCwd);
        args.push("--skip-git-repo-check");
        args.push(body.prompt);

        send({ type: "status", message: "Starting codex exec…" });
        child = spawn("codex", args, {
          cwd: codexExecCwd,
          env: process.env
        });

        child.stdout?.on("data", (chunk) => {
          send({ type: "stdout", data: chunk.toString() });
        });
        child.stderr?.on("data", (chunk) => {
          send({ type: "stderr", data: chunk.toString() });
        });
        child.on("error", (err) => {
          send({ type: "error", message: err.message });
        });
        child.on("close", (code, signal) => {
          send({ type: "exit", code, signal });
          child = null;
        });
      } catch (err: any) {
        if (err instanceof z.ZodError) {
          send({ type: "error", message: "Invalid request." });
        } else {
          send({ type: "error", message: err?.message || "Error" });
        }
      }
    });

    ws.on("close", () => {
      if (child) {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
        child = null;
      }
    });
  });

  const shutdown = () => {
    clearInterval(heartbeatInterval);
    chatManager.shutdown();
    manager.shutdown();
    audit.close();
  };

  return { router, handleUpgrade, shutdown, config, basePath };
}
