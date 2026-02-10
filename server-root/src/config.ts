import path from "node:path";
import { z } from "zod";

const BoolEnv = z.preprocess(
  (v) => {
    if (typeof v !== "string") return v;
    const normalized = v.trim().toLowerCase();
    if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on")
      return true;
    if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off")
      return false;
    return v;
  },
  z.boolean()
);

const UrlEnv = z
  .string()
  .url()
  .transform((v) => v.replace(/\/+$/, ""));

const DEFAULT_WHISPER_BIN = path.resolve(process.cwd(), "transcribe/whisper_cpp/bin/whisper-cli");
const DEFAULT_WHISPER_MODEL = path.resolve(
  process.cwd(),
  "transcribe/whisper_cpp/models/ggml-large-v3.bin"
);

const ConfigSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.coerce.number().int().min(1).max(65535).default(8080),

  authMode: z.enum(["cloudflare", "none"]).default("cloudflare"),
  cfAccessIssuer: UrlEnv.optional(),
  cfAccessAud: z.string().optional(),

  basicAuthUser: z.string().optional(),
  basicAuthPass: z.string().optional(),

  requireAppToken: BoolEnv.default(false),
  appToken: z.string().optional(),

  enableShell: BoolEnv.default(false),
  enableNode: BoolEnv.default(true),
  enableReadonlyTail: BoolEnv.default(false),
  enableTmux: BoolEnv.default(false),
  enableMacosTerminalLaunch: BoolEnv.default(false),
  macosTerminalLaunchOnTmuxCreate: BoolEnv.default(false),
  macosTerminalApp: z.string().default("Terminal"),
  enableCodexExec: BoolEnv.default(false),
  codexExecAllowFullAuto: BoolEnv.default(false),
  codexExecAllowDanger: BoolEnv.default(false),
  codexExecCwd: z.string().optional(),
  enableAppletsStackRestart: BoolEnv.default(false),
  appletsStackTmuxSession: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, "Invalid tmux session name")
    .default("applets_stack"),
  appletsStackCwd: z.string().optional(),
  appletsStackKeepTunnel: BoolEnv.default(true),

  enableAiNaming: BoolEnv.default(false),
  aiModel: z.string().default("gpt-4o-mini"),
  aiOpenAiApiKey: z.string().optional(),
  aiOpenAiBaseUrl: UrlEnv.default("https://api.openai.com"),
  aiTimeoutMs: z.coerce.number().int().min(1_000).max(120_000).default(12_000),

  tmuxPrefix: z.string().default("console"),
  tmuxSessionScope: z.enum(["user", "all"]).default("all"),
  tmuxManagedMouse: z.enum(["inherit", "off", "on"]).default("inherit"),

  defaultShell: z.string().default("/bin/zsh"),
  defaultCwd: z.string().default(process.env.HOME || "/tmp"),

  attachTokenTtlMs: z.coerce.number().int().min(5_000).default(60_000),
  detachGraceMs: z.coerce.number().int().min(0).default(5 * 60_000),
  idleTimeoutMs: z.coerce.number().int().min(0).default(60 * 60_000),
  maxSessionsPerUser: z.coerce.number().int().min(1).default(12),
  maxWsMessageBytes: z.coerce.number().int().min(1_024).default(1024 * 1024),

  auditLogPath: z.string().default("logs/console-audit.jsonl"),
  prefsPath: z.string().default("logs/console-user-prefs.json"),

  ttsEnabled: BoolEnv.default(false),
  ttsEngine: z.enum(["openai", "piper"]).default("openai"),
  ttsModel: z.string().default("gpt-4o-mini-tts"),
  ttsVoice: z.string().default("coral"),
  ttsMaxChunkChars: z.coerce.number().int().min(40).max(1000).default(220),
  ttsMaxQueueDepth: z.coerce.number().int().min(1).max(200).default(40),
  ttsOpenAiApiKey: z.string().optional(),
  ttsOpenAiBaseUrl: UrlEnv.default("https://api.openai.com"),
  ttsPiperBin: z.string().optional(),
  ttsPiperModel: z.string().optional(),
  ttsPiperConfig: z.string().optional(),

  sttEnabled: BoolEnv.default(false),
  sttEngine: z.enum(["cpp", "openai"]).default("cpp"),
  sttModel: z.string().default("ggml-large-v3.bin"),
  sttLang: z.string().default("auto"),
  sttWhisperCppBin: z.string().default(DEFAULT_WHISPER_BIN),
  sttWhisperCppModel: z.string().default(DEFAULT_WHISPER_MODEL),
  sttMinAudioBytes: z.coerce.number().int().min(4_000).default(48_000),
  sttEnergyThreshold: z.coerce.number().min(0).default(350),
  sttWindowBytes: z.coerce.number().int().min(0).default(64_000),
  sttOverlapBytes: z.coerce.number().int().min(0).default(16_000),
  sttFinalizeMs: z.coerce.number().int().min(200).max(5000).default(900),
  sttDebug: BoolEnv.default(false),
  sttOpenAiApiKey: z.string().optional(),
  sttOpenAiBaseUrl: UrlEnv.default("https://api.openai.com")
});

export type ConsoleConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConsoleConfig {
  const inferredTtsEnabled = (() => {
    // If explicitly set, honor CONSOLE_TTS_ENABLE (including "0").
    if (typeof env.CONSOLE_TTS_ENABLE === "string") return env.CONSOLE_TTS_ENABLE;
    // Otherwise, default-on only when at least one engine is configured.
    const openAiKey = String(env.CONSOLE_TTS_OPENAI_API_KEY ?? env.OPENAI_API_KEY ?? "").trim();
    const piperBin = String(env.CONSOLE_TTS_PIPER_BIN ?? "").trim();
    const piperModel = String(env.CONSOLE_TTS_PIPER_MODEL ?? "").trim();
    return Boolean(openAiKey || (piperBin && piperModel));
  })();

  const parsed = ConfigSchema.parse({
    host: env.CONSOLE_HOST,
    port: env.CONSOLE_PORT,

    authMode: env.CONSOLE_AUTH_MODE,
    cfAccessIssuer: env.CF_ACCESS_ISSUER,
    cfAccessAud: env.CF_ACCESS_AUD,

    basicAuthUser: env.CONSOLE_BASIC_AUTH_USER,
    basicAuthPass: env.CONSOLE_BASIC_AUTH_PASS,

    requireAppToken: env.CONSOLE_REQUIRE_APP_TOKEN,
    appToken: env.CONSOLE_APP_TOKEN,

    enableShell: env.CONSOLE_ENABLE_SHELL,
    enableNode: env.CONSOLE_ENABLE_NODE,
    enableReadonlyTail: env.CONSOLE_ENABLE_READONLY_TAIL,
    enableTmux: env.CONSOLE_ENABLE_TMUX,
    enableMacosTerminalLaunch: env.CONSOLE_ENABLE_MACOS_TERMINAL_LAUNCH,
    macosTerminalLaunchOnTmuxCreate: env.CONSOLE_MACOS_TERMINAL_LAUNCH_ON_TMUX_CREATE,
    macosTerminalApp: env.CONSOLE_MACOS_TERMINAL_APP,
    enableCodexExec: env.CONSOLE_ENABLE_CODEX_EXEC,
    codexExecAllowFullAuto: env.CONSOLE_CODEX_ALLOW_FULL_AUTO,
    codexExecAllowDanger: env.CONSOLE_CODEX_ALLOW_DANGER,
    codexExecCwd: env.CONSOLE_CODEX_CWD,
    enableAppletsStackRestart: env.CONSOLE_ENABLE_APPLETS_STACK_RESTART,
    appletsStackTmuxSession: env.CONSOLE_APPLETS_STACK_TMUX_SESSION,
    appletsStackCwd: env.CONSOLE_APPLETS_STACK_CWD,
    appletsStackKeepTunnel: env.CONSOLE_APPLETS_STACK_KEEP_TUNNEL,

    enableAiNaming: env.CONSOLE_ENABLE_AI_NAMING,
    aiModel: env.CONSOLE_AI_MODEL,
    aiOpenAiApiKey: env.CONSOLE_AI_OPENAI_API_KEY ?? env.OPENAI_API_KEY,
    aiOpenAiBaseUrl: env.CONSOLE_AI_OPENAI_BASE_URL,
    aiTimeoutMs: env.CONSOLE_AI_TIMEOUT_MS,

    tmuxPrefix: env.CONSOLE_TMUX_PREFIX,
    tmuxSessionScope: env.CONSOLE_TMUX_SESSION_SCOPE,
    tmuxManagedMouse: env.CONSOLE_TMUX_MANAGED_MOUSE,

    defaultShell: env.CONSOLE_DEFAULT_SHELL,
    defaultCwd: env.CONSOLE_DEFAULT_CWD,

    attachTokenTtlMs: env.CONSOLE_ATTACH_TOKEN_TTL_MS,
    detachGraceMs: env.CONSOLE_DETACH_GRACE_MS,
    idleTimeoutMs: env.CONSOLE_IDLE_TIMEOUT_MS,
    maxSessionsPerUser: env.CONSOLE_MAX_SESSIONS_PER_USER,
    maxWsMessageBytes: env.CONSOLE_MAX_WS_MESSAGE_BYTES,

    auditLogPath: env.CONSOLE_AUDIT_LOG_PATH,
    prefsPath: env.CONSOLE_PREFS_PATH,

    ttsEnabled: inferredTtsEnabled,
    ttsEngine: env.CONSOLE_TTS_ENGINE as any,
    ttsModel: env.CONSOLE_TTS_MODEL,
    ttsVoice: env.CONSOLE_TTS_VOICE,
    ttsMaxChunkChars: env.CONSOLE_TTS_MAX_CHUNK_CHARS,
    ttsMaxQueueDepth: env.CONSOLE_TTS_MAX_QUEUE_DEPTH,
    ttsOpenAiApiKey: env.CONSOLE_TTS_OPENAI_API_KEY ?? env.OPENAI_API_KEY,
    ttsOpenAiBaseUrl: env.CONSOLE_TTS_OPENAI_BASE_URL,
    ttsPiperBin: env.CONSOLE_TTS_PIPER_BIN,
    ttsPiperModel: env.CONSOLE_TTS_PIPER_MODEL,
    ttsPiperConfig: env.CONSOLE_TTS_PIPER_CONFIG,

    sttEnabled: env.CONSOLE_STT_ENABLE,
    sttEngine: env.CONSOLE_STT_ENGINE as any,
    sttModel: env.CONSOLE_STT_MODEL,
    sttLang: env.CONSOLE_STT_LANG,
    sttWhisperCppBin: env.CONSOLE_WHISPER_CPP_BIN,
    sttWhisperCppModel: env.CONSOLE_WHISPER_CPP_MODEL,
    sttMinAudioBytes: env.CONSOLE_MIN_AUDIO_BYTES,
    sttEnergyThreshold: env.CONSOLE_ENERGY_THRESHOLD,
    sttWindowBytes: env.CONSOLE_WINDOW_BYTES,
    sttOverlapBytes: env.CONSOLE_OVERLAP_BYTES,
    sttFinalizeMs: env.CONSOLE_STT_FINALIZE_MS,
    sttDebug: env.CONSOLE_STT_DEBUG,
    sttOpenAiApiKey: env.CONSOLE_STT_OPENAI_API_KEY ?? env.OPENAI_API_KEY,
    sttOpenAiBaseUrl: env.CONSOLE_STT_OPENAI_BASE_URL
  });

  if (parsed.host !== "127.0.0.1" && parsed.host !== "localhost") {
    throw new Error(
      `Refusing to bind to non-loopback host (${parsed.host}). Set CONSOLE_HOST=127.0.0.1`
    );
  }

  if (parsed.authMode === "cloudflare") {
    if (!parsed.cfAccessIssuer || !parsed.cfAccessAud) {
      throw new Error(
        "Missing CF Access config. Set CF_ACCESS_ISSUER and CF_ACCESS_AUD (or set CONSOLE_AUTH_MODE=none for local dev)."
      );
    }
  }

  if ((parsed.basicAuthUser && !parsed.basicAuthPass) || (!parsed.basicAuthUser && parsed.basicAuthPass)) {
    throw new Error("Set both CONSOLE_BASIC_AUTH_USER and CONSOLE_BASIC_AUTH_PASS (or neither).");
  }

  if (parsed.requireAppToken && !parsed.appToken) {
    throw new Error("CONSOLE_REQUIRE_APP_TOKEN is set but CONSOLE_APP_TOKEN is missing.");
  }

  if (parsed.ttsEnabled && parsed.ttsEngine === "openai" && !parsed.ttsOpenAiApiKey) {
    throw new Error(
      "CONSOLE_TTS_ENABLE is set but no OpenAI API key was found. Set CONSOLE_TTS_OPENAI_API_KEY or OPENAI_API_KEY."
    );
  }

  if (parsed.sttEnabled && parsed.sttEngine === "openai" && !parsed.sttOpenAiApiKey) {
    throw new Error(
      "CONSOLE_STT_ENABLE is set but no OpenAI API key was found. Set CONSOLE_STT_OPENAI_API_KEY or OPENAI_API_KEY."
    );
  }

  if (parsed.enableAiNaming && !parsed.aiOpenAiApiKey) {
    throw new Error(
      "CONSOLE_ENABLE_AI_NAMING is set but no OpenAI API key was found. Set CONSOLE_AI_OPENAI_API_KEY or OPENAI_API_KEY."
    );
  }

  return parsed;
}
