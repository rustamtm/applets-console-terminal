import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent
} from "react";
import { TerminalView, type DisconnectInfo, type TerminalConnectionState, type TerminalViewHandle } from "./TerminalView";
import { PcmPlayer, type TtsFormat } from "./tts";
import { SttRecorder } from "./stt";
import beepUrl from "./assets/beep.wav";

type Mode = "node" | "shell" | "readonly_tail" | "tmux";

type SessionSummary = {
  id: string;
  mode: Mode;
  cwd?: string;
  createdAt: number;
  lastActivityAt: number;
  tmuxName?: string;
  codexState?: "running" | "done" | "idle";
};

type PersistentSession = {
  name: string;
  createdAt?: number;
  lastActivityAt?: number;
  attached?: boolean;
  attachedCount?: number;
  windows?: number;
};

type CodexImage = {
  id: string;
  name: string;
  path: string;
  url?: string;
};

type AudioPrefs = {
  ttsEnabled: boolean;
  ttsEngine: "openai" | "piper" | "browser";
  ttsSource: "terminal" | "codex";
  ttsVoice: string;
  ttsBrowserVoice?: string;
  ttsVolume: number;
  ttsRate: number;
  ttsFallbackEnabled: boolean;
  sttEnabled: boolean;
  sttEngine: "cpp" | "openai";
  sttModel: string;
  sttLang: string;
};

type BriefPrefs = {
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

type BriefReport = {
  overall_summary: string;
  what_completed: string[];
  what_in_progress: string[];
  what_blocked: string[];
  next_actions: string[];
  confidence: number;
  followup_questions: string[];
  spoken_script: string;
};

type BriefRunResponse = {
  ok: boolean;
  report: BriefReport;
  reportJsonText: string;
  usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };
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
    channels: number;
    seconds: number;
    bytes: number;
    base64: string;
  };
};

type CreateSessionResponse = {
  sessionId: string;
  attachToken: string;
  wsUrl: string;
  tmuxName?: string;
};

type AttachOrCreateResponse = CreateSessionResponse & {
  created: boolean;
};

type CompactDock = "right-top" | "right-middle" | "right-bottom" | "left-top" | "left-middle" | "left-bottom";

type MobileActionId =
  | "sessions"
  | "aiRename"
  | "codexBrief"
  | "openAllTmux"
  | "newSession"
  | "disconnect"
  | "reconnect"
  | "endSession"
  | "docs"
  | "tasks"
  | "refresh"
  | "controls"
  | "hide"
  | "settings";

const SESSION_STORAGE_KEY = "console.sessionId";
const LAST_TMUX_NAME_STORAGE_KEY = "console.lastTmuxName";
const SESSION_TAB_ORDER_STORAGE_KEY = "console.sessionTabOrder.v1";
const MOBILE_ACTION_ORDER_STORAGE_KEY = "console.mobileActionOrder.v1";
const ANSI_REGEX =
  /[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const CODEX_CLI_ACTIVITY_REGEX =
  /(esc to interrupt|context left|openai codex|codex\s*\(v|\b\/permissions\b|\b\/model\b|codex>)/i;
const CODEX_CLI_WORKING_REGEX = /(esc to interrupt)/i;
const CODEX_CLI_PROMPT_TAIL_MAX_CHARS = 2048;
const CODEX_CLI_PROMPT_TAIL_WINDOW_CHARS = 140;
const CODEX_CLI_PLAIN_PROMPT_TAIL_WINDOW_CHARS = 800;
const CODEX_CLI_PROMPT_NEEDLES = [
  `\n\u203a `,
  `\n\u203a`,
  `\n\u276f `,
  `\n\u276f`,
  `\ncodex> `,
  `\ncodex>`,
  `\u203a `,
  `\u203a`,
  `\u276f `,
  `\u276f`,
  `codex> `,
  `codex>`
];

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const selector = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])"
  ].join(",");
  const nodes = Array.from(container.querySelectorAll<HTMLElement>(selector));
  return nodes.filter((el) => {
    if (el.tabIndex < 0) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    const rects = el.getClientRects();
    return Boolean(rects && rects.length > 0);
  });
}

function hasCodexPromptNearEnd(text: string): boolean {
  if (!text) return false;
  const tail = text.slice(-CODEX_CLI_PROMPT_TAIL_MAX_CHARS);
  for (const needle of CODEX_CLI_PROMPT_NEEDLES) {
    const idx = tail.lastIndexOf(needle);
    if (idx === -1) continue;
    const after = tail.length - (idx + needle.length);
    if (after >= 0 && after <= CODEX_CLI_PROMPT_TAIL_WINDOW_CHARS) return true;
  }
  return false;
}

function hasCodexPlainPromptAfterAssistantNearEnd(text: string): boolean {
  if (!text) return false;
  const tail = text.slice(-CODEX_CLI_PROMPT_TAIL_MAX_CHARS);

  // Codex can render a "plain" transcript style where user prompts are `: ...` and assistant replies are `" ...`.
  // In that mode, there is no distinct `codex>` prompt, so detect completion as: assistant reply observed, then a
  // subsequent `: ...` prompt appears near the end of the output.
  const assistantRe = /(^|\n)\s*"\s/g;
  let assistantEnd = -1;
  let m: RegExpExecArray | null;
  while ((m = assistantRe.exec(tail)) !== null) {
    assistantEnd = m.index + m[0].length;
  }

  const promptAfterAssistant = (start: number): number => {
    const afterAssistant = start >= 0 ? tail.slice(start) : "";
    const promptRe = /(^|\n)\s*:\s/g;
    let idx = -1;
    let match: RegExpExecArray | null;
    while ((match = promptRe.exec(afterAssistant)) !== null) {
      idx = match.index;
    }
    return idx >= 0 ? start + idx : -1;
  };

  if (assistantEnd >= 0) {
    const promptAbs = promptAfterAssistant(assistantEnd);
    if (promptAbs >= 0) {
      const after = tail.length - promptAbs;
      if (after >= 0 && after <= CODEX_CLI_PLAIN_PROMPT_TAIL_WINDOW_CHARS) return true;
    }
  }

  // Fall back to a looser check: cursor-positioning escape sequences can get stripped, so line boundaries may be
  // unreliable. Use marker ordering plus presence of Codex status text to avoid false positives.
  const lastIdx = (re: RegExp): number => {
    re.lastIndex = 0;
    let idx = -1;
    let match: RegExpExecArray | null;
    while ((match = re.exec(tail)) !== null) {
      idx = match.index;
    }
    return idx;
  };
  const assistantIdx = lastIdx(/(^|\n)\s*"\s/g);
  if (assistantIdx === -1) return false;
  const promptIdx = lastIdx(/(^|\n)\s*:\s/g);
  if (promptIdx === -1 || promptIdx <= assistantIdx) return false;
  const after = tail.length - promptIdx;
  if (after < 0 || after > CODEX_CLI_PLAIN_PROMPT_TAIL_WINDOW_CHARS) return false;
  const afterText = tail.slice(promptIdx);
  if (!/context left/i.test(afterText) && !/\? for shortcuts/i.test(afterText)) return false;
  return true;
}

function getCodexPlainAssistantSignature(text: string): string | null {
  if (!text) return null;
  const tail = text.slice(-CODEX_CLI_PROMPT_TAIL_MAX_CHARS);
  const markerRe = /(^|\n)\s*"\s/g;
  let idx = -1;
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(tail)) !== null) {
    idx = m.index;
  }
  if (idx < 0) return null;
  const sig = tail.slice(idx).trim();
  if (!sig) return null;
  return sig.length > 512 ? sig.slice(0, 512) : sig;
}
const RESUME_KEY_STORAGE_KEY = "console.resumeKey";
const SCROLLBACK_STORAGE_PREFIX = "console.scrollback.";
// Persisting xterm scrollback via SerializeAddon can be expensive (notably in Safari),
// so keep this coarse and only run when we observed output since the last persist.
const SNAPSHOT_INTERVAL_MS = 15_000;
const SCROLLBACK_MAX_CHARS = 1_000_000;
const MIN_ATTACH_GAP_MS = 250;
const RECONNECT_BASE_DELAY_MS = 250;
const RECONNECT_MAX_DELAY_MS = 8000;
const RECONNECT_JITTER = 0.25;
const TERMINAL_FONT_MIN = 9;
const TERMINAL_FONT_MAX = 22;
	const TERMINAL_FONT_DEFAULT = 13;
	const TERMINAL_FONT_STORAGE_KEY = "console.terminalFontSize.v1";
	const AUTO_OPEN_MACOS_TERMINAL_STORAGE_KEY = "console.autoOpenMacosTerminal.v1";
	const PROMPT_TMUX_NAME_ON_CREATE_STORAGE_KEY = "console.promptTmuxNameOnCreate.v1";
	const BEEP_ON_CODEX_DONE_STORAGE_KEY = "console.beepOnCodexDone.v1";
	const TERMINAL_HELPER_BAR_ON_TABLET_STORAGE_KEY = "console.terminalHelperBarOnTablet.v1";
	const TASK_NAME_MAX_CHARS = 96;
const SESSION_TAB_DRAG_THRESHOLD_PX = 8;
const SESSION_TAB_DRAG_LONG_PRESS_MS = 260;
const SESSION_TAB_DRAG_EDGE_SCROLL_PX = 28;
const SESSION_TAB_DRAG_EDGE_SCROLL_STEP_PX = 18;
const MOBILE_ACTION_DRAG_THRESHOLD_PX = 8;
const MOBILE_ACTION_DRAG_LONG_PRESS_MS = 260;

const DEFAULT_BRIEF_PREFS: BriefPrefs = {
  tmuxEnabled: true,
  tmuxMatchRegex: "(?i)codex",
  tmuxMaxSessions: 8,
  tmuxRecentMinutes: 360,
  tasksEnabled: true,
  tasksFolder: "",
  tasksMaxFiles: 12,
  tasksRecentHours: 72,
  tasksIncludeGlobs: ["*.md", "*.txt", "*.json"],
  tasksExcludeGlobs: ["**/archive/**", "**/.git/**"],
  openAiModel: "gpt-4o-mini",
  ttsModel: "gpt-4o-mini-tts",
  voice: "coral",
  spokenSeconds: 50,
  redactPaths: true,
  maxCharsPerFile: 2000
};

const DEFAULT_MOBILE_ACTION_ORDER: MobileActionId[] = [
  "sessions",
  "aiRename",
  "codexBrief",
  "openAllTmux",
  "newSession",
  "disconnect",
  "reconnect",
  "endSession",
  "refresh",
  "controls",
  "settings",
  "docs",
  "tasks",
  "hide"
];

function isMobileActionId(value: string): value is MobileActionId {
  return (
    value === "sessions" ||
    value === "aiRename" ||
    value === "codexBrief" ||
    value === "openAllTmux" ||
    value === "newSession" ||
    value === "disconnect" ||
    value === "reconnect" ||
    value === "endSession" ||
    value === "docs" ||
    value === "tasks" ||
    value === "refresh" ||
    value === "controls" ||
    value === "hide" ||
    value === "settings"
  );
}

type LaunchParams = {
  tmuxName?: string;
  isolated: boolean;
};

function safeGet(store: Storage | null, key: string): string | null {
  if (!store) return null;
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(store: Storage | null, key: string, value: string) {
  if (!store) return;
  try {
    store.setItem(key, value);
  } catch {
    // ignore storage failures
  }
}

function safeRemove(store: Storage | null, key: string) {
  if (!store) return;
  try {
    store.removeItem(key);
  } catch {
    // ignore storage failures
  }
}

function loadSessionTabOrder(store: Storage | null): string[] {
  const raw = safeGet(store, SESSION_TAB_ORDER_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => String(item ?? "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function saveSessionTabOrder(store: Storage | null, order: string[]) {
  if (!store) return;
  safeSet(store, SESSION_TAB_ORDER_STORAGE_KEY, JSON.stringify(order));
}

function normalizeSessionTabOrder(order: string[], activeKeys: string[]): string[] {
  const active = new Set(activeKeys);
  const seen = new Set<string>();
  const out: string[] = [];

  for (const item of order) {
    const key = String(item ?? "").trim();
    if (!key) continue;
    if (!active.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }

  for (const key of activeKeys) {
    const trimmed = String(key ?? "").trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }

  return out;
}

function normalizeMobileActionOrder(order: unknown): MobileActionId[] {
  const raw = Array.isArray(order) ? order : [];
  const seen = new Set<MobileActionId>();
  const out: MobileActionId[] = [];

  for (const item of raw) {
    const value = String(item ?? "").trim();
    if (!value) continue;
    if (!isMobileActionId(value)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }

  for (const value of DEFAULT_MOBILE_ACTION_ORDER) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }

  return out;
}

function loadMobileActionOrder(store: Storage | null): MobileActionId[] {
  const raw = safeGet(store, MOBILE_ACTION_ORDER_STORAGE_KEY);
  if (!raw) return DEFAULT_MOBILE_ACTION_ORDER.slice();
  try {
    const parsed = JSON.parse(raw) as unknown;
    return normalizeMobileActionOrder(parsed);
  } catch {
    return DEFAULT_MOBILE_ACTION_ORDER.slice();
  }
}

function saveMobileActionOrder(store: Storage | null, order: MobileActionId[]) {
  if (!store) return;
  safeSet(store, MOBILE_ACTION_ORDER_STORAGE_KEY, JSON.stringify(order));
}

function parseLaunchParams(): LaunchParams {
  if (typeof window === "undefined") return { isolated: false };
  try {
    const params = new URLSearchParams(window.location.search || "");
    const tmuxName = (params.get("tmux") || params.get("tmuxName") || "").trim() || undefined;
    const isolatedRaw = (params.get("isolated") || params.get("isolate") || "").trim().toLowerCase();
    const isolated = isolatedRaw === "1" || isolatedRaw === "true" || isolatedRaw === "yes";
    return { tmuxName, isolated };
  } catch {
    return { isolated: false };
  }
}

function resolveSessionStore(isolated: boolean): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return isolated ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

function clampTerminalFont(value: number): number {
  return Math.min(TERMINAL_FONT_MAX, Math.max(TERMINAL_FONT_MIN, Math.round(value)));
}

function getBaseTerminalFontSize(): number {
  if (typeof window === "undefined") return TERMINAL_FONT_DEFAULT;
  try {
    return window.matchMedia("(max-width: 720px)").matches ? 11 : 13;
  } catch {
    return TERMINAL_FONT_DEFAULT;
  }
}

function loadTerminalFontOverride(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(TERMINAL_FONT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return null;
    return clampTerminalFont(parsed);
  } catch {
    return null;
  }
}

function saveTerminalFontOverride(value: number) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(TERMINAL_FONT_STORAGE_KEY, String(clampTerminalFont(value)));
  } catch {
    // ignore storage failures
  }
}

function loadAutoOpenMacosTerminal(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(AUTO_OPEN_MACOS_TERMINAL_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function saveAutoOpenMacosTerminal(enabled: boolean) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(AUTO_OPEN_MACOS_TERMINAL_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // ignore storage failures
  }
}

function defaultPromptTmuxNameOnCreate(): boolean {
  if (typeof window === "undefined") return true;
  return true;
}

function loadPromptTmuxNameOnCreate(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = localStorage.getItem(PROMPT_TMUX_NAME_ON_CREATE_STORAGE_KEY);
    if (raw === null) return defaultPromptTmuxNameOnCreate();
    return raw === "1";
  } catch {
    return defaultPromptTmuxNameOnCreate();
  }
}

function savePromptTmuxNameOnCreate(enabled: boolean) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(PROMPT_TMUX_NAME_ON_CREATE_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // ignore storage failures
  }
}

function defaultBeepOnCodexDone(): boolean {
  if (typeof window === "undefined") return false;
  return true;
}

function loadBeepOnCodexDone(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = localStorage.getItem(BEEP_ON_CODEX_DONE_STORAGE_KEY);
    if (raw === null) return defaultBeepOnCodexDone();
    return raw === "1";
  } catch {
    return false;
  }
}

function saveBeepOnCodexDone(enabled: boolean) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(BEEP_ON_CODEX_DONE_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // ignore storage failures
  }
}

function defaultTerminalHelperBarOnTablet(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const coarse = window.matchMedia?.("(any-pointer: coarse)")?.matches ?? false;
    if (!coarse) return false;
    // Phone layout already shows the helper bar unconditionally.
    const small = window.matchMedia?.("(max-width: 720px)")?.matches ?? false;
    if (small) return false;
    // Tablet-ish sizes (includes iPad landscape).
    return window.matchMedia?.("(max-width: 1400px)")?.matches ?? false;
  } catch {
    return false;
  }
}

function loadTerminalHelperBarOnTablet(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = localStorage.getItem(TERMINAL_HELPER_BAR_ON_TABLET_STORAGE_KEY);
    if (raw === null) return defaultTerminalHelperBarOnTablet();
    return raw === "1";
  } catch {
    return false;
  }
}

function saveTerminalHelperBarOnTablet(enabled: boolean) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(TERMINAL_HELPER_BAR_ON_TABLET_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // ignore storage failures
  }
}

function getOrCreateResumeKey(store: Storage | null): string {
  if (!store) return "local";
  const existing = safeGet(store, RESUME_KEY_STORAGE_KEY);
  if (existing) return existing;
  const key =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `resume_${Math.random().toString(36).slice(2)}`;
  safeSet(store, RESUME_KEY_STORAGE_KEY, key);
  return key;
}

function isValidTmuxName(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value);
}

function sanitizeTmuxNameCandidate(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return "";
  const spaces = trimmed.replace(/\s+/g, "-");
  const cleaned = spaces.replace(/[^A-Za-z0-9._-]+/g, "-");
  return cleaned.replace(/-+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
}

function loadLastTmuxName(store: Storage | null): string | null {
  const raw = safeGet(store, LAST_TMUX_NAME_STORAGE_KEY);
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  if (!isValidTmuxName(trimmed)) return null;
  return trimmed;
}

function saveLastTmuxName(store: Storage | null, name?: string) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return;
  if (!isValidTmuxName(trimmed)) return;
  safeSet(store, LAST_TMUX_NAME_STORAGE_KEY, trimmed);
}

function loadScrollback(resumeKey: string): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(`${SCROLLBACK_STORAGE_PREFIX}${resumeKey}`);
}

function trimScrollback(snapshot: string): string {
  if (snapshot.length <= SCROLLBACK_MAX_CHARS) return snapshot;
  return snapshot.slice(-SCROLLBACK_MAX_CHARS);
}

function saveScrollback(resumeKey: string, snapshot: string) {
  if (typeof window === "undefined") return;
  if (!snapshot) return;
  const key = `${SCROLLBACK_STORAGE_PREFIX}${resumeKey}`;
  const trimmed = trimScrollback(snapshot);
  try {
    localStorage.setItem(key, trimmed);
  } catch {
    try {
      localStorage.setItem(key, trimmed.slice(-Math.floor(SCROLLBACK_MAX_CHARS / 2)));
    } catch {
      // ignore storage failures
    }
  }
}
const SESSION_META_STORAGE_KEY = "console.sessionMeta.v1";
const LAST_CWD_STORAGE_KEY = "console.lastCwd.v1";
const CLIENT_LOG_STORAGE_KEY = "console.clientLog.v1";
const CLIENT_LOG_LIMIT = 200;
const COMPACT_DOCK_STORAGE_KEY = "console.controlsDock.v1";
const AI_AUTONAME_ON_ATTACH_STORAGE_KEY = "console.aiAutoNameOnAttach.v1";
const AI_AUTONAME_INCLUDE_OUTPUT_STORAGE_KEY = "console.aiAutoNameIncludeOutput.v1";
const AI_AUTOBULK_ON_RECONNECT_STORAGE_KEY = "console.aiAutoBulkNameOnReconnect.v1";
const AI_AUTONAME_ATTACH_DELAY_MS = 1200;
const CODEX_PROMPT_MAX_CHARS = 2_000;
const CODEX_LOG_TAIL_MAX_CHARS = 4_000;
const COMPACT_DOCKS: CompactDock[] = [
  "right-top",
  "right-middle",
  "right-bottom",
  "left-top",
  "left-middle",
  "left-bottom"
];
const DEFAULT_COMPACT_DOCK: CompactDock = "right-middle";

type SessionMeta = {
  name?: string;
  nameSource?: "ai" | "user";
  autoName?: string;
  autoNamedAt?: number;
  autoNameRequestId?: string;
  lastTitle?: string;
  lastCwd?: string;
  codexState?: "running" | "done" | "idle";
  codexLastPrompt?: string;
  codexPromptAt?: number;
  codexLogTail?: string;
  codexLogTailAt?: number;
  codexModel?: string;
  attentionAt?: number;
  attentionReason?: string;
  updatedAt?: number;
};

type BulkAiNameOptions = {
  sessions?: SessionSummary[];
  interactive?: boolean;
  overwrite?: boolean;
  overwriteAiManagedOnly?: boolean;
};

type ClientLogEntry = {
  at: string;
  event: string;
  data?: Record<string, unknown>;
};

type SessionMetaStore = Record<string, SessionMeta>;

function loadSessionMeta(): SessionMetaStore {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(SESSION_META_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as SessionMetaStore;
  } catch {
    return {};
  }
}

function saveSessionMeta(store: SessionMetaStore) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(SESSION_META_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // ignore quota/serialization issues
  }
}

function loadLastCwd(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(LAST_CWD_STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveLastCwd(cwd: string) {
  if (typeof window === "undefined") return;
  if (!cwd) return;
  try {
    localStorage.setItem(LAST_CWD_STORAGE_KEY, cwd);
  } catch {
    // ignore storage failures
  }
}

function normalizeCwdCandidate(raw: string): string | null {
  const trimmed = raw.trim();
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

function loadClientLog(): ClientLogEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(CLIENT_LOG_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as ClientLogEntry[];
  } catch {
    return [];
  }
}

function saveClientLog(entries: ClientLogEntry[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(CLIENT_LOG_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // ignore
  }
}

function formatClientLog(entries: ClientLogEntry[]) {
  return entries
    .map((entry) => `${entry.at} ${entry.event}${entry.data ? ` ${JSON.stringify(entry.data)}` : ""}`)
    .join("\n");
}

function loadCompactDock(): CompactDock {
  if (typeof window === "undefined") return DEFAULT_COMPACT_DOCK;
  try {
    const raw = localStorage.getItem(COMPACT_DOCK_STORAGE_KEY);
    if (raw && COMPACT_DOCKS.includes(raw as CompactDock)) return raw as CompactDock;
  } catch {
    // ignore storage failures
  }
  return DEFAULT_COMPACT_DOCK;
}

function saveCompactDock(dock: CompactDock) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(COMPACT_DOCK_STORAGE_KEY, dock);
  } catch {
    // ignore storage failures
  }
}

function loadAiAutoNameOnAttach(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = localStorage.getItem(AI_AUTONAME_ON_ATTACH_STORAGE_KEY);
    if (raw === null) return true;
    return raw === "1";
  } catch {
    return true;
  }
}

function saveAiAutoNameOnAttach(enabled: boolean) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(AI_AUTONAME_ON_ATTACH_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // ignore storage failures
  }
}

function loadAiAutoNameIncludeOutput(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(AI_AUTONAME_INCLUDE_OUTPUT_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function saveAiAutoNameIncludeOutput(enabled: boolean) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(AI_AUTONAME_INCLUDE_OUTPUT_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // ignore storage failures
  }
}

function loadAiAutoBulkNameOnReconnect(): boolean {
  // Default ON: safe because we only refresh AI-named sessions and unnamed sessions by default.
  if (typeof window === "undefined") return true;
  try {
    const raw = localStorage.getItem(AI_AUTOBULK_ON_RECONNECT_STORAGE_KEY);
    if (raw === null) return true;
    return raw === "1";
  } catch {
    return true;
  }
}

function saveAiAutoBulkNameOnReconnect(enabled: boolean) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(AI_AUTOBULK_ON_RECONNECT_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // ignore storage failures
  }
}

function keyForSession(id: string, tmuxName?: string): string {
  if (tmuxName) return `tmux:${tmuxName}`;
  return `session:${id}`;
}

function shortId(id: string) {
  return id.slice(0, 8);
}

function isNumericSessionName(name: string): boolean {
  return /^[0-9]+$/.test(name);
}

const SESSION_TAB_BADGE_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "applets",
  "code",
  "console",
  "development",
  "for",
  "in",
  "of",
  "on",
  "root",
  "session",
  "task",
  "terminal",
  "the",
  "to",
  "with"
]);

function deriveSessionTabBadge(taskName: string, tmuxName: string | undefined, sessionId: string): string {
  const raw = (taskName ?? "").trim();

  const clamp = (value: string) => {
    const s = (value ?? "").trim();
    if (!s) return "";
    return s.toUpperCase().slice(0, 4);
  };

  if (raw) {
    // Common: "... Session 2" or "... 2" => show #2 so it remains visible in the tiny tab.
    const endNum = raw.match(/(\d{1,3})\s*$/);
    if (endNum) return clamp(`#${endNum[1]}`);

    const sessionNum = raw.match(/\bsession\s*(\d{1,3})\b/i);
    if (sessionNum) return clamp(`S${sessionNum[1]}`);

    const normalized = raw
      .replace(/[:/\\-]+/g, " ")
      .replace(/[^A-Za-z0-9 ]+/g, " ")
      .trim();
    const words = normalized.split(/\s+/).filter(Boolean);
    const significant = words.filter((w) => !SESSION_TAB_BADGE_STOP_WORDS.has(w.toLowerCase()));

    const initials = significant
      .map((w) => (w ? w[0]!.toUpperCase() : ""))
      .join("")
      .trim();
    if (initials.length >= 2) return clamp(initials);

    const first = significant[0] ?? words[0] ?? "";
    if (first) return clamp(first);
  }

  const tmux = (tmuxName ?? "").trim();
  if (tmux) {
    if (isNumericSessionName(tmux)) return clamp(`#${tmux}`);
    const last = tmux.split("-").filter(Boolean).slice(-1)[0] || tmux;
    return clamp(last);
  }

  // Fallback: show a short stable fragment of the id.
  return clamp(shortId(sessionId).slice(0, 4));
}

function disambiguateSessionTabBadge(base: string, sessionId: string): string {
  const suffix = shortId(sessionId).slice(-1).toUpperCase();
  const s = (base ?? "").trim().toUpperCase();
  if (!s) return suffix;
  if (s.length >= 4) return `${s.slice(0, 3)}${suffix}`;
  return `${s}${suffix}`.slice(0, 4);
}

function formatDurationShortMs(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w`;
}

function formatTmuxSessionDetail(session: PersistentSession): string {
  const attachedCount =
    typeof session.attachedCount === "number"
      ? session.attachedCount
      : session.attached
        ? 1
        : 0;

  const bits: string[] = [];
  bits.push(attachedCount > 0 ? (attachedCount === 1 ? "attached" : `attached (${attachedCount})`) : "detached");

  if (typeof session.lastActivityAt === "number" && Number.isFinite(session.lastActivityAt)) {
    bits.push(`idle ${formatDurationShortMs(Date.now() - session.lastActivityAt)}`);
  }

  if (typeof session.windows === "number" && Number.isFinite(session.windows)) {
    bits.push(`${session.windows} win${session.windows === 1 ? "" : "s"}`);
  }

  return bits.join(" • ");
}

function truncateMiddle(text: string, max = 64): string {
  const s = (text ?? "").trim();
  if (!s) return "";
  if (s.length <= max) return s;
  const head = Math.max(6, Math.floor(max * 0.6));
  const tail = Math.max(6, max - head - 1);
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function hashToHue(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

function sessionTabColor(key: string): string {
  const hue = hashToHue(key);
  return `hsl(${hue} 70% 55%)`;
}

function normalizeBasePath(raw?: string): string {
  if (!raw) return "";
  let base = raw.trim();
  if (!base || base === "/") return "";
  if (!base.startsWith("/")) base = `/${base}`;
  if (base.endsWith("/")) base = base.slice(0, -1);
  return base;
}

function resolveBasePath(): string {
  if (typeof window === "undefined") return "";
  const configured = (window as any).__CONSOLE_BASE_PATH__;
  if (typeof configured === "string") return normalizeBasePath(configured);
  const pathname = window.location.pathname || "/";
  if (pathname === "/console" || pathname.startsWith("/console/")) return "/console";
  return "";
}

function stripAnsi(input: string): string {
  return input.replace(ANSI_REGEX, "");
}

function sanitizeSpeechText(raw: string): string {
  const stripped = stripAnsi(raw);
  const normalized = stripped.replace(/\r/g, "\n");
  return normalized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

function isSpeakable(text: string): boolean {
  return /[A-Za-z0-9]/.test(text);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const clean = String(base64 || "").trim();
  if (!clean) return new ArrayBuffer(0);
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function splitGlobsText(raw: string): string[] {
  return String(raw || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 80);
}

function clampInt(value: unknown, { min, max, fallback }: { min: number; max: number; fallback: number }): number {
  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(num)) return fallback;
  const rounded = Math.trunc(num);
  return Math.max(min, Math.min(max, rounded));
}

function normalizeBriefPrefs(raw: Partial<BriefPrefs> | null | undefined): BriefPrefs {
  const src = raw && typeof raw === "object" ? raw : {};
  const next: BriefPrefs = { ...DEFAULT_BRIEF_PREFS };

  if (typeof src.tmuxEnabled === "boolean") next.tmuxEnabled = src.tmuxEnabled;
  if (typeof src.tmuxMatchRegex === "string" && src.tmuxMatchRegex.trim()) next.tmuxMatchRegex = src.tmuxMatchRegex.trim();
  if (typeof src.tmuxMaxSessions !== "undefined") {
    next.tmuxMaxSessions = clampInt(src.tmuxMaxSessions, { min: 1, max: 25, fallback: next.tmuxMaxSessions });
  }
  if (typeof src.tmuxRecentMinutes !== "undefined") {
    next.tmuxRecentMinutes = clampInt(src.tmuxRecentMinutes, { min: 10, max: 24 * 60, fallback: next.tmuxRecentMinutes });
  }

  if (typeof src.tasksEnabled === "boolean") next.tasksEnabled = src.tasksEnabled;
  if (typeof src.tasksFolder === "string") next.tasksFolder = src.tasksFolder.trim();
  if (typeof src.tasksMaxFiles !== "undefined") {
    next.tasksMaxFiles = clampInt(src.tasksMaxFiles, { min: 1, max: 60, fallback: next.tasksMaxFiles });
  }
  if (typeof src.tasksRecentHours !== "undefined") {
    next.tasksRecentHours = clampInt(src.tasksRecentHours, { min: 1, max: 24 * 14, fallback: next.tasksRecentHours });
  }
  if (Array.isArray(src.tasksIncludeGlobs)) {
    next.tasksIncludeGlobs = src.tasksIncludeGlobs.map((v) => String(v ?? "").trim()).filter(Boolean).slice(0, 20);
  }
  if (Array.isArray(src.tasksExcludeGlobs)) {
    next.tasksExcludeGlobs = src.tasksExcludeGlobs.map((v) => String(v ?? "").trim()).filter(Boolean).slice(0, 40);
  }

  if (typeof src.openAiModel === "string" && src.openAiModel.trim()) next.openAiModel = src.openAiModel.trim();
  if (typeof src.ttsModel === "string" && src.ttsModel.trim()) next.ttsModel = src.ttsModel.trim();
  if (typeof src.voice === "string" && src.voice.trim()) next.voice = src.voice.trim();
  if (typeof src.spokenSeconds !== "undefined") {
    next.spokenSeconds = clampInt(src.spokenSeconds, { min: 10, max: 180, fallback: next.spokenSeconds });
  }
  if (typeof src.redactPaths === "boolean") next.redactPaths = src.redactPaths;
  if (typeof src.maxCharsPerFile !== "undefined") {
    next.maxCharsPerFile = clampInt(src.maxCharsPerFile, { min: 200, max: 20_000, fallback: next.maxCharsPerFile });
  }

  return next;
}

function formatCentsShort(cents: number | null): string {
  if (typeof cents !== "number" || !Number.isFinite(cents) || cents < 0) return "";
  if (cents > 9999) return "~9999c+";
  if (cents < 0.01) return "<0.01c";
  return `~${cents.toFixed(2)}c`;
}

async function postJson<T>(url: string, body?: unknown, opts?: { signal?: AbortSignal }): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : "{}",
    signal: opts?.signal
  });
  const text = await res.text();
  let parsed: any = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text) as any;
    } catch {
      parsed = undefined;
    }
  }
  if (!res.ok) {
    const message =
      typeof parsed?.error === "string"
        ? parsed.error
        : text || `HTTP ${res.status}`;
    throw new Error(message);
  }
  if (parsed === undefined) {
    throw new Error("Server returned non-JSON response.");
  }
  return parsed as T;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  const text = await res.text();
  let parsed: any = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text) as any;
    } catch {
      parsed = undefined;
    }
  }
  if (!res.ok) {
    const message =
      typeof parsed?.error === "string"
        ? parsed.error
        : text || `HTTP ${res.status}`;
    throw new Error(message);
  }
  if (parsed === undefined) {
    throw new Error("Server returned non-JSON response.");
  }
  return parsed as T;
}

export function App() {
  const [mode, setMode] = useState<Mode>("shell");
  const [autoOpenMacosTerminal, setAutoOpenMacosTerminal] = useState<boolean>(() => loadAutoOpenMacosTerminal());
  const [promptTmuxNameOnCreate, setPromptTmuxNameOnCreate] = useState<boolean>(() => loadPromptTmuxNameOnCreate());
  const [terminalHelperBarOnTablet, setTerminalHelperBarOnTablet] = useState<boolean>(() => loadTerminalHelperBarOnTablet());
  const [sessionMeta, setSessionMeta] = useState<SessionMetaStore>(() => loadSessionMeta());
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [conn, setConn] = useState<TerminalConnectionState>({ status: "idle" });
  const [terminalReady, setTerminalReady] = useState<boolean>(false);
  const terminalReadyRef = useRef<boolean>(false);
  const terminalReadyKeyRef = useRef<string | null>(null);
  const setConnectedConn = useCallback(
    (next: TerminalConnectionState & { status: "connected" }) => {
      setConn((prev) => {
        if (prev.status === "connected" && prev.wsUrl === next.wsUrl && prev.sessionId === next.sessionId) {
          return prev;
        }
        return next;
      });
    },
    []
  );
  const [statusLine, setStatusLine] = useState<string>("Idle");
  const [creatingSession, setCreatingSession] = useState<boolean>(false);
  const [openingAllTmuxSessions, setOpeningAllTmuxSessions] = useState<boolean>(false);
  const [controlsHidden, setControlsHidden] = useState<boolean>(false);
  const [compactDock, setCompactDock] = useState<CompactDock>(() => loadCompactDock());
  const [compactDragging, setCompactDragging] = useState<boolean>(false);
  const [isSmallScreen, setIsSmallScreen] = useState<boolean>(false);
  const [mobileControlsOpen, setMobileControlsOpen] = useState<boolean>(false);
  const [sessionsOpen, setSessionsOpen] = useState<boolean>(false);
  const [disconnectDialogOpen, setDisconnectDialogOpen] = useState<boolean>(false);
  const [activeSessions, setActiveSessions] = useState<SessionSummary[]>([]);
  const [savedSessions, setSavedSessions] = useState<PersistentSession[]>([]);
  const [uploading, setUploading] = useState<boolean>(false);
  const [codexEnabled, setCodexEnabled] = useState<boolean>(false);
  const [codexAllowFullAuto, setCodexAllowFullAuto] = useState<boolean>(false);
  const [codexAllowDanger, setCodexAllowDanger] = useState<boolean>(false);
  const [codexPrompt, setCodexPrompt] = useState<string>("");
  const [codexModel, setCodexModel] = useState<string>("");
  const [codexSandbox] = useState<"read-only" | "workspace-write" | "danger-full-access">("workspace-write");
  const [codexFullAuto, setCodexFullAuto] = useState<boolean>(true);
  const [codexStatus, setCodexStatus] = useState<string>("Idle");
  const [codexLog, setCodexLog] = useState<string>("");
  const [codexRunning, setCodexRunning] = useState<boolean>(false);
  const [terminalCodexState, setTerminalCodexState] = useState<"idle" | "running" | "done">("idle");
  const [codexImages, setCodexImages] = useState<CodexImage[]>([]);
  const codexSessionKeyRef = useRef<string | null>(null);
  const currentKeyRef = useRef<string | null>(null);
  const [clientLogVersion, setClientLogVersion] = useState<number>(0);
  const clientLogRef = useRef<ClientLogEntry[]>(loadClientLog());
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [aiStatusLoaded, setAiStatusLoaded] = useState<boolean>(false);
  const [aiNamingEnabled, setAiNamingEnabled] = useState<boolean>(false);
  const [aiModel, setAiModel] = useState<string>("");
  const [aiAutoNameOnAttach, setAiAutoNameOnAttach] = useState<boolean>(() => loadAiAutoNameOnAttach());
  const [aiIncludeOutput, setAiIncludeOutput] = useState<boolean>(() => loadAiAutoNameIncludeOutput());
  const [aiAutoBulkNameOnReconnect, setAiAutoBulkNameOnReconnect] = useState<boolean>(() =>
    loadAiAutoBulkNameOnReconnect()
  );
  const [aiNameStatus, setAiNameStatus] = useState<string>("Idle");
  const [ttsEnabled, setTtsEnabled] = useState<boolean>(false);
  const [ttsEngine, setTtsEngine] = useState<"openai" | "piper" | "browser">("openai");
  const [ttsSource, setTtsSource] = useState<"terminal" | "codex">("codex");
  const [ttsVoice, setTtsVoice] = useState<string>("coral");
  const [ttsBrowserVoice, setTtsBrowserVoice] = useState<string>("");
  const [browserVoices, setBrowserVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [ttsVolume, setTtsVolume] = useState<number>(1);
  const [ttsRate, setTtsRate] = useState<number>(1);
  const [ttsFallbackEnabled, setTtsFallbackEnabled] = useState<boolean>(false);
  const [ttsServerActive, setTtsServerActive] = useState<boolean>(false);
  const [ttsStatus, setTtsStatus] = useState<string>("Idle");
  const [sttEnabled, setSttEnabled] = useState<boolean>(false);
  const [sttEngine, setSttEngine] = useState<"cpp" | "openai">("cpp");
  const [sttModel, setSttModel] = useState<string>("ggml-large-v3.bin");
  const [sttLang, setSttLang] = useState<string>("auto");
  const [sttStatus, setSttStatus] = useState<string>("Idle");
  const [audioPrefsReady, setAudioPrefsReady] = useState<boolean>(false);
  const [briefPrefs, setBriefPrefs] = useState<BriefPrefs>(() => ({ ...DEFAULT_BRIEF_PREFS }));
  const [briefPrefsReady, setBriefPrefsReady] = useState<boolean>(false);
  const [briefRunning, setBriefRunning] = useState<boolean>(false);
  const [briefStatus, setBriefStatus] = useState<string>("Idle");
  const [briefLastCost, setBriefLastCost] = useState<BriefRunResponse["cost"] | null>(null);
  const [briefLastReportJson, setBriefLastReportJson] = useState<string>("");
  const [briefLastSpokenScript, setBriefLastSpokenScript] = useState<string>("");
  const [beepOnCodexDone, setBeepOnCodexDone] = useState<boolean>(() => loadBeepOnCodexDone());
  const [appletsStackRestartEnabled, setAppletsStackRestartEnabled] = useState<boolean>(false);
  const [appletsStackLogPath, setAppletsStackLogPath] = useState<string>("");
  const [appletsStackStatus, setAppletsStackStatus] = useState<string>("Idle");
  const [appletsStackRestarting, setAppletsStackRestarting] = useState<boolean>(false);
  const [consoleRestartStatus, setConsoleRestartStatus] = useState<string>("Idle");
  const [consoleRestartBusy, setConsoleRestartBusy] = useState<"prod" | "root" | "dev" | null>(null);
  const initialTerminalFont = useMemo(() => {
    const override = loadTerminalFontOverride();
    return { override, size: override ?? getBaseTerminalFontSize() };
  }, []);
  const [terminalFontOverride, setTerminalFontOverride] = useState<number | null>(initialTerminalFont.override);
  const [terminalFontSize, setTerminalFontSize] = useState<number>(initialTerminalFont.size);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const terminalWrapRef = useRef<HTMLDivElement | null>(null);
  const sessionTabsRef = useRef<HTMLDivElement | null>(null);
  const sessionPanelRef = useRef<HTMLDivElement | null>(null);
  const sessionsToggleRef = useRef<HTMLButtonElement | null>(null);
  const sessionsToggleMobileRef = useRef<HTMLButtonElement | null>(null);
  const settingsToggleRef = useRef<HTMLButtonElement | null>(null);
  const settingsToggleMobileRef = useRef<HTMLButtonElement | null>(null);
  const settingsCardRef = useRef<HTMLDivElement | null>(null);
  const settingsRestoreFocusRef = useRef<HTMLElement | null>(null);
  const prevSettingsOpenRef = useRef<boolean>(false);
  const terminalRef = useRef<TerminalViewHandle | null>(null);
  const scrollbackDirtyRef = useRef<boolean>(false);
  const codexPromptRef = useRef<HTMLTextAreaElement | null>(null);
  const codexLogTailRef = useRef<string>("");
  const briefAbortRef = useRef<AbortController | null>(null);
  const manualDisconnectRef = useRef<boolean>(false);
  const suppressDisconnectRef = useRef<boolean>(false);
  const reconnectRef = useRef<{ attempt: number; timer: number | null }>({ attempt: 0, timer: null });
  const connRef = useRef(conn);
  const creatingSessionRef = useRef<boolean>(false);
  const attachInFlightRef = useRef<Promise<AttachOrCreateResponse> | null>(null);
  const openAllTmuxInFlightRef = useRef<Promise<void> | null>(null);
  const lastAttachAtRef = useRef<number>(0);
  const sessionTabDragRef = useRef<{
    active: boolean;
    dragging: boolean;
    suppressClick: boolean;
    pointerType: string;
    pointerId: number | null;
    key: string;
    startX: number;
    startY: number;
    longPressTimer: number | null;
  }>({
    active: false,
    dragging: false,
    suppressClick: false,
    pointerType: "",
    pointerId: null,
    key: "",
    startX: 0,
    startY: 0,
    longPressTimer: null
  });
  const mobileActionDragRef = useRef<{
    active: boolean;
    dragging: boolean;
    suppressClick: boolean;
    pointerType: string;
    pointerId: number | null;
    actionId: MobileActionId | null;
    startX: number;
    startY: number;
    longPressTimer: number | null;
    captureEl: HTMLElement | null;
  }>({
    active: false,
    dragging: false,
    suppressClick: false,
    pointerType: "",
    pointerId: null,
    actionId: null,
    startX: 0,
    startY: 0,
    longPressTimer: null,
    captureEl: null
  });
  const compactDragRef = useRef<{
    active: boolean;
    moved: boolean;
    suppressClick: boolean;
    pointerId: number | null;
    startX: number;
    startY: number;
  }>({
    active: false,
    moved: false,
    suppressClick: false,
    pointerId: null,
    startX: 0,
    startY: 0
  });
  const getTerminalSize = useCallback(() => {
    const size = terminalRef.current?.getSize();
    if (!size) return null;
    const cols = Math.max(10, size.cols);
    const rows = Math.max(5, size.rows);
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null;
    return { cols, rows };
  }, []);
  const uploadingRef = useRef<boolean>(false);
  const codexWsRef = useRef<WebSocket | null>(null);
  const ttsWsRef = useRef<WebSocket | null>(null);
  const terminalCodexTimerRef = useRef<number | null>(null);
  const terminalCodexLockRef = useRef<boolean>(false);
  const autoReattachAttemptedRef = useRef<boolean>(false);
  const launchConnectAttemptedRef = useRef<boolean>(false);
  const aiSuggestInFlightRef = useRef<Promise<void> | null>(null);
  const aiAutoNameAttemptedRef = useRef<Set<string>>(new Set());
  const aiAutoNameTimerRef = useRef<number | null>(null);
  const aiAutoBulkPendingRef = useRef<boolean>(false);
  const aiAutoBulkLastConnKeyRef = useRef<string | null>(null);
  const ttsPlayerRef = useRef<PcmPlayer | null>(null);
  const speechBufferRef = useRef<string>("");
  const speechFlushTimerRef = useRef<number | null>(null);
  const sttWsRef = useRef<WebSocket | null>(null);
  const sttRecorderRef = useRef<SttRecorder | null>(null);
  const audioPrefsReadyRef = useRef<boolean>(false);
  const audioPrefsSaveTimerRef = useRef<number | null>(null);
  const audioPrefsLastSavedRef = useRef<string | null>(null);
  const audioPrefsSaveInFlightRef = useRef<boolean>(false);
  const audioPrefsSaveRetryTimerRef = useRef<number | null>(null);
  const audioPrefsSaveRetryDelayRef = useRef<number>(0);
  const audioPrefsPendingSerializedRef = useRef<string | null>(null);
  const audioPrefsPendingPayloadRef = useRef<AudioPrefs | null>(null);
  const briefPlayerRef = useRef<PcmPlayer | null>(null);
  const briefAudioUnlockedRef = useRef<boolean>(false);
  const briefAudioAttemptAtRef = useRef<number>(0);
  const briefPrefsReadyRef = useRef<boolean>(false);
  const briefPrefsSaveTimerRef = useRef<number | null>(null);
  const briefPrefsLastSavedRef = useRef<string | null>(null);
  const briefPrefsSaveInFlightRef = useRef<boolean>(false);
  const briefPrefsSaveRetryTimerRef = useRef<number | null>(null);
  const briefPrefsSaveRetryDelayRef = useRef<number>(0);
  const briefPrefsPendingSerializedRef = useRef<string | null>(null);
  const briefPrefsPendingPayloadRef = useRef<BriefPrefs | null>(null);
  const beepRef = useRef<{
    ctx: AudioContext | null;
    masterGain: GainNode | null;
    lastBeepAtMs: number;
    buffer: AudioBuffer | null;
    bufferPromise: Promise<AudioBuffer | null> | null;
  }>({ ctx: null, masterGain: null, lastBeepAtMs: 0, buffer: null, bufferPromise: null });
  const beepElementRef = useRef<HTMLAudioElement | null>(null);
  const beepHintAtRef = useRef<number>(0);
  const ttsAudioHintAtRef = useRef<number>(0);
  const ttsAudioUnlockedRef = useRef<boolean>(false);
  const ttsAudioAttemptAtRef = useRef<number>(0);
  const codexWorkingRef = useRef<"prompt" | "plain" | null>(null);
  const codexPlainAssistantSigRef = useRef<string>("");
  const codexDetectTailRef = useRef<string>("");
  const sessionCodexStateRef = useRef<Record<string, SessionSummary["codexState"] | undefined>>({});
  const sessionCodexStateInitRef = useRef<boolean>(false);
  const launchParams = useMemo(() => parseLaunchParams(), []);
  const sessionStore = useMemo(() => resolveSessionStore(launchParams.isolated), [launchParams.isolated]);
  const resumeKey = useMemo(() => getOrCreateResumeKey(sessionStore), [sessionStore]);
  const [mobileActionOrder, setMobileActionOrder] = useState<MobileActionId[]>(() => loadMobileActionOrder(sessionStore));
  const [draggingMobileActionId, setDraggingMobileActionId] = useState<MobileActionId | null>(null);
  const [mobileActionEditMode, setMobileActionEditMode] = useState<boolean>(false);
  const mobileActionEditModeRef = useRef<boolean>(false);
  const [sessionTabOrder, setSessionTabOrder] = useState<string[]>(() => loadSessionTabOrder(sessionStore));
  const [draggingSessionTabKey, setDraggingSessionTabKey] = useState<string | null>(null);

  useEffect(() => {
    setMobileActionOrder((prev) => {
      const next = normalizeMobileActionOrder(prev);
      const same = prev.length === next.length && prev.every((value, i) => value === next[i]);
      if (same) return prev;
      saveMobileActionOrder(sessionStore, next);
      return next;
    });
  }, [sessionStore]);

  useEffect(() => {
    mobileActionEditModeRef.current = mobileActionEditMode;

    if (mobileActionEditMode) return;
    const drag = mobileActionDragRef.current;
    const pointerId = drag.pointerId;
    if (drag.longPressTimer) {
      window.clearTimeout(drag.longPressTimer);
      drag.longPressTimer = null;
    }
    if (drag.captureEl && pointerId !== null && drag.captureEl.hasPointerCapture(pointerId)) {
      try {
        drag.captureEl.releasePointerCapture(pointerId);
      } catch {
        // ignore release failures
      }
    }
    drag.active = false;
    drag.dragging = false;
    drag.suppressClick = false;
    drag.pointerType = "";
    drag.pointerId = null;
    drag.actionId = null;
    drag.startX = 0;
    drag.startY = 0;
    drag.longPressTimer = null;
    drag.captureEl = null;
    setDraggingMobileActionId(null);
  }, [mobileActionEditMode]);

  useEffect(() => {
    if (isSmallScreen) return;
    setMobileActionEditMode(false);
  }, [isSmallScreen]);

  useEffect(() => {
    connRef.current = conn;
  }, [conn]);
  useEffect(() => {
    terminalReadyRef.current = terminalReady;
  }, [terminalReady]);
  useEffect(() => {
    if (conn.status !== "connected") {
      terminalReadyKeyRef.current = null;
      if (terminalReadyRef.current) setTerminalReady(false);
      return;
    }
    const key = `${conn.sessionId}|${conn.wsUrl}`;
    if (terminalReadyKeyRef.current !== key) {
      terminalReadyKeyRef.current = key;
      if (terminalReadyRef.current) setTerminalReady(false);
    }
  }, [conn]);

  useEffect(() => {
    creatingSessionRef.current = creatingSession;
  }, [creatingSession]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(max-width: 720px)");
    const update = () => setIsSmallScreen(media.matches);
    update();
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", update);
      return () => media.removeEventListener("change", update);
    }
    media.addListener(update);
    return () => media.removeListener(update);
  }, []);

  useEffect(() => {
    if (!settingsOpen) return;
    const size = terminalRef.current?.getFontSize();
    if (typeof size === "number" && Number.isFinite(size)) {
      setTerminalFontSize(size);
    }
  }, [settingsOpen]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const prev = prevSettingsOpenRef.current;
    prevSettingsOpenRef.current = settingsOpen;

    if (settingsOpen && !prev) {
      window.requestAnimationFrame(() => {
        const card = settingsCardRef.current;
        if (!card) return;
        const focusables = getFocusableElements(card);
        const target = focusables[0] ?? card;
        target.focus();
      });
      return;
    }

    if (!settingsOpen && prev) {
      const restore = settingsRestoreFocusRef.current;
      settingsRestoreFocusRef.current = null;
      window.requestAnimationFrame(() => {
        const stillInDom = restore instanceof HTMLElement && document.contains(restore);
        const fallback = isSmallScreen ? settingsToggleMobileRef.current : settingsToggleRef.current;
        const target = stillInDom ? restore : fallback;
        target?.focus();
      });
    }
  }, [isSmallScreen, settingsOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    if (typeof window === "undefined") return;
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key !== "Tab" && event.code !== "Tab") return;
      const card = settingsCardRef.current;
      if (!card) return;
      const focusables = getFocusableElements(card);
      if (focusables.length === 0) {
        event.preventDefault();
        card.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;

      if (event.shiftKey) {
        if (!(active instanceof Node) || !card.contains(active) || active === first) {
          event.preventDefault();
          last.focus();
        }
        return;
      }

      if (!(active instanceof Node) || !card.contains(active) || active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeydown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeydown, { capture: true });
  }, [settingsOpen]);

  useEffect(() => {
    if (terminalFontOverride === null) return;
    terminalRef.current?.setFontSize(terminalFontOverride);
  }, [terminalFontOverride]);

  const applyTerminalFontSize = useCallback((value: number) => {
    const clamped = clampTerminalFont(value);
    setTerminalFontSize(clamped);
    setTerminalFontOverride(clamped);
    saveTerminalFontOverride(clamped);
    terminalRef.current?.setFontSize(clamped);
  }, []);

  const applyAutoOpenMacosTerminal = useCallback((enabled: boolean) => {
    setAutoOpenMacosTerminal(enabled);
    saveAutoOpenMacosTerminal(enabled);
  }, []);

  const applyPromptTmuxNameOnCreate = useCallback((enabled: boolean) => {
    setPromptTmuxNameOnCreate(enabled);
    savePromptTmuxNameOnCreate(enabled);
  }, []);

  const applyTerminalHelperBarOnTablet = useCallback((enabled: boolean) => {
    setTerminalHelperBarOnTablet(enabled);
    saveTerminalHelperBarOnTablet(enabled);
  }, []);

  const applyAiAutoNameOnAttach = useCallback((enabled: boolean) => {
    setAiAutoNameOnAttach(enabled);
    saveAiAutoNameOnAttach(enabled);
  }, []);

  const applyAiIncludeOutput = useCallback((enabled: boolean) => {
    setAiIncludeOutput(enabled);
    saveAiAutoNameIncludeOutput(enabled);
  }, []);

  const applyAiAutoBulkNameOnReconnect = useCallback((enabled: boolean) => {
    setAiAutoBulkNameOnReconnect(enabled);
    saveAiAutoBulkNameOnReconnect(enabled);
  }, []);

  const stepTerminalFontSize = useCallback(
    (delta: number) => {
      const base = terminalRef.current?.getFontSize();
      const fallback = Number.isFinite(base) ? base : terminalFontSize || getBaseTerminalFontSize();
      applyTerminalFontSize(fallback + delta);
    },
    [applyTerminalFontSize, terminalFontSize]
  );

  useEffect(() => {
    if (!isSmallScreen) setMobileControlsOpen(false);
  }, [isSmallScreen]);

  useEffect(() => {
    if (controlsHidden) setMobileControlsOpen(false);
  }, [controlsHidden]);

  useEffect(() => {
    if (!controlsHidden) return;
    if (sessionsOpen) setSessionsOpen(false);
    if (settingsOpen) setSettingsOpen(false);
    if (disconnectDialogOpen) setDisconnectDialogOpen(false);
  }, [controlsHidden, sessionsOpen, settingsOpen, disconnectDialogOpen]);

  useEffect(() => {
    if (!sessionsOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!target || !(target instanceof Node)) return;
      if (sessionPanelRef.current?.contains(target)) return;
      if (sessionsToggleRef.current?.contains(target)) return;
      if (sessionsToggleMobileRef.current?.contains(target)) return;
      setSessionsOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [sessionsOpen]);

  useEffect(() => {
    if (!sessionsOpen && !settingsOpen && !disconnectDialogOpen) return;
    if (typeof window === "undefined") return;
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key !== "Escape" && event.code !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (disconnectDialogOpen) setDisconnectDialogOpen(false);
      else if (settingsOpen) setSettingsOpen(false);
      else if (sessionsOpen) setSessionsOpen(false);
    };
    window.addEventListener("keydown", handleKeydown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeydown, { capture: true });
  }, [sessionsOpen, settingsOpen, disconnectDialogOpen]);

  useEffect(() => {
    saveCompactDock(compactDock);
  }, [compactDock]);

  useEffect(() => {
    saveBeepOnCodexDone(beepOnCodexDone);
  }, [beepOnCodexDone]);

  const addClientLog = useCallback((event: string, data?: Record<string, unknown>) => {
    const entry: ClientLogEntry = { at: new Date().toISOString(), event, data };
    const next = [...clientLogRef.current, entry];
    if (next.length > CLIENT_LOG_LIMIT) {
      next.splice(0, next.length - CLIENT_LOG_LIMIT);
    }
    clientLogRef.current = next;
    saveClientLog(next);
    setClientLogVersion((v) => v + 1);
  }, []);

  const clientLogText = useMemo(() => formatClientLog(clientLogRef.current), [clientLogVersion]);

  const clearClientLog = useCallback(() => {
    clientLogRef.current = [];
    saveClientLog([]);
    setClientLogVersion((v) => v + 1);
  }, []);

  const copyClientLog = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(clientLogText || "No logs yet.");
      setStatusLine("Debug log copied.");
    } catch {
      setStatusLine("Copy failed.");
    }
  }, [clientLogText]);

  const getInitialSnapshot = useCallback(() => loadScrollback(resumeKey) ?? undefined, [resumeKey]);
  const persistScrollback = useCallback(() => {
    const snapshot = terminalRef.current?.getSnapshot();
    if (!snapshot) return false;
    saveScrollback(resumeKey, snapshot);
    return true;
  }, [resumeKey]);

  const getLastKnownCwd = useCallback(() => {
    const fallback = loadLastCwd() ?? undefined;
    if (!sessionId) return fallback;
    const active = activeSessions.find((s) => s.id === sessionId) ?? null;
    const stableKey = keyForSession(sessionId, active?.tmuxName);
    const ephemeralKey = keyForSession(sessionId);
    const fromMeta = sessionMeta[stableKey]?.lastCwd ?? sessionMeta[ephemeralKey]?.lastCwd;
    return fromMeta ?? fallback;
  }, [activeSessions, sessionId, sessionMeta]);

  const updateSessionMeta = useCallback((key: string, patch: Partial<SessionMeta>) => {
    setSessionMeta((prev) => {
      const next: SessionMetaStore = { ...prev };
      const current = next[key] ?? {};
      const merged: SessionMeta = { ...current, ...patch, updatedAt: Date.now() };
      if (!merged.name) delete merged.name;
      if (!merged.name) delete merged.nameSource;
      if (merged.nameSource !== "ai" && merged.nameSource !== "user") delete merged.nameSource;
      if (!merged.autoName) {
        delete merged.autoName;
        delete merged.autoNamedAt;
        delete merged.autoNameRequestId;
      }
      if (!merged.autoNameRequestId) delete merged.autoNameRequestId;
      if (!Number.isFinite(merged.autoNamedAt)) delete merged.autoNamedAt;
      if (!merged.lastTitle) delete merged.lastTitle;
      if (!merged.lastCwd) delete merged.lastCwd;
      if (!merged.codexState || merged.codexState === "idle") {
        delete merged.codexState;
      }
      if (!merged.codexLastPrompt) {
        delete merged.codexLastPrompt;
        delete merged.codexPromptAt;
        delete merged.codexModel;
      }
      if (!Number.isFinite(merged.codexPromptAt)) delete merged.codexPromptAt;
      if (!merged.codexModel) delete merged.codexModel;
      if (!merged.codexLogTail) {
        delete merged.codexLogTail;
        delete merged.codexLogTailAt;
      }
      if (!Number.isFinite(merged.codexLogTailAt)) delete merged.codexLogTailAt;
      if (!Number.isFinite(merged.attentionAt)) {
        delete merged.attentionAt;
        delete merged.attentionReason;
      }
      if (!merged.attentionReason) delete merged.attentionReason;
      if (
        !merged.name &&
        !merged.autoName &&
        !merged.lastTitle &&
        !merged.lastCwd &&
        !merged.codexState &&
        !merged.codexLastPrompt &&
        !merged.codexLogTail &&
        !merged.attentionAt
      ) {
        delete next[key];
      } else {
        next[key] = merged;
      }
      saveSessionMeta(next);
      return next;
    });
  }, []);

  const clearTerminalCodexTimer = useCallback(() => {
    if (terminalCodexTimerRef.current === null) return;
    window.clearTimeout(terminalCodexTimerRef.current);
    terminalCodexTimerRef.current = null;
  }, []);

  const bumpTerminalCodexActivity = useCallback(() => {
    if (terminalCodexLockRef.current) return;
    const key = currentKeyRef.current;
    setTerminalCodexState("running");
    if (key) {
      updateSessionMeta(key, { codexState: "running" });
    }
    clearTerminalCodexTimer();
    terminalCodexTimerRef.current = window.setTimeout(() => {
      terminalCodexTimerRef.current = null;
      if (terminalCodexLockRef.current) return;
      setTerminalCodexState("idle");
      if (key) {
        updateSessionMeta(key, { codexState: "idle" });
      }
    }, 20_000);
  }, [clearTerminalCodexTimer, updateSessionMeta]);

  useEffect(() => {
    uploadingRef.current = uploading;
  }, [uploading]);

  const ensureBeepAudio = useCallback(async () => {
    if (typeof window === "undefined") return false;
    const state = beepRef.current;
    if (!state.ctx) {
      const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (typeof Ctor !== "function") return false;
      try {
        state.ctx = new Ctor();
        state.masterGain = state.ctx.createGain();
        state.masterGain.gain.value = 1;
        state.masterGain.connect(state.ctx.destination);

        // Some browsers (notably iOS Safari) can be picky about starting audio after
        // just resuming a context. A silent “priming” node helps.
        try {
          const osc = state.ctx.createOscillator();
          const gain = state.ctx.createGain();
          gain.gain.value = 0;
          osc.connect(gain);
          gain.connect(state.masterGain);
          const t0 = state.ctx.currentTime;
          osc.start(t0);
          osc.stop(t0 + 0.01);
          osc.onended = () => {
            try {
              osc.disconnect();
              gain.disconnect();
            } catch {
              // ignore
            }
          };
        } catch {
          // ignore
        }
      } catch {
        state.ctx = null;
        state.masterGain = null;
        return false;
      }
    }
    if (state.ctx?.state === "suspended") {
      try {
        await state.ctx.resume();
      } catch {
        // ignore
      }
    }

    if (state.ctx?.state === "running" && !state.buffer && !state.bufferPromise) {
      const ctx = state.ctx;
      if (typeof fetch === "function" && typeof (ctx as any).decodeAudioData === "function") {
        const decode = (data: ArrayBuffer) =>
          new Promise<AudioBuffer>((resolve, reject) => {
            let settled = false;
            const finish = (value: AudioBuffer) => {
              if (settled) return;
              settled = true;
              resolve(value);
            };
            const fail = (err: any) => {
              if (settled) return;
              settled = true;
              reject(err);
            };
            try {
              const maybe = (ctx as any).decodeAudioData(data, finish, fail);
              if (maybe && typeof maybe.then === "function") {
                maybe.then(finish).catch(fail);
              }
            } catch (err) {
              fail(err);
            }
          });

        state.bufferPromise = fetch(beepUrl)
          .then((res) => {
            if (!res.ok) throw new Error(`beep fetch failed: HTTP ${res.status}`);
            return res.arrayBuffer();
          })
          .then((data) => decode(data))
          .then((buffer) => {
            state.buffer = buffer;
            return buffer;
          })
          .catch(() => null)
          .finally(() => {
            state.bufferPromise = null;
          });
      }
    }

    return state.ctx?.state === "running";
  }, []);

  const playBeep = useCallback((reason: string, extra?: Record<string, unknown>) => {
    const state = beepRef.current;
    const connectedSessionId = connRef.current.status === "connected" ? connRef.current.sessionId : null;

    const maybeHint = (message: string) => {
      const now = Date.now();
      if (now - beepHintAtRef.current < 12_000) return;
      beepHintAtRef.current = now;
      setStatusLine(message);
    };

    const tryHtmlAudio = (source: "direct" | "ensure", fallbackFrom: string): boolean => {
      const nowMs = Date.now();
      const elapsedMs = nowMs - state.lastBeepAtMs;
      if (elapsedMs >= 0 && elapsedMs < 800) {
        addClientLog("beep.skip", {
          ...(extra ?? {}),
          reason,
          source,
          sessionId: connectedSessionId,
          why: "cooldown",
          elapsedMs,
          method: "html_audio",
          fallbackFrom
        });
        return true;
      }

      let el = beepElementRef.current;
      if (!el && typeof Audio === "function") {
        try {
          el = new Audio(beepUrl);
          el.preload = "auto";
          beepElementRef.current = el;
        } catch {
          el = null;
        }
      }

      if (!el) {
        addClientLog("beep.skip", {
          ...(extra ?? {}),
          reason,
          source,
          sessionId: connectedSessionId,
          why: "no_html_audio",
          method: "html_audio",
          fallbackFrom
        });
        return false;
      }

      state.lastBeepAtMs = nowMs;
      try {
        el.muted = false;
        el.volume = 1;
        try {
          el.pause();
        } catch {
          // ignore
        }
        try {
          el.currentTime = 0;
        } catch {
          // ignore
        }

        const maybe = el.play();
        // Even if HTMLAudio works, warm up WebAudio for future beeps.
        void ensureBeepAudio();
        if (maybe && typeof (maybe as any).then === "function" && typeof (maybe as any).catch === "function") {
          (maybe as any)
            .then(() => {
              addClientLog("beep.play", {
                ...(extra ?? {}),
                reason,
                source,
                sessionId: connectedSessionId,
                method: "html_audio",
                fallbackFrom
              });
            })
            .catch(() => {
              state.lastBeepAtMs = 0;
              addClientLog("beep.skip", {
                ...(extra ?? {}),
                reason,
                source,
                sessionId: connectedSessionId,
                why: "html_audio_blocked",
                method: "html_audio",
                fallbackFrom
              });
              maybeHint("Beep blocked by browser. Tap the page once, unmute, then use Settings > Test beep.");
            });
        } else {
          addClientLog("beep.play", {
            ...(extra ?? {}),
            reason,
            source,
            sessionId: connectedSessionId,
            method: "html_audio",
            fallbackFrom
          });
        }
      } catch {
        state.lastBeepAtMs = 0;
        addClientLog("beep.skip", {
          ...(extra ?? {}),
          reason,
          source,
          sessionId: connectedSessionId,
          why: "html_audio_error",
          method: "html_audio",
          fallbackFrom
        });
        maybeHint("Beep failed to play. Tap the page once, unmute, then use Settings > Test beep.");
      }
      return true;
    };

    const schedule = (source: "direct" | "ensure") => {
      const ctx = state.ctx;
      if (!ctx || ctx.state !== "running") {
        if (tryHtmlAudio(source, "webaudio_ctx_not_running")) return;
        addClientLog("beep.skip", {
          ...(extra ?? {}),
          reason,
          source,
          sessionId: connectedSessionId,
          why: "ctx_not_running",
          ctxState: ctx?.state ?? null
        });
        return;
      }
      const nowMs = Date.now();
      const elapsedMs = nowMs - state.lastBeepAtMs;
      if (elapsedMs >= 0 && elapsedMs < 800) {
        addClientLog("beep.skip", {
          ...(extra ?? {}),
          reason,
          source,
          sessionId: connectedSessionId,
          why: "cooldown",
          elapsedMs
        });
        return;
      }
      state.lastBeepAtMs = nowMs;
      try {
        if (state.buffer && typeof (ctx as any).createBufferSource === "function") {
          const src = (ctx as any).createBufferSource();
          src.buffer = state.buffer;
          const gain = ctx.createGain();
          const t0 = ctx.currentTime;
          gain.gain.setValueAtTime(0.9, t0);
          src.connect(gain);
          if (state.masterGain) {
            gain.connect(state.masterGain);
          } else {
            gain.connect(ctx.destination);
          }
          src.start(t0);
          src.onended = () => {
            try {
              src.disconnect();
              gain.disconnect();
            } catch {
              // ignore
            }
          };
          addClientLog("beep.play", {
            ...(extra ?? {}),
            reason,
            source,
            sessionId: connectedSessionId,
            method: "webaudio_buffer"
          });
          return;
        }
      } catch {
        // Fall back to oscillator beep below.
      }

      try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const t0 = ctx.currentTime;
        osc.type = "sine";
        osc.frequency.setValueAtTime(880, t0);
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.24, t0 + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
        osc.connect(gain);
        if (state.masterGain) {
          gain.connect(state.masterGain);
        } else {
          gain.connect(ctx.destination);
        }
        osc.start(t0);
        osc.stop(t0 + 0.2);
        osc.onended = () => {
          try {
            osc.disconnect();
            gain.disconnect();
          } catch {
            // ignore
          }
        };
        addClientLog("beep.play", {
          ...(extra ?? {}),
          reason,
          source,
          sessionId: connectedSessionId,
          method: "webaudio_oscillator"
        });
      } catch {
        addClientLog("beep.skip", {
          ...(extra ?? {}),
          reason,
          source,
          sessionId: connectedSessionId,
          why: "play_failed"
        });
      }
    };

    if (state.ctx && state.ctx.state === "running") {
      schedule("direct");
      return;
    }
    void ensureBeepAudio().then((ok) => {
      if (!ok) {
        const attempted = tryHtmlAudio("ensure", "webaudio_unavailable");
        if (!attempted) {
          addClientLog("beep.skip", {
            ...(extra ?? {}),
            reason,
            source: "ensure",
            sessionId: connectedSessionId,
            why: "audio_unavailable"
          });
          maybeHint("Beep unavailable. Tap the page once, unmute, then use Settings > Test beep.");
        }
        return;
      }
      schedule("ensure");
    });
  }, [ensureBeepAudio, addClientLog]);

  const handleCodexSignal = useCallback(
    (state: "running" | "idle" | "done") => {
      terminalCodexLockRef.current = state === "running";
      clearTerminalCodexTimer();
      setTerminalCodexState(state);
      const key = currentKeyRef.current;
      if (key) {
        updateSessionMeta(key, { codexState: state });
      }
      if (beepOnCodexDone && state === "done") {
        playBeep("codex_done", { trigger: "osc777", sessionKey: key ?? "" });
      }
    },
    [beepOnCodexDone, clearTerminalCodexTimer, playBeep, updateSessionMeta]
  );

  const playBeepPreview = useCallback(
    (reason: string = "test") => {
      const state = beepRef.current;
      const connectedSessionId = connRef.current.status === "connected" ? connRef.current.sessionId : null;
      const nowMs = Date.now();
      const elapsedMs = nowMs - state.lastBeepAtMs;
      if (elapsedMs >= 0 && elapsedMs < 800) {
        addClientLog("beep.skip", {
          reason,
          source: "preview",
          sessionId: connectedSessionId,
          why: "cooldown",
          elapsedMs
        });
        return;
      }

      let el = beepElementRef.current;
      if (!el && typeof Audio === "function") {
        try {
          el = new Audio(beepUrl);
          el.preload = "auto";
          beepElementRef.current = el;
        } catch {
          el = null;
        }
      }

      if (!el) {
        playBeep(reason, { trigger: "preview", fallbackFrom: "no_html_audio" });
        void ensureBeepAudio();
        return;
      }

      state.lastBeepAtMs = nowMs;
      try {
        el.muted = false;
        el.volume = 1;
        try {
          el.pause();
        } catch {
          // ignore
        }
        try {
          el.currentTime = 0;
        } catch {
          // ignore
        }

        const maybe = el.play();
        void ensureBeepAudio();
        if (maybe && typeof (maybe as any).then === "function" && typeof (maybe as any).catch === "function") {
          (maybe as any)
            .then(() => {
              addClientLog("beep.play", {
                reason,
                source: "preview",
                sessionId: connectedSessionId,
                method: "html_audio"
              });
            })
            .catch(() => {
              // If media playback is blocked, fall back to WebAudio.
              state.lastBeepAtMs = 0;
              playBeep(reason, { trigger: "preview", fallbackFrom: "html_audio_blocked" });
            });
        } else {
          addClientLog("beep.play", {
            reason,
            source: "preview",
            sessionId: connectedSessionId,
            method: "html_audio"
          });
        }
      } catch {
        state.lastBeepAtMs = 0;
        playBeep(reason, { trigger: "preview", fallbackFrom: "html_audio_error" });
        void ensureBeepAudio();
      }
    },
    [ensureBeepAudio, playBeep, addClientLog]
  );

  useEffect(() => {
    return () => {
      const state = beepRef.current;
      try {
        state.ctx?.close();
      } catch {
        // ignore
      }
      state.ctx = null;
      state.masterGain = null;
      state.buffer = null;
      state.bufferPromise = null;
      try {
        beepElementRef.current?.pause();
      } catch {
        // ignore
      }
      beepElementRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!beepOnCodexDone) return;
    if (typeof window === "undefined") return;
    let cancelled = false;
    const unlock = () => {
      if (cancelled) return;
      void ensureBeepAudio();
    };
    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("touchstart", unlock, { passive: true });
    window.addEventListener("keydown", unlock);
    return () => {
      cancelled = true;
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("touchstart", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [beepOnCodexDone, ensureBeepAudio]);

  useEffect(() => {
    if (!ttsPlayerRef.current) {
      ttsPlayerRef.current = new PcmPlayer();
    }
    return () => {
      ttsPlayerRef.current?.stop();
      ttsPlayerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!briefPlayerRef.current) {
      briefPlayerRef.current = new PcmPlayer();
    }
    return () => {
      briefPlayerRef.current?.stop();
      briefPlayerRef.current = null;
    };
  }, []);

  const ensureTtsAudio = useCallback(
    async (trigger: string): Promise<boolean> => {
      if (!ttsPlayerRef.current) {
        ttsPlayerRef.current = new PcmPlayer();
      }
      const player = ttsPlayerRef.current;
      if (!player) return false;

      if (trigger === "unlock") {
        const now = Date.now();
        const elapsed = now - ttsAudioAttemptAtRef.current;
        if (elapsed >= 0 && elapsed < 1500) return false;
        ttsAudioAttemptAtRef.current = now;
      }

      const before = player.getState();
      if (before === "running") {
        ttsAudioUnlockedRef.current = true;
        return true;
      }

      try {
        await player.resume();
        const after = player.getState();
        if (after === "running") ttsAudioUnlockedRef.current = true;
        addClientLog("tts.audio.resume", { trigger, before, after });
        return after === "running";
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        addClientLog("tts.audio.resume_error", { trigger, before, error: message });
        if (trigger !== "ws_open") {
          const now = Date.now();
          if (now - ttsAudioHintAtRef.current > 12_000) {
            ttsAudioHintAtRef.current = now;
            setStatusLine("TTS audio blocked by browser. Tap the page once, then use Settings > Test TTS.");
          }
        }
        return false;
      }
    },
    [addClientLog]
  );

  const ensureBriefAudio = useCallback(
    async (trigger: string): Promise<boolean> => {
      if (!briefPlayerRef.current) {
        briefPlayerRef.current = new PcmPlayer();
      }
      const player = briefPlayerRef.current;
      if (!player) return false;

      if (trigger === "unlock") {
        const now = Date.now();
        const elapsed = now - briefAudioAttemptAtRef.current;
        if (elapsed >= 0 && elapsed < 1500) return false;
        briefAudioAttemptAtRef.current = now;
      }

      const before = player.getState();
      if (before === "running") {
        briefAudioUnlockedRef.current = true;
        return true;
      }

      try {
        await player.resume();
        const after = player.getState();
        if (after === "running") briefAudioUnlockedRef.current = true;
        addClientLog("brief.audio.resume", { trigger, before, after });
        return after === "running";
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        addClientLog("brief.audio.resume_error", { trigger, before, error: message });
        return false;
      }
    },
    [addClientLog]
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    const unlock = () => {
      if (cancelled) return;
      if (briefAudioUnlockedRef.current) return;
      void ensureBriefAudio("unlock");
    };
    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("touchstart", unlock, { passive: true });
    window.addEventListener("keydown", unlock);
    return () => {
      cancelled = true;
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("touchstart", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [ensureBriefAudio]);

  useEffect(() => {
    if (!ttsEnabled) return;
    if (ttsEngine === "browser") return;
    if (typeof window === "undefined") return;
    let cancelled = false;
    const unlock = () => {
      if (cancelled) return;
      if (ttsAudioUnlockedRef.current) return;
      void ensureTtsAudio("unlock");
    };
    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("touchstart", unlock, { passive: true });
    window.addEventListener("keydown", unlock);
    return () => {
      cancelled = true;
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("touchstart", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [ttsEnabled, ttsEngine, ensureTtsAudio]);

  useEffect(() => {
    ttsPlayerRef.current?.setVolume(ttsVolume);
    briefPlayerRef.current?.setVolume(ttsVolume);
  }, [ttsVolume]);

  useEffect(() => {
    ttsPlayerRef.current?.setRate(ttsRate);
    briefPlayerRef.current?.setRate(ttsRate);
  }, [ttsRate]);

  const basePath = useMemo(() => resolveBasePath(), []);
  const apiBase = useMemo(() => (basePath ? `${basePath}/api` : "/api"), [basePath]);
  const docsUrl = useMemo(() => (basePath ? `${basePath}/docs.html` : "/docs.html"), [basePath]);
  const tasksUrl = useMemo(() => (basePath ? `${basePath}/tasks` : "/tasks"), [basePath]);
  const maskStyleForSvgButton = useCallback(
    (name: string): CSSProperties => {
      const resolved = `${basePath}/svg-buttons-assets/${encodeURIComponent(name)}`;
      const image = `url("${resolved}")`;
      return {
        WebkitMaskImage: image,
        maskImage: image
      } as CSSProperties;
    },
    [basePath]
  );

  const runCodexBrief = useCallback(async () => {
    if (briefRunning) return;
    setBriefRunning(true);
    setBriefStatus("Generating…");

    const controller = new AbortController();
    try {
      briefAbortRef.current?.abort();
    } catch {
      // ignore
    }
    briefAbortRef.current = controller;

    void ensureBriefAudio("click");
    const startedAt = Date.now();
    try {
      const payload = briefPrefsReady ? { prefs: briefPrefs } : {};
      const data = await postJson<BriefRunResponse>(`${apiBase}/brief/run`, payload, { signal: controller.signal });
      setBriefLastCost(data.cost ?? null);
      setBriefLastReportJson(typeof data.reportJsonText === "string" ? data.reportJsonText : "");
      setBriefLastSpokenScript(typeof data.report?.spoken_script === "string" ? data.report.spoken_script : "");

      const pcm = base64ToArrayBuffer(data.audio?.base64 || "");
      if (pcm.byteLength > 0) {
        briefPlayerRef.current?.setFormat({
          format: "pcm16",
          sampleRate: Number(data.audio?.sampleRate) || 24_000,
          channels: Number(data.audio?.channels) || 1
        });
        briefPlayerRef.current?.enqueuePCM16(pcm);
      }

      addClientLog("brief.run.ok", {
        tookMs: Date.now() - startedAt,
        audioSeconds: data.audio?.seconds ?? null,
        costCents: data.cost?.totalCents ?? null
      });
      const costLabel = formatCentsShort(data.cost?.totalCents ?? null);
      setBriefStatus(costLabel ? `Playing (${costLabel})` : "Playing");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addClientLog("brief.run.error", { error: message });
      if (controller.signal.aborted) {
        setBriefStatus("Canceled.");
      } else {
        setBriefStatus(`Brief failed: ${message}`);
      }
    } finally {
      if (briefAbortRef.current === controller) briefAbortRef.current = null;
      setBriefRunning(false);
    }
  }, [addClientLog, apiBase, briefPrefs, briefPrefsReady, briefRunning, ensureBriefAudio]);

  const wsBase = useMemo(() => {
    const isHttps = window.location.protocol === "https:";
    return isHttps ? "wss:" : "ws:";
  }, []);
  const speechSupported = useMemo(() => typeof window !== "undefined" && "speechSynthesis" in window, []);
  const speechEnabled = useMemo(() => {
    if (!ttsEnabled || !speechSupported) return false;
    if (ttsEngine === "browser") return true;
    return ttsFallbackEnabled && !ttsServerActive;
  }, [ttsEnabled, ttsEngine, ttsFallbackEnabled, ttsServerActive, speechSupported]);
  const browserVoiceOptions = useMemo(() => {
    if (!browserVoices.length) return [];
    return [...browserVoices].sort((a, b) => {
      const lang = a.lang.localeCompare(b.lang);
      if (lang !== 0) return lang;
      return a.name.localeCompare(b.name);
    });
  }, [browserVoices]);

  useEffect(() => {
    if (!speechSupported) return;
    const synth = window.speechSynthesis;
    const updateVoices = () => {
      const voices = synth.getVoices();
      setBrowserVoices(voices ?? []);
    };
    updateVoices();
    synth.addEventListener("voiceschanged", updateVoices);
    return () => {
      synth.removeEventListener("voiceschanged", updateVoices);
    };
  }, [speechSupported]);

  useEffect(() => {
    if (!speechSupported) return;
    if (!browserVoiceOptions.length) return;
    if (ttsBrowserVoice && browserVoiceOptions.some((voice) => voice.name === ttsBrowserVoice)) return;
    const preferred =
      browserVoiceOptions.find(
        (voice) =>
          /google/i.test(voice.name) &&
          /(uk|gb|british)/i.test(voice.name) &&
          /(female|woman)/i.test(voice.name)
      ) ??
      browserVoiceOptions.find(
        (voice) => /en-GB/i.test(voice.lang) && /(female|woman)/i.test(voice.name)
      ) ??
      browserVoiceOptions.find((voice) => /en-GB/i.test(voice.lang) && /google/i.test(voice.name)) ??
      browserVoiceOptions.find((voice) => voice.default) ??
      browserVoiceOptions[0];
    if (preferred) setTtsBrowserVoice(preferred.name);
  }, [speechSupported, browserVoiceOptions, ttsBrowserVoice]);

  const applyAudioPrefs = useCallback((prefs: Partial<AudioPrefs>) => {
    if (!prefs || typeof prefs !== "object") return;
    if (typeof prefs.ttsEnabled === "boolean") setTtsEnabled(prefs.ttsEnabled);
    if (prefs.ttsEngine === "openai" || prefs.ttsEngine === "piper" || prefs.ttsEngine === "browser") {
      setTtsEngine(prefs.ttsEngine);
    }
    if (prefs.ttsSource === "terminal" || prefs.ttsSource === "codex") setTtsSource(prefs.ttsSource);
    if (typeof prefs.ttsVoice === "string") setTtsVoice(prefs.ttsVoice);
    if (typeof prefs.ttsBrowserVoice === "string") setTtsBrowserVoice(prefs.ttsBrowserVoice);
    if (typeof prefs.ttsVolume === "number" && Number.isFinite(prefs.ttsVolume)) {
      setTtsVolume(Math.max(0, Math.min(1, prefs.ttsVolume)));
    }
    if (typeof prefs.ttsRate === "number" && Number.isFinite(prefs.ttsRate)) {
      setTtsRate(Math.max(0.5, Math.min(2, prefs.ttsRate)));
    }
    if (typeof prefs.ttsFallbackEnabled === "boolean") setTtsFallbackEnabled(prefs.ttsFallbackEnabled);
    if (typeof prefs.sttEnabled === "boolean") setSttEnabled(prefs.sttEnabled);
    if (prefs.sttEngine === "cpp" || prefs.sttEngine === "openai") setSttEngine(prefs.sttEngine);
    if (typeof prefs.sttModel === "string") setSttModel(prefs.sttModel);
    if (typeof prefs.sttLang === "string") setSttLang(prefs.sttLang);
  }, []);

	const getAudioPrefsPayload = useCallback(
		(overrides?: Partial<AudioPrefs>): AudioPrefs => {
      const nextTtsEnabled = typeof overrides?.ttsEnabled === "boolean" ? overrides.ttsEnabled : ttsEnabled;
      const nextTtsEngine =
        overrides?.ttsEngine === "openai" || overrides?.ttsEngine === "piper" || overrides?.ttsEngine === "browser"
          ? overrides.ttsEngine
          : ttsEngine;
      const nextTtsSource =
        overrides?.ttsSource === "terminal" || overrides?.ttsSource === "codex" ? overrides.ttsSource : ttsSource;
      const nextTtsVoice = typeof overrides?.ttsVoice === "string" ? overrides.ttsVoice : ttsVoice;
      const nextTtsBrowserVoice =
        typeof overrides?.ttsBrowserVoice === "string" ? overrides.ttsBrowserVoice : ttsBrowserVoice;
      const nextTtsVolume =
        typeof overrides?.ttsVolume === "number" && Number.isFinite(overrides.ttsVolume)
          ? overrides.ttsVolume
          : ttsVolume;
      const nextTtsRate =
        typeof overrides?.ttsRate === "number" && Number.isFinite(overrides.ttsRate)
          ? overrides.ttsRate
          : ttsRate;
      const nextTtsFallbackEnabled =
        typeof overrides?.ttsFallbackEnabled === "boolean" ? overrides.ttsFallbackEnabled : ttsFallbackEnabled;
      const nextSttEnabled = typeof overrides?.sttEnabled === "boolean" ? overrides.sttEnabled : sttEnabled;
      const nextSttEngine =
        overrides?.sttEngine === "cpp" || overrides?.sttEngine === "openai" ? overrides.sttEngine : sttEngine;
      const nextSttModel = typeof overrides?.sttModel === "string" ? overrides.sttModel : sttModel;
      const nextSttLang = typeof overrides?.sttLang === "string" ? overrides.sttLang : sttLang;
      return {
        ttsEnabled: nextTtsEnabled,
        ttsEngine: nextTtsEngine,
        ttsSource: nextTtsSource,
        ttsVoice: nextTtsVoice,
        ttsBrowserVoice: nextTtsBrowserVoice,
        ttsVolume: Math.max(0, Math.min(1, nextTtsVolume)),
        ttsRate: Math.max(0.5, Math.min(2, nextTtsRate)),
        ttsFallbackEnabled: nextTtsFallbackEnabled,
        sttEnabled: nextSttEnabled,
        sttEngine: nextSttEngine,
        sttModel: nextSttModel,
        sttLang: nextSttLang
      };
    },
    [
      ttsEnabled,
      ttsEngine,
      ttsSource,
      ttsVoice,
      ttsBrowserVoice,
      ttsVolume,
      ttsRate,
      ttsFallbackEnabled,
      sttEnabled,
      sttEngine,
      sttModel,
      sttLang
		]
	);

	const getAudioPrefsPayloadRef = useRef(getAudioPrefsPayload);
	useEffect(() => {
		getAudioPrefsPayloadRef.current = getAudioPrefsPayload;
	}, [getAudioPrefsPayload]);

		useEffect(() => {
			let cancelled = false;
			audioPrefsReadyRef.current = false;
      setAudioPrefsReady(false);
      audioPrefsPendingSerializedRef.current = null;
      audioPrefsPendingPayloadRef.current = null;
			if (typeof document !== "undefined") {
				document.documentElement.dataset.audioPrefsReady = "0";
			}
			(async () => {
				try {
				const data = await getJson<{ audio?: Partial<AudioPrefs> | null }>(`${apiBase}/prefs/audio`);
				if (!cancelled) {
					if (data?.audio) {
						audioPrefsLastSavedRef.current = JSON.stringify(getAudioPrefsPayloadRef.current(data.audio));
						applyAudioPrefs(data.audio);
					} else {
						audioPrefsLastSavedRef.current = JSON.stringify(getAudioPrefsPayloadRef.current());
					}
				}
			} catch {
				// ignore prefs load failures
				if (!cancelled) {
					audioPrefsLastSavedRef.current = JSON.stringify(getAudioPrefsPayloadRef.current());
				}
				} finally {
					if (!cancelled) {
						audioPrefsReadyRef.current = true;
            setAudioPrefsReady(true);
						if (typeof document !== "undefined") {
							document.documentElement.dataset.audioPrefsReady = "1";
						}
					}
				}
			})();
			return () => {
				cancelled = true;
			};
		}, [apiBase, applyAudioPrefs]);

    const saveAudioPrefsPending = useCallback(
      async (reason: string) => {
        if (!audioPrefsReadyRef.current) return;
        if (audioPrefsSaveInFlightRef.current) return;
        const serialized = audioPrefsPendingSerializedRef.current;
        const payload = audioPrefsPendingPayloadRef.current;
        if (!serialized || !payload) return;
        if (serialized === audioPrefsLastSavedRef.current) {
          audioPrefsPendingSerializedRef.current = null;
          audioPrefsPendingPayloadRef.current = null;
          audioPrefsSaveRetryDelayRef.current = 0;
          if (audioPrefsSaveRetryTimerRef.current) {
            window.clearTimeout(audioPrefsSaveRetryTimerRef.current);
            audioPrefsSaveRetryTimerRef.current = null;
          }
          return;
        }

        const savingSerialized = serialized;
        audioPrefsSaveInFlightRef.current = true;
        try {
          await postJson<{ audio: Partial<AudioPrefs> }>(`${apiBase}/prefs/audio`, payload);
          audioPrefsLastSavedRef.current = savingSerialized;
          if (audioPrefsPendingSerializedRef.current === savingSerialized) {
            audioPrefsPendingSerializedRef.current = null;
            audioPrefsPendingPayloadRef.current = null;
          }
          audioPrefsSaveRetryDelayRef.current = 0;
          if (audioPrefsSaveRetryTimerRef.current) {
            window.clearTimeout(audioPrefsSaveRetryTimerRef.current);
            audioPrefsSaveRetryTimerRef.current = null;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn("[prefs/audio] save failed", { reason, error: message });
          const prevDelay = audioPrefsSaveRetryDelayRef.current;
          const nextDelay = prevDelay ? Math.min(30_000, Math.round(prevDelay * 2)) : 1_200;
          audioPrefsSaveRetryDelayRef.current = nextDelay;
          if (!audioPrefsSaveRetryTimerRef.current) {
            audioPrefsSaveRetryTimerRef.current = window.setTimeout(() => {
              audioPrefsSaveRetryTimerRef.current = null;
              void saveAudioPrefsPending("retry");
            }, nextDelay);
          }
        } finally {
          audioPrefsSaveInFlightRef.current = false;
        }
      },
      [apiBase]
    );

    useEffect(() => {
      if (!audioPrefsReady) return;
      if (audioPrefsSaveTimerRef.current) {
        window.clearTimeout(audioPrefsSaveTimerRef.current);
        audioPrefsSaveTimerRef.current = null;
      }
      const payload = getAudioPrefsPayload();
      const serialized = JSON.stringify(payload);
      if (serialized === audioPrefsLastSavedRef.current) {
        audioPrefsPendingSerializedRef.current = null;
        audioPrefsPendingPayloadRef.current = null;
        return;
      }

      audioPrefsPendingSerializedRef.current = serialized;
      audioPrefsPendingPayloadRef.current = payload;
      audioPrefsSaveTimerRef.current = window.setTimeout(() => {
        audioPrefsSaveTimerRef.current = null;
        void saveAudioPrefsPending("debounce");
      }, 400);
      return () => {
        if (audioPrefsSaveTimerRef.current) {
          window.clearTimeout(audioPrefsSaveTimerRef.current);
          audioPrefsSaveTimerRef.current = null;
        }
      };
    }, [apiBase, audioPrefsReady, getAudioPrefsPayload, saveAudioPrefsPending]);

    useEffect(() => {
      const url = `${apiBase}/prefs/audio`;
      const flush = (reason: string) => {
        if (!audioPrefsReadyRef.current) return;
        if (audioPrefsSaveTimerRef.current) {
          window.clearTimeout(audioPrefsSaveTimerRef.current);
          audioPrefsSaveTimerRef.current = null;
        }
        const payload = audioPrefsPendingPayloadRef.current ?? getAudioPrefsPayloadRef.current();
        const serialized = JSON.stringify(payload);
        if (serialized === audioPrefsLastSavedRef.current) return;
        audioPrefsPendingSerializedRef.current = serialized;
        audioPrefsPendingPayloadRef.current = payload;

        const body = JSON.stringify(payload);
        try {
          const blob = new Blob([body], { type: "application/json" });
          if (navigator.sendBeacon(url, blob)) return;
        } catch {
          // ignore beacon failures
        }
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          keepalive: true
        }).catch(() => {
          // ignore flush failures
        });
      };
      const onPageHide = () => flush("pagehide");
      const onVisibilityChange = () => {
        if (document.visibilityState === "hidden") flush("hidden");
      };
      window.addEventListener("pagehide", onPageHide);
      document.addEventListener("visibilitychange", onVisibilityChange);
      return () => {
        window.removeEventListener("pagehide", onPageHide);
        document.removeEventListener("visibilitychange", onVisibilityChange);
      };
    }, [apiBase]);

    useEffect(() => {
      let cancelled = false;
      briefPrefsReadyRef.current = false;
      setBriefPrefsReady(false);
      briefPrefsPendingSerializedRef.current = null;
      briefPrefsPendingPayloadRef.current = null;
      if (typeof document !== "undefined") {
        document.documentElement.dataset.briefPrefsReady = "0";
      }
      (async () => {
        try {
          const data = await getJson<{ brief?: Partial<BriefPrefs> | null }>(`${apiBase}/prefs/brief`);
          if (cancelled) return;
          const normalized = normalizeBriefPrefs(data?.brief ?? null);
          briefPrefsLastSavedRef.current = JSON.stringify(normalized);
          setBriefPrefs(normalized);
        } catch {
          if (!cancelled) {
            const normalized = { ...DEFAULT_BRIEF_PREFS };
            briefPrefsLastSavedRef.current = JSON.stringify(normalized);
            setBriefPrefs(normalized);
          }
        } finally {
          if (!cancelled) {
            briefPrefsReadyRef.current = true;
            setBriefPrefsReady(true);
            if (typeof document !== "undefined") {
              document.documentElement.dataset.briefPrefsReady = "1";
            }
          }
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [apiBase]);

    const saveBriefPrefsPending = useCallback(
      async (reason: string) => {
        if (!briefPrefsReadyRef.current) return;
        if (briefPrefsSaveInFlightRef.current) return;
        const serialized = briefPrefsPendingSerializedRef.current;
        const payload = briefPrefsPendingPayloadRef.current;
        if (!serialized || !payload) return;
        if (serialized === briefPrefsLastSavedRef.current) {
          briefPrefsPendingSerializedRef.current = null;
          briefPrefsPendingPayloadRef.current = null;
          briefPrefsSaveRetryDelayRef.current = 0;
          if (briefPrefsSaveRetryTimerRef.current) {
            window.clearTimeout(briefPrefsSaveRetryTimerRef.current);
            briefPrefsSaveRetryTimerRef.current = null;
          }
          return;
        }

        const savingSerialized = serialized;
        briefPrefsSaveInFlightRef.current = true;
        try {
          await postJson<{ brief: Partial<BriefPrefs> }>(`${apiBase}/prefs/brief`, payload);
          briefPrefsLastSavedRef.current = savingSerialized;
          if (briefPrefsPendingSerializedRef.current === savingSerialized) {
            briefPrefsPendingSerializedRef.current = null;
            briefPrefsPendingPayloadRef.current = null;
          }
          briefPrefsSaveRetryDelayRef.current = 0;
          if (briefPrefsSaveRetryTimerRef.current) {
            window.clearTimeout(briefPrefsSaveRetryTimerRef.current);
            briefPrefsSaveRetryTimerRef.current = null;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn("[prefs/brief] save failed", { reason, error: message });
          const prevDelay = briefPrefsSaveRetryDelayRef.current;
          const nextDelay = prevDelay ? Math.min(30_000, Math.round(prevDelay * 2)) : 1_200;
          briefPrefsSaveRetryDelayRef.current = nextDelay;
          if (!briefPrefsSaveRetryTimerRef.current) {
            briefPrefsSaveRetryTimerRef.current = window.setTimeout(() => {
              briefPrefsSaveRetryTimerRef.current = null;
              void saveBriefPrefsPending("retry");
            }, nextDelay);
          }
        } finally {
          briefPrefsSaveInFlightRef.current = false;
        }
      },
      [apiBase]
    );

    useEffect(() => {
      if (!briefPrefsReady) return;
      if (briefPrefsSaveTimerRef.current) {
        window.clearTimeout(briefPrefsSaveTimerRef.current);
        briefPrefsSaveTimerRef.current = null;
      }
      const payload: BriefPrefs = {
        ...briefPrefs,
        tasksIncludeGlobs: [...briefPrefs.tasksIncludeGlobs],
        tasksExcludeGlobs: [...briefPrefs.tasksExcludeGlobs]
      };
      const serialized = JSON.stringify(payload);
      if (serialized === briefPrefsLastSavedRef.current) {
        briefPrefsPendingSerializedRef.current = null;
        briefPrefsPendingPayloadRef.current = null;
        return;
      }

      briefPrefsPendingSerializedRef.current = serialized;
      briefPrefsPendingPayloadRef.current = payload;
      briefPrefsSaveTimerRef.current = window.setTimeout(() => {
        briefPrefsSaveTimerRef.current = null;
        void saveBriefPrefsPending("debounce");
      }, 450);
      return () => {
        if (briefPrefsSaveTimerRef.current) {
          window.clearTimeout(briefPrefsSaveTimerRef.current);
          briefPrefsSaveTimerRef.current = null;
        }
      };
    }, [apiBase, briefPrefs, briefPrefsReady, saveBriefPrefsPending]);

    useEffect(() => {
      const url = `${apiBase}/prefs/brief`;
      const flush = (reason: string) => {
        if (!briefPrefsReadyRef.current) return;
        if (briefPrefsSaveTimerRef.current) {
          window.clearTimeout(briefPrefsSaveTimerRef.current);
          briefPrefsSaveTimerRef.current = null;
        }
        const payload = briefPrefsPendingPayloadRef.current ?? briefPrefs;
        const serialized = JSON.stringify(payload);
        if (serialized === briefPrefsLastSavedRef.current) return;
        briefPrefsPendingSerializedRef.current = serialized;
        briefPrefsPendingPayloadRef.current = payload;

        const body = JSON.stringify(payload);
        try {
          const blob = new Blob([body], { type: "application/json" });
          if (navigator.sendBeacon(url, blob)) return;
        } catch {
          // ignore beacon failures
        }
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          keepalive: true
        }).catch(() => {
          // ignore flush failures
        });
      };
      const onPageHide = () => flush("pagehide");
      const onVisibilityChange = () => {
        if (document.visibilityState === "hidden") flush("hidden");
      };
      window.addEventListener("pagehide", onPageHide);
      document.addEventListener("visibilitychange", onVisibilityChange);
      return () => {
        window.removeEventListener("pagehide", onPageHide);
        document.removeEventListener("visibilitychange", onVisibilityChange);
      };
    }, [apiBase, briefPrefs]);
  const activeSessionId = useMemo(
    () => (conn.status === "connected" ? conn.sessionId : null),
    [conn]
  );

  useEffect(() => {
    codexWorkingRef.current = null;
    codexPlainAssistantSigRef.current = "";
    codexDetectTailRef.current = "";
  }, [activeSessionId]);

  const makeWsUrl = useCallback(
    (path: string) => {
      const url = new URL(path, window.location.href);
      url.protocol = wsBase;
      return url.toString();
    },
    [wsBase]
  );

  const speakText = useCallback(
    (text: string) => {
      if (!speechSupported) return;
      const cleaned = text.trim();
      if (!cleaned) return;
      // E2E hook: tests inject `window.__CONSOLE_TTS_TEST__` to observe what would be spoken,
      // even in environments where native SpeechSynthesis methods are non-writable.
      try {
        const state = (window as any).__CONSOLE_TTS_TEST__;
        if (state && Array.isArray(state.speaks)) state.speaks.push(cleaned);
      } catch {
        // ignore
      }
      const synth = window.speechSynthesis;
      const before = {
        paused: Boolean(synth.paused),
        speaking: Boolean((synth as any).speaking),
        pending: Boolean((synth as any).pending)
      };
      if (synth.paused) {
        synth.resume();
      }
      const utter = new SpeechSynthesisUtterance(cleaned);
      let resolvedVoice = ttsBrowserVoice;
      if (ttsBrowserVoice) {
        const match = browserVoiceOptions.find((voice) => voice.name === ttsBrowserVoice);
        if (match) {
          utter.voice = match;
          resolvedVoice = match.name;
        }
      }
      utter.rate = Math.max(0.5, Math.min(2, ttsRate));
      utter.volume = Math.max(0, Math.min(1, ttsVolume));
      try {
        utter.onerror = (event: any) => {
          const error = typeof event?.error === "string" ? event.error : "unknown";
          addClientLog("tts.browser.error", {
            source: ttsSource,
            error,
            text: truncateMiddle(cleaned, 200)
          });
        };
      } catch {
        // ignore
      }
      addClientLog("tts.browser.speak", {
        source: ttsSource,
        voice: resolvedVoice,
        rate: utter.rate,
        volume: utter.volume,
        ...before,
        text: truncateMiddle(cleaned, 200)
      });
      console.log("[TTS browser] speak", {
        source: ttsSource,
        engine: "browser",
        voice: resolvedVoice,
        rate: utter.rate,
        volume: utter.volume,
        text: cleaned
      });
      synth.speak(utter);
    },
    [speechSupported, ttsBrowserVoice, browserVoiceOptions, ttsRate, ttsVolume, ttsSource, addClientLog]
  );

  const testTts = useCallback(async () => {
    const sample = "TTS test. If you can hear this, TTS is working.";
    addClientLog("tts.test", {
      engine: ttsEngine,
      source: ttsSource,
      enabled: ttsEnabled,
      fallbackEnabled: ttsFallbackEnabled,
      serverActive: ttsServerActive,
      speechSupported
    });

    const useBrowser = ttsEngine === "browser" || (ttsFallbackEnabled && !ttsServerActive);
    if (useBrowser) {
      if (!speechSupported) {
        setStatusLine("Browser TTS not supported.");
        addClientLog("tts.test.skip", { why: "speech_unsupported" });
        return;
      }
      speakText(sample);
      setStatusLine("TTS test sent (browser).");
      return;
    }

    if (!activeSessionId) {
      setStatusLine("Connect a session to test server TTS.");
      return;
    }

    await ensureTtsAudio("test");
    const ws = ttsWsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setStatusLine("TTS server not connected. Enable Speak output first.");
      addClientLog("tts.test.skip", { why: "ws_not_open" });
      return;
    }

    try {
      if (ttsSource !== "codex") {
        ws.send(JSON.stringify({ type: "config", voice: ttsVoice, engine: ttsEngine, source: "codex" }));
      }
      ws.send(JSON.stringify({ type: "say", text: sample }));
      if (ttsSource !== "codex") {
        ws.send(JSON.stringify({ type: "config", voice: ttsVoice, engine: ttsEngine, source: ttsSource }));
      }
      addClientLog("tts.test.sent", { mode: "server", text: truncateMiddle(sample, 120) });
      setStatusLine("TTS test sent (server).");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addClientLog("tts.test.error", { error: message });
      setStatusLine("TTS test failed. See client log.");
    }
  }, [
    addClientLog,
    activeSessionId,
    ensureTtsAudio,
    speechSupported,
    setStatusLine,
    speakText,
    ttsEnabled,
    ttsEngine,
    ttsFallbackEnabled,
    ttsServerActive,
    ttsSource,
    ttsVoice
  ]);

  const clearSpeechFlushTimer = useCallback(() => {
    if (speechFlushTimerRef.current) {
      window.clearTimeout(speechFlushTimerRef.current);
      speechFlushTimerRef.current = null;
    }
  }, []);

  const flushSpeechBuffer = useCallback(() => {
    const pending = speechBufferRef.current.trim();
    speechBufferRef.current = "";
    if (pending && isSpeakable(pending)) {
      speakText(pending);
    }
  }, [speakText]);

  const scheduleSpeechFlush = useCallback(() => {
    clearSpeechFlushTimer();
    speechFlushTimerRef.current = window.setTimeout(() => {
      speechFlushTimerRef.current = null;
      flushSpeechBuffer();
    }, 900);
  }, [clearSpeechFlushTimer, flushSpeechBuffer]);

  const handleSpeechChunk = useCallback(
    (chunk: string) => {
      if (!speechEnabled) return;
      const cleaned = sanitizeSpeechText(chunk);
      if (!cleaned) return;
      const normalized = cleaned.replace(/[ \t]+/g, " ");
      let buffer = speechBufferRef.current + normalized;
      const parts = buffer.split("\n");
      for (let i = 0; i < parts.length - 1; i += 1) {
        const line = parts[i].trim();
        if (line && isSpeakable(line)) speakText(line);
      }
      let tail = parts[parts.length - 1];
      const maxChunk = 200;
      while (tail.length > maxChunk) {
        const slice = tail.slice(0, maxChunk);
        if (isSpeakable(slice)) speakText(slice);
        tail = tail.slice(maxChunk);
      }
      if (/[.!?]\s*$/.test(tail)) {
        const trimmed = tail.trim();
        if (trimmed && isSpeakable(trimmed)) {
          speakText(trimmed);
          tail = "";
        }
      }
      speechBufferRef.current = tail;
      if (tail) {
        scheduleSpeechFlush();
      } else {
        clearSpeechFlushTimer();
      }
    },
    [speechEnabled, speakText, scheduleSpeechFlush, clearSpeechFlushTimer]
  );

  const handleTerminalOutput = useCallback(
    (chunk: string) => {
      scrollbackDirtyRef.current = true;
      const cleaned = stripAnsi(chunk);
      const normalized = cleaned.replace(/\r/g, "\n");
      if (!terminalReadyRef.current) {
        const visible = normalized.replace(/\s+/g, "");
        if (visible) {
          terminalReadyRef.current = true;
          setTerminalReady(true);
          addClientLog("terminal.ready", {
            sessionId: connRef.current.status === "connected" ? connRef.current.sessionId : undefined
          });
        }
      }
      if (CODEX_CLI_ACTIVITY_REGEX.test(normalized)) {
        bumpTerminalCodexActivity();
      }
      if (beepOnCodexDone) {
        if (CODEX_CLI_WORKING_REGEX.test(normalized)) {
          codexWorkingRef.current = "prompt";
        }
        const tail = (codexDetectTailRef.current + normalized).slice(-CODEX_CLI_PROMPT_TAIL_MAX_CHARS);
        codexDetectTailRef.current = tail;
        const assistantSig = getCodexPlainAssistantSignature(tail);
        if (assistantSig && assistantSig !== codexPlainAssistantSigRef.current) {
          codexPlainAssistantSigRef.current = assistantSig;
          if (codexWorkingRef.current !== "prompt") {
            codexWorkingRef.current = "plain";
          }
        }
        const mode = codexWorkingRef.current;
        const donePrompt = hasCodexPromptNearEnd(tail);
        const donePlain = hasCodexPlainPromptAfterAssistantNearEnd(tail);
        if (mode === "prompt" && donePrompt) {
          codexWorkingRef.current = null;
          playBeep("codex_done", { trigger: "terminal_output", mode });
        } else if (mode === "plain" && donePlain) {
          codexWorkingRef.current = null;
          playBeep("codex_done", { trigger: "terminal_output", mode });
        }
      }
      if (ttsSource !== "terminal") return;
      if (ttsEnabled) {
        const cleaned = sanitizeSpeechText(chunk).trim();
        if (cleaned) {
          console.log("[TTS client] output", {
            source: "terminal",
            engine: ttsEngine,
            voice: ttsEngine === "browser" ? ttsBrowserVoice : ttsVoice,
            text: cleaned
          });
        }
      }
      handleSpeechChunk(chunk);
    },
    [
      beepOnCodexDone,
      ttsSource,
      ttsEnabled,
      ttsEngine,
      ttsVoice,
      ttsBrowserVoice,
      handleSpeechChunk,
      playBeep,
      bumpTerminalCodexActivity,
      addClientLog
    ]
  );

  const handleCodexSpeech = useCallback(
    (chunk: string) => {
      if (!ttsEnabled || ttsSource !== "codex") return;
      if (ttsEngine === "browser" || (ttsFallbackEnabled && !ttsServerActive)) {
        handleSpeechChunk(chunk);
        return;
      }
      const ws = ttsWsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        console.log("[TTS client] enqueue", {
          source: ttsSource,
          engine: ttsEngine,
          voice: ttsVoice,
          text: chunk
        });
        ws.send(JSON.stringify({ type: "say", text: chunk }));
      }
    },
    [ttsEnabled, ttsSource, ttsEngine, ttsVoice, ttsFallbackEnabled, ttsServerActive, handleSpeechChunk]
  );

  useEffect(() => {
    if (!speechSupported) return;
    if (!speechEnabled) {
      clearSpeechFlushTimer();
      window.speechSynthesis.cancel();
      speechBufferRef.current = "";
    }
  }, [speechEnabled, speechSupported, clearSpeechFlushTimer]);

  useEffect(() => {
    return () => {
      clearSpeechFlushTimer();
    };
  }, [clearSpeechFlushTimer]);

  useEffect(() => {
    return () => {
      clearTerminalCodexTimer();
    };
  }, [clearTerminalCodexTimer]);

  useEffect(() => {
    if (conn.status === "connected") return;
    terminalCodexLockRef.current = false;
    clearTerminalCodexTimer();
    setTerminalCodexState("idle");
  }, [conn.status, clearTerminalCodexTimer]);

  useEffect(() => {
    if (conn.status !== "connected") return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      if (!scrollbackDirtyRef.current) return;
      const ok = persistScrollback();
      if (ok) scrollbackDirtyRef.current = false;
    }, SNAPSHOT_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [conn.status, persistScrollback]);

  useEffect(() => {
    const handlePageHide = () => persistScrollback();
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        persistScrollback();
      }
    };
    window.addEventListener("pagehide", handlePageHide);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [persistScrollback]);

  const refreshSessions = useCallback(async () => {
    try {
      const active = await getJson<{ sessions: SessionSummary[] }>(`${apiBase}/sessions`);
      const seen = new Set<string>();
      const next = (active.sessions ?? []).filter((session) => {
        if (!session?.id) return false;
        if (seen.has(session.id)) return false;
        seen.add(session.id);
        return true;
      });
      setActiveSessions(next);
    } catch {
      // ignore
    }
    try {
      const saved = await getJson<{ sessions: PersistentSession[] }>(`${apiBase}/sessions/persistent`);
      const seen = new Set<string>();
      const next = (saved.sessions ?? []).filter((session) => {
        const name = (session?.name ?? "").trim();
        if (!name) return false;
        if (seen.has(name)) return false;
        seen.add(name);
        return true;
      });
      setSavedSessions(next);
    } catch {
      // ignore
    }
  }, [apiBase]);

  const attachOrCreate = useCallback(
    async (options?: { mode?: Mode; readonlyPath?: string; tmuxName?: string; launchTerminal?: boolean }) => {
      if (attachInFlightRef.current) return attachInFlightRef.current;
      const run = (async () => {
	        try {
	          const sinceLast = Date.now() - lastAttachAtRef.current;
	          if (sinceLast > 0 && sinceLast < MIN_ATTACH_GAP_MS) {
	            await new Promise((resolve) => setTimeout(resolve, MIN_ATTACH_GAP_MS - sinceLast));
	          }
	          lastAttachAtRef.current = Date.now();
	          const effectiveMode = options?.mode ?? mode;
	          const tmuxName = options?.tmuxName;
	          const fallbackTmuxName =
	            effectiveMode === "tmux" && !tmuxName ? loadLastTmuxName(sessionStore) : null;
	          addClientLog("attach_or_create.start", {
	            mode: effectiveMode,
	            readonlyPath: options?.readonlyPath,
	            tmuxName,
	            fallbackTmuxName: fallbackTmuxName ?? undefined,
	            launchTerminal: options?.launchTerminal
	          });
	          setStatusLine("Connecting…");
	          setConn({ status: "connecting" });
	          const size = getTerminalSize();
	          const initialSnapshot = getInitialSnapshot();
	          const preferredCwd = getLastKnownCwd();
	          const body: Record<string, any> = {
	            resumeKey,
	            mode: effectiveMode,
	            ...(size ?? {})
	          };
	          if (preferredCwd) body.cwd = preferredCwd;
	          if (options?.readonlyPath) body.readonlyPath = options.readonlyPath;
	          if (tmuxName) body.tmuxName = tmuxName;
	          else if (fallbackTmuxName) body.tmuxName = fallbackTmuxName;
	          if (typeof options?.launchTerminal === "boolean") body.launchTerminal = options.launchTerminal;
	          if (initialSnapshot) body.initialSnapshot = initialSnapshot;

          const attach = await postJson<AttachOrCreateResponse>(`${apiBase}/sessions/attach-or-create`, body);
          safeSet(sessionStore, SESSION_STORAGE_KEY, attach.sessionId);
          if (attach.tmuxName) saveLastTmuxName(sessionStore, attach.tmuxName);
          setSessionId(attach.sessionId);
          const wsUrl = new URL(attach.wsUrl, window.location.href);
          wsUrl.protocol = wsBase;
          setConnectedConn({
            status: "connected",
            wsUrl: wsUrl.toString(),
            attachToken: attach.attachToken,
            sessionId: attach.sessionId
          });
          setStatusLine(`${attach.created ? "Connected" : "Reattached"} (${attach.sessionId})`);
          addClientLog("attach_or_create.ok", { sessionId: attach.sessionId, created: attach.created });
          refreshSessions();
          return attach;
        } catch (err) {
          const message = err instanceof Error ? err.message : "connect failed";
          setConn({ status: "idle" });
          setStatusLine(`Connect failed: ${message}`);
          addClientLog("attach_or_create.error", { error: message });
          throw err;
        }
      })();
      attachInFlightRef.current = run;
      try {
        return await run;
      } finally {
        if (attachInFlightRef.current === run) {
          attachInFlightRef.current = null;
        }
      }
    },
    [
      apiBase,
      wsBase,
      getTerminalSize,
      getInitialSnapshot,
      getLastKnownCwd,
      sessionStore,
      resumeKey,
      mode,
      refreshSessions,
      addClientLog,
      setConnectedConn
    ]
  );

  const clearReconnect = useCallback(
    (reason?: string) => {
      if (reconnectRef.current.timer) {
        window.clearTimeout(reconnectRef.current.timer);
        reconnectRef.current.timer = null;
      }
      if (reconnectRef.current.attempt !== 0) {
        reconnectRef.current.attempt = 0;
      }
      if (reason) addClientLog("reconnect.cleared", { reason });
    },
    [addClientLog]
  );

  const scheduleReconnect = useCallback(
    (reason: string, info?: DisconnectInfo) => {
      if (reconnectRef.current.timer || creatingSessionRef.current) return;
      const attempt = Math.min(reconnectRef.current.attempt + 1, 8);
      reconnectRef.current.attempt = attempt;
      const base = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1), RECONNECT_MAX_DELAY_MS);
      const jitter = 1 + (Math.random() * 2 - 1) * RECONNECT_JITTER;
      const delay = Math.max(0, Math.round(base * jitter));
      reconnectRef.current.timer = window.setTimeout(() => {
        reconnectRef.current.timer = null;
        if (connRef.current.status === "connected" || connRef.current.status === "connecting") return;
        void attachOrCreate().catch(() => {
          // attachOrCreate already updates status/logs.
        });
      }, delay);
      addClientLog("reconnect.scheduled", {
        attempt,
        delayMs: delay,
        reason,
        code: info?.code,
        wasClean: info?.wasClean,
        elapsedMs: info?.elapsedMs
      });
    },
    [attachOrCreate, addClientLog]
  );

  const handleSocketEvent = useCallback(
    (event: string, data?: Record<string, unknown>) => {
      addClientLog(event, data);
      if (event === "ws.open") {
        clearReconnect("ws_open");
        return;
      }
      if (event === "ws.snapshot") {
        // Snapshot is typically the first thing we render after attach; count it as "ready".
        if (!terminalReadyRef.current) {
          terminalReadyRef.current = true;
          setTerminalReady(true);
          addClientLog("terminal.ready", {
            sessionId: connRef.current.status === "connected" ? connRef.current.sessionId : undefined,
            source: "snapshot"
          });
        }
      }
    },
    [addClientLog, clearReconnect]
  );


  const connect = useCallback(
    async (sessionIdToConnect: string) => {
      try {
        addClientLog("connect.start", { sessionId: sessionIdToConnect });
        setStatusLine("Connecting…");
        setConn({ status: "connecting" });
        const size = getTerminalSize();
        const attach = await postJson<CreateSessionResponse>(`${apiBase}/sessions/${sessionIdToConnect}/attach`, {
          ...(size ?? {})
        });
        const wsUrl = new URL(attach.wsUrl, window.location.href);
        wsUrl.protocol = wsBase;
        safeSet(sessionStore, SESSION_STORAGE_KEY, attach.sessionId);
        setSessionId(attach.sessionId);
        setConnectedConn({
          status: "connected",
          wsUrl: wsUrl.toString(),
          attachToken: attach.attachToken,
          sessionId: attach.sessionId
        });
        setStatusLine(`Connected (${attach.sessionId})`);
        addClientLog("connect.ok", { sessionId: attach.sessionId });
      } catch (err) {
        const message = err instanceof Error ? err.message : "reconnect failed";
        addClientLog("connect.error", { sessionId: sessionIdToConnect, error: message });
        if (message === "Not found") {
          safeRemove(sessionStore, SESSION_STORAGE_KEY);
          setSessionId(null);
          try {
            await attachOrCreate();
          } catch {
            // attachOrCreate already updated status
          }
          return;
        }
        safeRemove(sessionStore, SESSION_STORAGE_KEY);
        setSessionId(null);
        setConn({ status: "idle" });
        setStatusLine(`Reconnect failed: ${message}. Create a new session.`);
      }
    },
    [apiBase, wsBase, getTerminalSize, sessionStore, attachOrCreate, setConnectedConn]
  );

  const onCreate = useCallback(async () => {
    try {
      clearReconnect("new_session");
      suppressDisconnectRef.current = true;
      setCreatingSession(true);
      addClientLog("new_session.start", { mode });

      let tmuxName: string | undefined;
      if (mode === "tmux" && promptTmuxNameOnCreate) {
        const last = loadLastTmuxName(sessionStore) || "";
        let suggested = last;
        for (;;) {
          const raw = window.prompt("tmux session name (letters/numbers . _ - only)", suggested);
          if (raw === null) {
            setStatusLine("Create cancelled.");
            addClientLog("new_session.cancelled", { mode, reason: "prompt_cancel" });
            return;
          }

          const trimmed = raw.trim();
          if (!trimmed) {
            setStatusLine("tmux name is required.");
            continue;
          }
          if (!isValidTmuxName(trimmed)) {
            const sanitized = sanitizeTmuxNameCandidate(trimmed);
            if (sanitized && sanitized !== trimmed) {
              setStatusLine(`Invalid tmux name. Try: ${sanitized}`);
              suggested = sanitized;
            } else {
              setStatusLine("Invalid tmux name. Use letters/numbers plus . _ - only.");
            }
            continue;
          }
          tmuxName = trimmed;
          break;
        }

        const existing = (() => {
          const candidates = activeSessions.filter((session) => session.mode === "tmux" && session.tmuxName === tmuxName);
          if (candidates.length === 0) return null;
          const current = candidates.find((session) => session.id === sessionId);
          if (current) return current;
          return candidates.reduce((best, session) => (session.lastActivityAt > best.lastActivityAt ? session : best));
        })();

        if (existing) {
          setStatusLine("Connecting…");
          addClientLog("new_session.reuse_existing_tmux", { tmuxName, sessionId: existing.id });
          safeSet(sessionStore, SESSION_STORAGE_KEY, existing.id);
          setSessionId(existing.id);
          await connect(existing.id);
          refreshSessions();
          return;
        }
      }

      setStatusLine("Creating session…");
      const size = getTerminalSize();
      const initialSnapshot = getInitialSnapshot();
      const preferredCwd = getLastKnownCwd();
      const created = await postJson<CreateSessionResponse>(`${apiBase}/sessions`, {
        mode,
        resumeKey,
        ...(mode === "tmux" && tmuxName ? { tmuxName } : {}),
        ...(mode === "tmux" && autoOpenMacosTerminal ? { launchTerminal: true } : {}),
        ...(size ?? {}),
        ...(preferredCwd ? { cwd: preferredCwd } : {}),
        ...(initialSnapshot ? { initialSnapshot } : {})
      });
      safeSet(sessionStore, SESSION_STORAGE_KEY, created.sessionId);
      if (created.tmuxName) saveLastTmuxName(sessionStore, created.tmuxName);
		      setSessionId(created.sessionId);

      const wsUrl = new URL(created.wsUrl, window.location.href);
      wsUrl.protocol = wsBase;
      setConnectedConn({
        status: "connected",
        wsUrl: wsUrl.toString(),
        attachToken: created.attachToken,
        sessionId: created.sessionId
      });
      setStatusLine(`Connected (${created.sessionId})`);
      addClientLog("new_session.ok", { sessionId: created.sessionId });
      refreshSessions();
    } catch (err) {
      const message = err instanceof Error ? err.message : "create failed";
      setStatusLine(`Create failed: ${message}`);
      addClientLog("new_session.error", { error: message });
    } finally {
      setCreatingSession(false);
      suppressDisconnectRef.current = false;
    }
  }, [
    apiBase,
    mode,
    promptTmuxNameOnCreate,
    autoOpenMacosTerminal,
    wsBase,
    refreshSessions,
    getTerminalSize,
    getInitialSnapshot,
    getLastKnownCwd,
    sessionStore,
    activeSessions,
    connect,
    sessionId,
    resumeKey,
    addClientLog,
    clearReconnect,
    setConnectedConn,
  ]);

  const onDisconnect = useCallback((info?: DisconnectInfo) => {
    if (suppressDisconnectRef.current) {
      setConn({ status: "idle" });
      addClientLog("disconnect.suppressed");
      return;
    }
    persistScrollback();
    setConn({ status: "disconnected" });
	    if (manualDisconnectRef.current) {
	      manualDisconnectRef.current = false;
	      setStatusLine("Disconnected (session still running).");
	      addClientLog("disconnect.manual");
	      return;
	    }
	    aiAutoBulkPendingRef.current = true;
	    setStatusLine("Disconnected");
	    addClientLog("disconnect.auto");
    if (info && info.opened === false) {
      scheduleReconnect("ws_closed_before_open", info);
    }
  }, [persistScrollback, scheduleReconnect, addClientLog]);

  const onReattach = useCallback(async () => {
    const stored = sessionId ?? safeGet(sessionStore, SESSION_STORAGE_KEY);
    if (!stored) return;
    try {
      clearReconnect("manual_reattach");
      addClientLog("reattach.start", { sessionId: stored });
      await attachOrCreate();
    } catch {
      // attachOrCreate already updated status
    }
  }, [attachOrCreate, sessionId, sessionStore, addClientLog, clearReconnect]);

  const onRefreshCurrentTab = useCallback(async () => {
    void refreshSessions();
    const stored = sessionId ?? safeGet(sessionStore, SESSION_STORAGE_KEY);
    if (!stored) return;
    if (connRef.current.status === "connecting") return;
    clearReconnect("manual_refresh_tab");
    await connect(stored);
    void refreshSessions();
  }, [connect, refreshSessions, sessionId, sessionStore, clearReconnect]);

  const onCloseSession = useCallback(async () => {
    const id = sessionId ?? safeGet(sessionStore, SESSION_STORAGE_KEY);
    if (!id) return;
    persistScrollback();
    clearReconnect("close_session");
    setStatusLine("Ending session…");
    try {
      addClientLog("end_session.start", { sessionId: id });
      await postJson<{ ok: boolean }>(`${apiBase}/sessions/${id}/close`);
    } catch {
      // best effort
    } finally {
      safeRemove(sessionStore, SESSION_STORAGE_KEY);
      setSessionId(null);
      setConn({ status: "idle" });
      setStatusLine("Session ended. Create a new session to continue.");
      addClientLog("end_session.done", { sessionId: id });
      refreshSessions();
    }
  }, [apiBase, sessionId, sessionStore, refreshSessions, persistScrollback, addClientLog, clearReconnect]);

  const deleteActiveSession = useCallback(
    async (id: string) => {
      if (!id) return;
      const stored = safeGet(sessionStore, SESSION_STORAGE_KEY);
      const isCurrent = id === sessionId || (stored && stored === id);
      if (isCurrent) {
        await onCloseSession();
        return;
      }
      setStatusLine("Ending session…");
      try {
        await postJson<{ ok: boolean }>(`${apiBase}/sessions/${id}/close`);
      } catch {
        // best effort
      } finally {
        setStatusLine("Session ended.");
        refreshSessions();
      }
    },
    [apiBase, onCloseSession, refreshSessions, sessionId, sessionStore]
  );

  const endAllActiveSessions = useCallback(async () => {
    if (activeSessions.length === 0) return;
    const current = sessionId ?? safeGet(sessionStore, SESSION_STORAGE_KEY);
    const others = activeSessions.map((s) => s.id).filter((id) => id && id !== current);
    const includesCurrent = Boolean(current) && activeSessions.some((s) => s.id === current);
    const total = activeSessions.length;

    const ok = window.confirm(
      `End ${total} active web session${total === 1 ? "" : "s"}?` +
        `\n\nThis detaches the web terminals. Your tmux sessions (server-side) will stay alive.` +
        (includesCurrent ? `\n\nThis will also end the current tab's session.` : "")
    );
    if (!ok) return;

    setStatusLine(`Ending ${total} session${total === 1 ? "" : "s"}…`);
    addClientLog("sessions.end_all.start", { total, current: current ?? undefined });

    let ended = 0;
    for (const id of others) {
      try {
        await postJson<{ ok: boolean }>(`${apiBase}/sessions/${id}/close`);
        ended += 1;
      } catch {
        // best effort
      }
    }

    if (includesCurrent && current) {
      await onCloseSession();
      return;
    }

    setStatusLine(`Ended ${ended} session${ended === 1 ? "" : "s"}.`);
    addClientLog("sessions.end_all.done", { ended, total, current: current ?? undefined });
    void refreshSessions();
  }, [activeSessions, apiBase, onCloseSession, refreshSessions, sessionId, sessionStore, addClientLog]);

  const deletePersistentSession = useCallback(
    async (name: string, options?: { force?: boolean }) => {
      if (!name) return;
      setStatusLine("Deleting session…");
      try {
        await postJson<{ ok: boolean }>(
          `${apiBase}/sessions/persistent/${encodeURIComponent(name)}/close`,
          options?.force ? { force: true } : undefined
        );
        setStatusLine("Session deleted.");
      } catch (err) {
        const message = err instanceof Error ? err.message : "delete failed";
        setStatusLine(`Delete failed: ${message}`);
      } finally {
        refreshSessions();
      }
    },
    [apiBase, refreshSessions]
  );

  const openMacosTerminalForTmux = useCallback(
    async (name: string) => {
      if (!name) return;
      setStatusLine("Opening Terminal…");
      try {
        await postJson<{ ok: boolean }>(`${apiBase}/sessions/persistent/${encodeURIComponent(name)}/open-terminal`);
        setStatusLine("Opened Terminal.");
      } catch (err) {
        const message = err instanceof Error ? err.message : "open failed";
        setStatusLine(`Open Terminal failed: ${message}`);
      }
    },
    [apiBase]
  );

  const restartAppletsStack = useCallback(async () => {
    if (appletsStackRestarting) return;
    if (!appletsStackRestartEnabled) {
      setAppletsStackStatus("Disabled on server.");
      return;
    }
    const ok = window.confirm(
      `Restart applets stack?` +
        `\n\nThis will restart FastAPI (:8000) + the UI proxy (:3000).`
    );
    if (!ok) return;

    setAppletsStackRestarting(true);
    setAppletsStackStatus("Restarting…");
    setStatusLine("Restarting applets…");
    try {
      const resp = await postJson<{ ok: boolean; pid?: number; logPath?: string }>(`${apiBase}/applets/restart`);
      const pid = typeof resp.pid === "number" ? resp.pid : null;
      const logPath = typeof resp.logPath === "string" ? resp.logPath.trim() : "";
      const extra = pid ? ` (pid ${pid})` : "";
      const logExtra = logPath ? ` Log: ${logPath}` : "";
      setAppletsStackStatus(`Restart requested.${extra}${logExtra}`);
      setStatusLine(`Applets restart requested.${extra}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "restart failed";
      setAppletsStackStatus(`Restart failed: ${message}`);
      setStatusLine(`Applets restart failed: ${message}`);
    } finally {
      setAppletsStackRestarting(false);
    }
  }, [apiBase, appletsStackRestartEnabled, appletsStackRestarting]);

  const restartConsoleStack = useCallback(
    async (target: "prod" | "root" | "dev") => {
      if (consoleRestartBusy) return;
      if (!appletsStackRestartEnabled) {
        setConsoleRestartStatus("Disabled on server.");
        return;
      }

      const label =
        target === "prod" ? "prod console (console.caravanflow.com)" : target === "root" ? "root console (root.caravanflow.com)" : "dev console + root (local)";
      const ok = window.confirm(`Restart ${label}?` + `\n\nThis runs a detached tmux restart workflow on the server.`);
      if (!ok) return;

      setConsoleRestartBusy(target);
      setConsoleRestartStatus(`Restarting ${target}…`);
      setStatusLine(`Restarting ${target}…`);
      try {
        const resp = await postJson<{ ok: boolean; tmuxSession?: string }>(`${apiBase}/applets/restart/${target}`);
        const tmuxSession = typeof resp.tmuxSession === "string" ? resp.tmuxSession.trim() : "";
        const extra = tmuxSession ? ` tmux: ${tmuxSession}` : "";
        setConsoleRestartStatus(`Restart requested.${extra}`);
        setStatusLine(`Restart requested.${extra}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : "restart failed";
        setConsoleRestartStatus(`Restart failed: ${message}`);
        setStatusLine(`Restart failed: ${message}`);
      } finally {
        setConsoleRestartBusy(null);
      }
    },
    [apiBase, appletsStackRestartEnabled, consoleRestartBusy]
  );

  const onAttachActive = useCallback(
    async (id: string) => {
      const active = activeSessions.find((session) => session.id === id) ?? null;
      updateSessionMeta(keyForSession(id, active?.tmuxName), { attentionAt: undefined });
      setSessionId(id);
      await connect(id);
    },
    [activeSessions, connect, updateSessionMeta]
  );

  const onAttachPersistent = useCallback(
    async (name: string) => {
      if (!name) return;
      updateSessionMeta(keyForSession(name, name), { attentionAt: undefined });

      const size = getTerminalSize();
      const existing = (() => {
        const candidates = activeSessions.filter((session) => session.tmuxName === name);
        if (candidates.length === 0) return null;
        const current = candidates.find((session) => session.id === sessionId);
        if (current) return current;
        return candidates.reduce((best, session) => (session.lastActivityAt > best.lastActivityAt ? session : best));
      })();

      setStatusLine("Connecting…");
      setConn({ status: "connecting" });

      // If we already have a server-side session attached to this tmux session,
      // reuse it instead of spawning another tmux client (avoids duplicates).
      if (existing) {
        try {
          const attach = await postJson<CreateSessionResponse>(`${apiBase}/sessions/${existing.id}/attach`, {
            ...(size ?? {})
          });
          safeSet(sessionStore, SESSION_STORAGE_KEY, attach.sessionId);
          saveLastTmuxName(sessionStore, name);
          setSessionId(attach.sessionId);
          const wsUrl = new URL(attach.wsUrl, window.location.href);
          wsUrl.protocol = wsBase;
          setConnectedConn({
            status: "connected",
            wsUrl: wsUrl.toString(),
            attachToken: attach.attachToken,
            sessionId: attach.sessionId
          });
          setStatusLine(`Connected (${attach.sessionId})`);
          refreshSessions();
          return;
        } catch (err) {
          const message = err instanceof Error ? err.message : "connect failed";
          if (message !== "Not found") {
            setConn({ status: "idle" });
            setStatusLine(`Connect failed: ${message}`);
            return;
          }
          // Fall through to create a fresh tmux client below.
        }
      }

      try {
        const created = await postJson<CreateSessionResponse>(`${apiBase}/sessions`, {
          mode: "tmux",
          tmuxName: name,
          ...(autoOpenMacosTerminal ? { launchTerminal: true } : {}),
          ...(size ?? {})
        });
        safeSet(sessionStore, SESSION_STORAGE_KEY, created.sessionId);
        saveLastTmuxName(sessionStore, created.tmuxName ?? name);
        setSessionId(created.sessionId);
        const wsUrl = new URL(created.wsUrl, window.location.href);
        wsUrl.protocol = wsBase;
        setConnectedConn({
          status: "connected",
          wsUrl: wsUrl.toString(),
          attachToken: created.attachToken,
          sessionId: created.sessionId
        });
        setStatusLine(`Connected (${created.sessionId})`);
        refreshSessions();
      } catch (err) {
        const message = err instanceof Error ? err.message : "connect failed";
        setConn({ status: "idle" });
        setStatusLine(`Connect failed: ${message}`);
      }
    },
    [
      apiBase,
      activeSessions,
      autoOpenMacosTerminal,
      wsBase,
      refreshSessions,
      getTerminalSize,
      sessionId,
      sessionStore,
      setConnectedConn,
      updateSessionMeta
    ]
  );

  const onUploadClick = useCallback(() => {
    if (uploading) return;
    uploadInputRef.current?.click();
  }, [uploading]);

  const uploadImageAsset = useCallback(
    async (file: File, source: "picker" | "paste") => {
      if (uploadingRef.current) return;
      uploadingRef.current = true;
      setUploading(true);
      setStatusLine(`Uploading ${file.name}…`);

      try {
        const res = await fetch(`${apiBase}/uploads`, {
          method: "POST",
          headers: {
            "content-type": file.type || "application/octet-stream",
            "x-filename": encodeURIComponent(file.name)
          },
          body: file
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { filename?: string; path?: string; url?: string };
        const path = data.path || data.url || "";
        const displayName = data.filename || file.name;

        if (path) {
          try {
            await navigator.clipboard.writeText(path);
            setStatusLine(`Uploaded: ${displayName} (${source === "paste" ? "pasted" : "picked"}, path copied)`);
          } catch {
            setStatusLine(`Uploaded: ${displayName} (${source === "paste" ? "pasted" : "picked"})`);
          }
        } else {
          setStatusLine(`Uploaded: ${displayName} (${source === "paste" ? "pasted" : "picked"})`);
        }
        return { displayName, path, url: data.url };
      } catch (err) {
        const message = err instanceof Error ? err.message : "upload failed";
        setStatusLine(`Upload failed: ${message}`);
        return null;
      } finally {
        setUploading(false);
        uploadingRef.current = false;
      }
    },
    [apiBase]
  );

  const uploadImageToTerminal = useCallback(
    async (file: File, source: "picker" | "paste") => {
      const result = await uploadImageAsset(file, source);
      if (!result) return;
      if (result.path) {
        terminalRef.current?.sendText(result.path);
      }
    },
    [uploadImageAsset]
  );

  const clipboardReadAndUpload = useCallback(async () => {
    if (typeof navigator === "undefined" || typeof navigator.clipboard?.read !== "function") {
      return;
    }

    try {
      const items = await navigator.clipboard.read();
      const files: File[] = [];

      for (const item of items ?? []) {
        for (const type of item.types ?? []) {
          if (!type.startsWith("image/")) continue;
          try {
            const blob = await item.getType(type);
            const ext = type.split("/")[1] || "png";
            const name = `clipboard-image.${ext}`;
            const file =
              typeof File === "function"
                ? new File([blob], name, { type })
                : Object.assign(blob, { name, type }) as File;
            files.push(file);
          } catch {
            // skip types that fail to read
          }
        }
      }

      if (files.length === 0) return;
      await Promise.allSettled(files.map((file) => uploadImageToTerminal(file, "paste")));
    } catch {
      // ignore clipboard read failures
    }
  }, [uploadImageToTerminal]);

  const addCodexImage = useCallback(
    async (file: File, source: "picker" | "paste") => {
      const result = await uploadImageAsset(file, source);
      if (!result || !result.path) return;
      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `img_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      setCodexImages((prev) => {
        if (prev.length >= 5) return prev;
        return [
          ...prev,
          {
            id,
            name: result.displayName,
            path: result.path,
            url: result.url
          }
        ];
      });
    },
    [uploadImageAsset]
  );

  const removeCodexImage = useCallback((id: string) => {
    setCodexImages((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const onCodexPaste = useCallback(
    async (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = event.clipboardData?.items;
      if (!items) return;
      const imageItem = Array.from(items).find(
        (item) => item.kind === "file" && item.type.startsWith("image/")
      );
      if (!imageItem) return;
      const file = imageItem.getAsFile();
      if (!file) return;
      event.preventDefault();
      await addCodexImage(file, "paste");
    },
    [addCodexImage]
  );

  const onUploadChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = "";
      if (files.length === 0) return;
      let insertedAny = false;
      for (const file of files) {
        const result = await uploadImageAsset(file, "picker");
        if (!result?.path) continue;
        const prefix = insertedAny ? " " : "";
        terminalRef.current?.sendText(`${prefix}${result.path}`);
        insertedAny = true;
      }
    },
    [uploadImageAsset]
  );

  // Launch params (e.g. /?tmux=...) can force-opening a tmux session in a new browser tab.
  useEffect(() => {
    const tmuxName = launchParams.tmuxName;
    if (!tmuxName) return;
    if (conn.status !== "idle") return;
    if (launchConnectAttemptedRef.current) return;
    launchConnectAttemptedRef.current = true;
    autoReattachAttemptedRef.current = true;
    setMode("tmux");
    // If the server is configured to auto-open Terminal on tmux creates, override for this deep-link.
    void attachOrCreate({ mode: "tmux", tmuxName, launchTerminal: false }).catch(() => {
      // attachOrCreate already updated status
    });
  }, [attachOrCreate, conn.status, launchParams.tmuxName]);

  // Auto-reattach on refresh.
  useEffect(() => {
    if (launchParams.tmuxName) return;
    const stored = safeGet(sessionStore, SESSION_STORAGE_KEY);
    if (!stored) return;
    if (conn.status !== "idle") return;
    if (autoReattachAttemptedRef.current) return;
    autoReattachAttemptedRef.current = true;
    void (async () => {
      try {
        await attachOrCreate();
      } catch {
        // attachOrCreate already updated status
      }
    })();
  }, [attachOrCreate, conn.status, launchParams.tmuxName, sessionStore]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void refreshSessions();
    }, 5000);
    return () => window.clearInterval(interval);
  }, [refreshSessions]);

  // Detect Codex-done transitions for background sessions so we can beep/highlight tabs even
  // when we're attached to another session.
  useEffect(() => {
    const seen = new Set<string>();
    const prev = sessionCodexStateRef.current;
    const isInitial = !sessionCodexStateInitRef.current;
    sessionCodexStateInitRef.current = true;
    const now = Date.now();
    for (const session of activeSessions) {
      const key = keyForSession(session.id, session.tmuxName);
      seen.add(key);
      const nextState = session.codexState;
      const priorState = prev[key];
      prev[key] = nextState;

      if (isInitial) continue;
      if (sessionId && session.id === sessionId) continue;
      if (nextState !== "done") continue;
      if (priorState === "done") continue;

      updateSessionMeta(key, { attentionAt: now, attentionReason: "codex_done" });
      if (beepOnCodexDone) {
        playBeep("codex_done", {
          trigger: "session_poll",
          targetSessionId: session.id,
          tmuxName: session.tmuxName ?? ""
        });
      }
    }

    for (const key of Object.keys(prev)) {
      if (!seen.has(key)) delete prev[key];
    }
  }, [activeSessions, sessionId, beepOnCodexDone, playBeep, updateSessionMeta]);

  useEffect(() => {
    let mounted = true;
    getJson<{ enabled: boolean; allowFullAuto?: boolean; allowDanger?: boolean }>(`${apiBase}/codex/status`)
      .then((data) => {
        if (!mounted) return;
        const allowFullAuto = Boolean(data.allowFullAuto);
        setCodexEnabled(Boolean(data.enabled));
        setCodexAllowFullAuto(allowFullAuto);
        setCodexAllowDanger(Boolean(data.allowDanger));
        setCodexFullAuto(allowFullAuto);
      })
      .catch(() => {
        // ignore
      });
    return () => {
      mounted = false;
    };
  }, [apiBase]);

  useEffect(() => {
    let mounted = true;
    getJson<{ restartEnabled?: boolean; logPath?: string }>(`${apiBase}/applets/status`)
      .then((data) => {
        if (!mounted) return;
        setAppletsStackRestartEnabled(Boolean(data.restartEnabled));
        const logPath = typeof data.logPath === "string" ? data.logPath.trim() : "";
        setAppletsStackLogPath(logPath);
      })
      .catch(() => {
        if (!mounted) return;
        setAppletsStackRestartEnabled(false);
        setAppletsStackLogPath("");
      });
    return () => {
      mounted = false;
    };
  }, [apiBase]);

  useEffect(() => {
    let mounted = true;
    getJson<{ namingEnabled?: boolean; model?: string }>(`${apiBase}/ai/status`)
      .then((data) => {
        if (!mounted) return;
        setAiStatusLoaded(true);
        setAiNamingEnabled(Boolean(data.namingEnabled));
        setAiModel(typeof data.model === "string" ? data.model : "");
      })
      .catch(() => {
        if (!mounted) return;
        setAiStatusLoaded(false);
        setAiNamingEnabled(false);
        setAiModel("");
      });
    return () => {
      mounted = false;
    };
  }, [apiBase]);

  const appendCodexLog = useCallback(
    (text: string) => {
      setCodexLog((prev) => prev + text);
      if (text) {
        const next = (codexLogTailRef.current || "") + text;
        codexLogTailRef.current =
          next.length <= CODEX_LOG_TAIL_MAX_CHARS ? next : next.slice(-CODEX_LOG_TAIL_MAX_CHARS);
      }
      handleCodexSpeech(text);
    },
    [handleCodexSpeech]
  );

  const stopCodexExec = useCallback(() => {
    const ws = codexWsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "cancel" }));
    }
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    codexWsRef.current = null;
    if (codexSessionKeyRef.current) {
      updateSessionMeta(codexSessionKeyRef.current, {
        codexState: "idle",
        codexLogTail: codexLogTailRef.current,
        codexLogTailAt: Date.now()
      });
    }
    setCodexRunning(false);
    setCodexStatus("Canceled.");
  }, [updateSessionMeta]);

  const startCodexExec = useCallback(() => {
    const prompt = codexPrompt.trim();
    if (!prompt) {
      setCodexStatus("Enter a prompt.");
      return;
    }
    if (!codexEnabled) {
      setCodexStatus("Codex exec is disabled on this server.");
      return;
    }
    if (codexFullAuto && !codexAllowFullAuto) {
      setCodexStatus("Full-auto is disabled on this server.");
      return;
    }
    if (codexSandbox === "danger-full-access" && !codexAllowDanger) {
      setCodexStatus("Danger mode is disabled on this server.");
      return;
    }

    setCodexLog("");
    codexLogTailRef.current = "";
    setCodexStatus("Connecting…");
    setCodexRunning(true);
    const sessionKey = currentKeyRef.current;
    codexSessionKeyRef.current = sessionKey;
    if (sessionKey) {
      const now = Date.now();
      const promptForMeta =
        prompt.length <= CODEX_PROMPT_MAX_CHARS ? prompt : prompt.slice(0, CODEX_PROMPT_MAX_CHARS);
      const modelForMeta = String(codexModel ?? "").trim();
      updateSessionMeta(sessionKey, {
        codexState: "running",
        codexLastPrompt: promptForMeta,
        codexPromptAt: now,
        codexModel: modelForMeta.length <= 80 ? modelForMeta : modelForMeta.slice(0, 80),
        codexLogTail: ""
      });
    }

    if (codexWsRef.current) {
      try {
        codexWsRef.current.close();
      } catch {
        // ignore
      }
      codexWsRef.current = null;
    }

    const wsUrl = new URL(basePath ? `${basePath}/ws/codex/exec` : "/ws/codex/exec", window.location.href);
    wsUrl.protocol = wsBase;
    const ws = new WebSocket(wsUrl.toString());
    codexWsRef.current = ws;

    ws.onopen = () => {
      setCodexStatus("Running…");
      ws.send(
        JSON.stringify({
          type: "start",
          prompt,
          model: codexModel || undefined,
          sandbox: codexSandbox,
          fullAuto: codexFullAuto,
          images: codexImages.map((item) => item.path).filter(Boolean)
        })
      );
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      try {
        const msg = JSON.parse(event.data);
        if (msg?.type === "stdout" || msg?.type === "stderr") {
          appendCodexLog(msg.data || "");
          return;
        }
        if (msg?.type === "status" && typeof msg.message === "string") {
          setCodexStatus(msg.message);
          return;
        }
        if (msg?.type === "error" && typeof msg.message === "string") {
          setCodexStatus(msg.message);
          setCodexRunning(false);
          if (codexSessionKeyRef.current) {
            updateSessionMeta(codexSessionKeyRef.current, {
              codexState: "idle",
              codexLogTail: codexLogTailRef.current,
              codexLogTailAt: Date.now()
            });
          }
          return;
        }
        if (msg?.type === "exit") {
          setCodexStatus(`Exited (${msg.code ?? "?"})`);
          setCodexRunning(false);
          if (codexSessionKeyRef.current) {
            updateSessionMeta(codexSessionKeyRef.current, {
              codexState: "done",
              codexLogTail: codexLogTailRef.current,
              codexLogTailAt: Date.now()
            });
          }
          return;
        }
      } catch {
        appendCodexLog(event.data);
      }
    };

    ws.onerror = () => {
      setCodexStatus("Codex exec error.");
      setCodexRunning(false);
      if (codexSessionKeyRef.current) {
        updateSessionMeta(codexSessionKeyRef.current, {
          codexState: "idle",
          codexLogTail: codexLogTailRef.current,
          codexLogTailAt: Date.now()
        });
      }
    };

    ws.onclose = () => {
      setCodexRunning(false);
    };
  }, [
    codexPrompt,
    codexEnabled,
    codexFullAuto,
    codexAllowFullAuto,
    codexSandbox,
    codexAllowDanger,
    basePath,
    wsBase,
    codexModel,
    codexImages,
    appendCodexLog,
    updateSessionMeta
  ]);


  useEffect(() => {
    const session = activeSessionId;
    if (!session || !ttsEnabled || ttsEngine === "browser") {
      if (ttsWsRef.current) {
        try {
          ttsWsRef.current.close();
        } catch {
          // ignore
        }
      }
      ttsWsRef.current = null;
      ttsPlayerRef.current?.stop();
      ttsAudioUnlockedRef.current = false;
      setTtsServerActive(false);
      if (ttsEnabled && ttsEngine === "browser") {
        setTtsStatus("Browser TTS");
      } else {
        setTtsStatus("Idle");
      }
      return;
    }

    setTtsServerActive(false);
    const wsUrl = makeWsUrl(basePath ? `${basePath}/ws/tts/${session}` : `/ws/tts/${session}`);
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    ttsWsRef.current = ws;
    addClientLog("tts.ws.connect", { sessionId: session, engine: ttsEngine, url: wsUrl });
    setTtsStatus("Connecting…");

    ws.onopen = () => {
      addClientLog("tts.ws.open", { sessionId: session, engine: ttsEngine, source: ttsSource });
      void ensureTtsAudio("ws_open");
      try {
        ws.send(JSON.stringify({ type: "start", voice: ttsVoice, engine: ttsEngine, source: ttsSource }));
      } catch {
        // ignore
      }
      setTtsStatus("Connected");
    };

    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          const msg = JSON.parse(event.data);
          if (msg?.type === "format") {
            ttsPlayerRef.current?.setFormat(msg as TtsFormat);
            setTtsServerActive(true);
            addClientLog("tts.ws.format", {
              sessionId: session,
              sampleRate: msg.sampleRate,
              channels: msg.channels
            });
          }
          if (msg?.type === "info" && typeof msg.message === "string") {
            setTtsStatus(msg.message);
            addClientLog("tts.ws.info", { sessionId: session, message: msg.message });
          }
          if (msg?.type === "error" && typeof msg.message === "string") {
            setTtsStatus(msg.message);
            setTtsServerActive(false);
            addClientLog("tts.ws.error", { sessionId: session, message: msg.message });
          }
          if (msg?.type === "debug" && typeof msg.text === "string") {
            console.log("[TTS server] enqueue", {
              source: msg.source,
              engine: msg.engine,
              voice: msg.voice,
              model: msg.model,
              queued: msg.queued,
              text: msg.text
            });
          }
        } catch {
          // ignore
        }
        return;
      }
      setTtsServerActive(true);
      ttsPlayerRef.current?.enqueuePCM16(event.data as ArrayBuffer);
    };

    ws.onerror = () => {
      setTtsStatus("TTS error.");
      setTtsServerActive(false);
      addClientLog("tts.ws.onerror", { sessionId: session });
    };
    ws.onclose = (event) => {
      setTtsStatus("Disconnected");
      setTtsServerActive(false);
      addClientLog("tts.ws.close", {
        sessionId: session,
        code: (event as any)?.code ?? null,
        reason: (event as any)?.reason ?? "",
        wasClean: (event as any)?.wasClean ?? null
      });
    };

    return () => {
      try {
        ws.close();
      } catch {
        // ignore
      }
      ttsPlayerRef.current?.stop();
      ttsAudioUnlockedRef.current = false;
      setTtsServerActive(false);
    };
  }, [activeSessionId, ttsEnabled, ttsEngine, basePath, makeWsUrl, addClientLog, ensureTtsAudio]);

  useEffect(() => {
    if (!ttsEnabled || ttsEngine === "browser") return;
    const ws = ttsWsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "config", voice: ttsVoice, engine: ttsEngine, source: ttsSource }));
    }
  }, [ttsEnabled, ttsEngine, ttsVoice, ttsSource]);

  useEffect(() => {
    const session = activeSessionId;
    if (!session || !sttEnabled) {
      if (sttWsRef.current) {
        try {
          sttWsRef.current.close();
        } catch {
          // ignore
        }
      }
      sttWsRef.current = null;
      sttRecorderRef.current?.stop();
      sttRecorderRef.current = null;
      return;
    }

    const wsUrl = makeWsUrl(basePath ? `${basePath}/ws/stt/${session}` : `/ws/stt/${session}`);
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    sttWsRef.current = ws;
    setSttStatus("Connecting…");

    ws.onopen = async () => {
      ws.send(
        JSON.stringify({
          type: "start",
          engine: sttEngine,
          model: sttModel,
          lang: sttLang,
          liveTyping: true,
          inject: "server"
        })
      );
      const recorder = new SttRecorder((buf) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(buf);
      });
      sttRecorderRef.current = recorder;
      try {
        await recorder.start();
        setSttStatus("Listening…");
      } catch (err) {
        setSttStatus("Mic permission denied.");
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      try {
        const msg = JSON.parse(event.data);
        if (msg?.type === "info" && typeof msg.message === "string") {
          setSttStatus(msg.message);
        }
        if (msg?.type === "error" && typeof msg.message === "string") {
          setSttStatus(msg.message);
        }
        if (msg?.type === "partial" && typeof msg.text === "string") {
          setSttStatus(`Hearing: ${msg.text.slice(0, 60)}${msg.text.length > 60 ? "…" : ""}`);
        }
        if (msg?.type === "final" && typeof msg.text === "string") {
          setSttStatus(`Heard: ${msg.text.slice(0, 60)}${msg.text.length > 60 ? "…" : ""}`);
        }
      } catch {
        // ignore
      }
    };

    ws.onerror = () => {
      setSttStatus("STT error.");
    };
    ws.onclose = () => {
      setSttStatus("Disconnected");
      sttRecorderRef.current?.stop();
      sttRecorderRef.current = null;
    };

    return () => {
      try {
        ws.close();
      } catch {
        // ignore
      }
      sttRecorderRef.current?.stop();
      sttRecorderRef.current = null;
    };
  }, [activeSessionId, sttEnabled, basePath, makeWsUrl]);

  useEffect(() => {
    if (!sttEnabled) return;
    const ws = sttWsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "config",
          engine: sttEngine,
          model: sttModel,
          lang: sttLang,
          liveTyping: true,
          inject: "server"
        })
      );
    }
  }, [sttEnabled, sttEngine, sttModel, sttLang]);

  useEffect(() => {
    if (sttEngine === "openai" && sttModel.toLowerCase().includes("ggml")) {
      setSttModel("whisper-1");
    }
    if (sttEngine === "cpp" && sttModel.toLowerCase() === "whisper-1") {
      setSttModel("ggml-large-v3.bin");
    }
  }, [sttEngine]);

  useEffect(() => {
    return () => {
      if (codexWsRef.current) {
        try {
          codexWsRef.current.close();
        } catch {
          // ignore
        }
        codexWsRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      if (codexPromptRef.current && document.activeElement === codexPromptRef.current) {
        return;
      }
      const items = event.clipboardData?.items;
      if (items) {
        const images: File[] = [];
        for (const item of items) {
          if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
          const file = item.getAsFile();
          if (file) {
            images.push(file);
          }
        }
        if (images.length > 0) {
          event.preventDefault();
          void Promise.allSettled(images.map((file) => uploadImageToTerminal(file, "paste")));
          return;
        }
      }
      void clipboardReadAndUpload();
    };

    // Capture phase so xterm (or other inputs) can't stopPropagation before we see image pastes.
    window.addEventListener("paste", handlePaste, true);
    return () => {
      window.removeEventListener("paste", handlePaste, true);
    };
  }, [clipboardReadAndUpload, uploadImageToTerminal]);

  const activeSessionTabKeys = useMemo(
    () => activeSessions.map((session) => keyForSession(session.id, session.tmuxName)),
    [activeSessions]
  );

  useEffect(() => {
    setSessionTabOrder((prev) => {
      const next = normalizeSessionTabOrder(prev, activeSessionTabKeys);
      const same = prev.length === next.length && prev.every((value, i) => value === next[i]);
      if (same) return prev;
      saveSessionTabOrder(sessionStore, next);
      return next;
    });
  }, [activeSessionTabKeys, sessionStore]);

  const orderedActiveSessions = useMemo(() => {
    if (activeSessions.length <= 1) return activeSessions;
    const sessionByKey = new Map<string, SessionSummary>();
    for (const session of activeSessions) {
      sessionByKey.set(keyForSession(session.id, session.tmuxName), session);
    }
    const order = normalizeSessionTabOrder(sessionTabOrder, activeSessionTabKeys);
    const out: SessionSummary[] = [];
    for (const key of order) {
      const session = sessionByKey.get(key);
      if (session) out.push(session);
    }
    return out;
  }, [activeSessionTabKeys, activeSessions, sessionTabOrder]);

  const moveSessionTabTo = useCallback(
    (dragKey: string, overKey: string) => {
      if (!dragKey || !overKey || dragKey === overKey) return;
      setSessionTabOrder((prev) => {
        const base = normalizeSessionTabOrder(prev, activeSessionTabKeys);
        const fromIndex = base.indexOf(dragKey);
        const toIndex = base.indexOf(overKey);
        if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return prev;
        const next = base.slice();
        next.splice(fromIndex, 1);
        const insertAt = fromIndex < toIndex ? toIndex - 1 : toIndex;
        next.splice(insertAt, 0, dragKey);
        saveSessionTabOrder(sessionStore, next);
        return next;
      });
    },
    [activeSessionTabKeys, sessionStore]
  );

  const moveSessionTabBy = useCallback(
    (sessionKey: string, delta: -1 | 1) => {
      if (!sessionKey) return;
      setSessionTabOrder((prev) => {
        const base = normalizeSessionTabOrder(prev, activeSessionTabKeys);
        const index = base.indexOf(sessionKey);
        if (index < 0) return prev;
        const nextIndex = index + delta;
        if (nextIndex < 0 || nextIndex >= base.length) return prev;
        const next = base.slice();
        const tmp = next[index];
        next[index] = next[nextIndex]!;
        next[nextIndex] = tmp!;
        saveSessionTabOrder(sessionStore, next);
        return next;
      });
    },
    [activeSessionTabKeys, sessionStore]
  );

  const moveMobileActionTo = useCallback(
    (dragId: MobileActionId, overId: MobileActionId) => {
      if (!dragId || !overId || dragId === overId) return;
      setMobileActionOrder((prev) => {
        const base = normalizeMobileActionOrder(prev);
        const fromIndex = base.indexOf(dragId);
        const toIndex = base.indexOf(overId);
        if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return prev;
        const next = base.slice();
        next.splice(fromIndex, 1);
        const insertAt = fromIndex < toIndex ? toIndex - 1 : toIndex;
        next.splice(insertAt, 0, dragId);
        saveMobileActionOrder(sessionStore, next);
        return next;
      });
    },
    [sessionStore]
  );

  const handleMobileActionPointerDown = useCallback((event: PointerEvent<HTMLDivElement>, actionId: MobileActionId) => {
    if (event.button !== 0) return;
    if (!mobileActionEditModeRef.current) return;
    const drag = mobileActionDragRef.current;
    drag.active = true;
    drag.dragging = false;
    drag.suppressClick = false;
    drag.pointerType = event.pointerType;
    drag.pointerId = event.pointerId;
    drag.actionId = actionId;
    drag.startX = event.clientX;
    drag.startY = event.clientY;
    drag.captureEl = null;
    if (drag.longPressTimer) {
      window.clearTimeout(drag.longPressTimer);
      drag.longPressTimer = null;
    }

    if (event.pointerType === "mouse") {
      // Capture on the underlying <button> so normal clicks still land on the button.
      const target = (event.target as Element | null)?.closest?.("button.mobileButton") as HTMLElement | null;
      if (target && !(target as HTMLButtonElement).disabled) {
        try {
          target.setPointerCapture(event.pointerId);
          drag.captureEl = target;
        } catch {
          // ignore capture failures
        }
      } else {
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.captureEl = event.currentTarget;
        } catch {
          // ignore capture failures
        }
      }
      return;
    }

    {
      const pointerId = event.pointerId;
      const target = event.currentTarget;
      drag.longPressTimer = window.setTimeout(() => {
        const current = mobileActionDragRef.current;
        if (!current.active || current.pointerId !== pointerId || current.actionId !== actionId) return;
        current.dragging = true;
        current.suppressClick = true;
        setDraggingMobileActionId(actionId);
        try {
          target.setPointerCapture(pointerId);
          current.captureEl = target;
        } catch {
          // ignore capture failures
        }
      }, MOBILE_ACTION_DRAG_LONG_PRESS_MS);
    }
  }, []);

  const handleMobileActionPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const drag = mobileActionDragRef.current;
      if (!drag.active || drag.pointerId !== event.pointerId) return;
      if (!drag.actionId) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;

      if (!drag.dragging) {
        if (drag.pointerType === "mouse") {
          if (Math.abs(dx) < MOBILE_ACTION_DRAG_THRESHOLD_PX && Math.abs(dy) < MOBILE_ACTION_DRAG_THRESHOLD_PX) return;
          drag.dragging = true;
          drag.suppressClick = true;
          setDraggingMobileActionId(drag.actionId);
        } else {
          if (Math.abs(dx) < MOBILE_ACTION_DRAG_THRESHOLD_PX && Math.abs(dy) < MOBILE_ACTION_DRAG_THRESHOLD_PX) return;
          // A swipe before long-press: treat as scroll and cancel drag attempt.
          drag.active = false;
          drag.pointerId = null;
          drag.actionId = null;
          if (drag.longPressTimer) {
            window.clearTimeout(drag.longPressTimer);
            drag.longPressTimer = null;
          }
          return;
        }
      }

      event.preventDefault();
      const el = document.elementFromPoint(event.clientX, event.clientY);
      const handle = el?.closest?.("[data-mobile-action-id]");
      const overRaw = handle?.getAttribute("data-mobile-action-id") ?? "";
      if (!isMobileActionId(overRaw)) return;
      const overId = overRaw;
      if (overId && overId !== drag.actionId) {
        moveMobileActionTo(drag.actionId, overId);
      }
    },
    [moveMobileActionTo]
  );

  const handleMobileActionPointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = mobileActionDragRef.current;
    if (!drag.active || drag.pointerId !== event.pointerId) return;
    const pointerId = event.pointerId;
    drag.active = false;
    drag.pointerId = null;
    drag.actionId = null;
    if (drag.longPressTimer) {
      window.clearTimeout(drag.longPressTimer);
      drag.longPressTimer = null;
    }
    if (drag.captureEl && drag.captureEl.hasPointerCapture(pointerId)) {
      try {
        drag.captureEl.releasePointerCapture(pointerId);
      } catch {
        // ignore release failures
      }
    }
    drag.captureEl = null;
    if (drag.dragging) drag.suppressClick = true;
    drag.dragging = false;
    setDraggingMobileActionId(null);
  }, []);

  const handleMobileActionClickCapture = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (mobileActionEditModeRef.current) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const drag = mobileActionDragRef.current;
    if (drag.suppressClick) {
      drag.suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
  }, []);

  const handleSessionTabPointerDown = useCallback(
    (event: PointerEvent<HTMLButtonElement>, sessionKey: string) => {
      if (event.button !== 0) return;
      const drag = sessionTabDragRef.current;
      drag.active = true;
      drag.dragging = false;
      drag.suppressClick = false;
      drag.pointerType = event.pointerType;
      drag.pointerId = event.pointerId;
      drag.key = sessionKey;
      drag.startX = event.clientX;
      drag.startY = event.clientY;
      if (drag.longPressTimer) {
        window.clearTimeout(drag.longPressTimer);
        drag.longPressTimer = null;
      }
      if (event.pointerType === "mouse") {
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // ignore capture failures
        }
        return;
      }
      {
        const pointerId = event.pointerId;
        const target = event.currentTarget;
        drag.longPressTimer = window.setTimeout(() => {
          const current = sessionTabDragRef.current;
          if (!current.active || current.pointerId !== pointerId || current.key !== sessionKey) return;
          current.dragging = true;
          current.suppressClick = true;
          setDraggingSessionTabKey(sessionKey);
          try {
            target.setPointerCapture(pointerId);
          } catch {
            // ignore capture failures
          }
        }, SESSION_TAB_DRAG_LONG_PRESS_MS);
      }
    },
    []
  );

  const handleSessionTabPointerMove = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      const drag = sessionTabDragRef.current;
      if (!drag.active || drag.pointerId !== event.pointerId) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;

      if (!drag.dragging) {
        if (drag.pointerType === "mouse") {
          if (Math.abs(dx) < SESSION_TAB_DRAG_THRESHOLD_PX && Math.abs(dy) < SESSION_TAB_DRAG_THRESHOLD_PX) return;
          drag.dragging = true;
          drag.suppressClick = true;
          setDraggingSessionTabKey(drag.key);
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            // ignore capture failures
          }
        } else {
          if (Math.abs(dx) < SESSION_TAB_DRAG_THRESHOLD_PX && Math.abs(dy) < SESSION_TAB_DRAG_THRESHOLD_PX) return;
          // A swipe before long-press: treat as scroll and cancel drag attempt.
          drag.active = false;
          drag.pointerId = null;
          if (drag.longPressTimer) {
            window.clearTimeout(drag.longPressTimer);
            drag.longPressTimer = null;
          }
          return;
        }
      }

      event.preventDefault();
      const el = document.elementFromPoint(event.clientX, event.clientY);
      const tab = el?.closest?.("button.sessionTab");
      const overKey = tab?.getAttribute("data-session-key") ?? "";
      if (overKey && overKey !== drag.key) {
        moveSessionTabTo(drag.key, overKey);
      }

      const container = sessionTabsRef.current;
      if (container) {
        const rect = container.getBoundingClientRect();
        if (event.clientX < rect.left + SESSION_TAB_DRAG_EDGE_SCROLL_PX) {
          container.scrollLeft -= SESSION_TAB_DRAG_EDGE_SCROLL_STEP_PX;
        } else if (event.clientX > rect.right - SESSION_TAB_DRAG_EDGE_SCROLL_PX) {
          container.scrollLeft += SESSION_TAB_DRAG_EDGE_SCROLL_STEP_PX;
        }
      }
    },
    [moveSessionTabTo]
  );

  const handleSessionTabPointerUp = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const drag = sessionTabDragRef.current;
    if (!drag.active || drag.pointerId !== event.pointerId) return;
    drag.active = false;
    drag.pointerId = null;
    if (drag.longPressTimer) {
      window.clearTimeout(drag.longPressTimer);
      drag.longPressTimer = null;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // ignore release failures
      }
    }
    if (drag.dragging) drag.suppressClick = true;
    drag.dragging = false;
    setDraggingSessionTabKey(null);
  }, []);

  const handleSessionTabClick = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    const drag = sessionTabDragRef.current;
    if (drag.suppressClick) {
      drag.suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
  }, []);

  const onDetachCurrent = useCallback(() => {
    const currentId = sessionId ?? safeGet(sessionStore, SESSION_STORAGE_KEY);
    if (!currentId) return;

    const pickNextId = (): string | null => {
      const idx = orderedActiveSessions.findIndex((session) => session.id === currentId);
      if (idx >= 0) {
        for (let i = idx + 1; i < orderedActiveSessions.length; i += 1) {
          const candidate = orderedActiveSessions[i]?.id ?? "";
          if (candidate) return candidate;
        }
        for (let i = idx - 1; i >= 0; i -= 1) {
          const candidate = orderedActiveSessions[i]?.id ?? "";
          if (candidate) return candidate;
        }
      }
      const first = orderedActiveSessions.find((s) => s.id && s.id !== currentId);
      return first?.id ?? null;
    };

    const nextId = pickNextId();
    persistScrollback();
    clearReconnect("detach_session");
    addClientLog("session.detach.start", { sessionId: currentId, nextId: nextId ?? undefined });

    // Optimistically remove the session so the tab disappears immediately.
    setActiveSessions((prev) => prev.filter((session) => session.id !== currentId));

    const clearLocalSession = () => {
      safeRemove(sessionStore, SESSION_STORAGE_KEY);
      setSessionId(null);
      setConn({ status: "idle" });
    };

    if (!nextId) {
      clearLocalSession();
      setStatusLine("Disconnected. Create a new session to continue.");
    }

    void (async () => {
      if (nextId) {
        try {
          await onAttachActive(nextId);
        } finally {
          try {
            await postJson<{ ok: boolean }>(`${apiBase}/sessions/${currentId}/close`);
          } catch {
            // best effort
          }
          addClientLog("session.detach.done", { sessionId: currentId, nextId });
          refreshSessions();
        }
        return;
      }

      try {
        await postJson<{ ok: boolean }>(`${apiBase}/sessions/${currentId}/close`);
      } catch {
        // best effort
      } finally {
        addClientLog("session.detach.done", { sessionId: currentId, nextId: null });
        refreshSessions();
      }
    })();
  }, [
    apiBase,
    clearReconnect,
    orderedActiveSessions,
    onAttachActive,
    persistScrollback,
    refreshSessions,
    sessionId,
    sessionStore,
    addClientLog
  ]);

  const onDisconnectOnly = useCallback(() => {
    if (conn.status !== "connected") return;
    const currentId = sessionId ?? safeGet(sessionStore, SESSION_STORAGE_KEY);
    if (!currentId) return;
    setSessionsOpen(false);
    setSettingsOpen(false);
    setDisconnectDialogOpen(true);
  }, [conn.status, sessionId, sessionStore]);

  const onDeleteCurrent = useCallback(() => {
    const currentId = sessionId ?? safeGet(sessionStore, SESSION_STORAGE_KEY);
    if (!currentId) return;

    const current = activeSessions.find((s) => s.id === currentId) ?? null;
    const tmuxName = (current?.tmuxName ?? "").trim() || null;

    const ok = window.confirm(
      tmuxName
        ? `Delete this tmux session (${tmuxName})?` +
            `\n\nThis kills the tmux session on the server and disconnects any attached clients.`
        : "Delete this session?"
    );
    if (!ok) return;

    const idsToRemove = (() => {
      if (!tmuxName) return [currentId];
      const out = activeSessions
        .filter((s) => (s.tmuxName ?? "").trim() === tmuxName)
        .map((s) => s.id)
        .filter(Boolean);
      return out.length > 0 ? out : [currentId];
    })();

    const pickNextId = (): string | null => {
      const idx = orderedActiveSessions.findIndex((session) => session.id === currentId);
      if (idx >= 0) {
        for (let i = idx + 1; i < orderedActiveSessions.length; i += 1) {
          const candidate = orderedActiveSessions[i]?.id ?? "";
          if (candidate && !idsToRemove.includes(candidate)) return candidate;
        }
        for (let i = idx - 1; i >= 0; i -= 1) {
          const candidate = orderedActiveSessions[i]?.id ?? "";
          if (candidate && !idsToRemove.includes(candidate)) return candidate;
        }
      }
      const first = orderedActiveSessions.find((s) => s.id && !idsToRemove.includes(s.id));
      return first?.id ?? null;
    };

    const nextId = pickNextId();
    persistScrollback();
    clearReconnect(tmuxName ? "delete_tmux" : "delete_session");

    // Optimistically remove the session(s) so tabs disappear immediately.
    setActiveSessions((prev) => prev.filter((session) => !idsToRemove.includes(session.id)));

    const clearLocalSession = () => {
      safeRemove(sessionStore, SESSION_STORAGE_KEY);
      setSessionId(null);
      setConn({ status: "idle" });
    };

    void (async () => {
      if (nextId) {
        try {
          await onAttachActive(nextId);
        } finally {
          try {
            if (tmuxName) {
              await deletePersistentSession(tmuxName, { force: true });
            } else {
              await postJson<{ ok: boolean }>(`${apiBase}/sessions/${currentId}/close`);
            }
          } catch {
            // best effort
          }
          refreshSessions();
        }
        return;
      }

      if (tmuxName) {
        try {
          await deletePersistentSession(tmuxName, { force: true });
        } finally {
          clearLocalSession();
          setStatusLine("Session deleted. Create a new session to continue.");
          refreshSessions();
        }
        return;
      }

      void onCloseSession();
    })();
  }, [
    activeSessions,
    apiBase,
    clearReconnect,
    deletePersistentSession,
    onAttachActive,
    onCloseSession,
    orderedActiveSessions,
    persistScrollback,
    refreshSessions,
    sessionId,
    sessionStore
  ]);

  const activeSession = useMemo(() => {
    if (!sessionId) return null;
    return activeSessions.find((s) => s.id === sessionId) ?? null;
  }, [activeSessions, sessionId]);

  const currentKey = useMemo(() => {
    if (!sessionId) return null;
    return keyForSession(sessionId, activeSession?.tmuxName);
  }, [activeSession?.tmuxName, sessionId]);

  const codexActive = useMemo(() => {
    if (!currentKey) return false;
    if (codexRunning) return codexSessionKeyRef.current === currentKey;
    return terminalCodexState === "running";
  }, [codexRunning, currentKey, terminalCodexState]);

  useEffect(() => {
    currentKeyRef.current = currentKey;
  }, [currentKey]);

  useEffect(() => {
    if (!codexRunning) return;
    const key = codexSessionKeyRef.current;
    if (!key) return;
    updateSessionMeta(key, { codexState: "running" });
  }, [codexRunning, updateSessionMeta]);

  useEffect(() => {
    addClientLog("conn_status", { status: conn.status, sessionId: sessionId ?? null });
  }, [conn.status, sessionId, addClientLog]);

  // If we discover a stable tmux name for the current session, migrate meta saved under the ephemeral session id.
  useEffect(() => {
    if (!sessionId) return;
    const tmuxName = activeSession?.tmuxName;
    if (!tmuxName) return;
    const ephemeralKey = keyForSession(sessionId);
    const stableKey = keyForSession(sessionId, tmuxName);
    if (ephemeralKey === stableKey) return;

    setSessionMeta((prev) => {
      const existingStable = prev[stableKey];
      const existingEphemeral = prev[ephemeralKey];
      if (!existingEphemeral || existingStable) return prev;
      const next: SessionMetaStore = { ...prev, [stableKey]: existingEphemeral };
      delete next[ephemeralKey];
      saveSessionMeta(next);
      return next;
    });
  }, [activeSession?.tmuxName, sessionId]);

  const currentManualName = useMemo(() => {
    if (!currentKey) return "";
    return (sessionMeta[currentKey]?.name ?? "").trim();
  }, [currentKey, sessionMeta]);

  const currentAutoName = useMemo(() => {
    if (!currentKey) return "";
    return (sessionMeta[currentKey]?.autoName ?? "").trim();
  }, [currentKey, sessionMeta]);

  const taskNameStripValue = useMemo(
    () => currentManualName || currentAutoName,
    [currentAutoName, currentManualName]
  );
  const taskNameStripLabel = useMemo(() => (currentManualName ? "" : "AUTO"), [currentManualName]);
  const taskNameStripVisible = useMemo(() => Boolean(taskNameStripValue), [taskNameStripValue]);

  const promptRenameTaskForKey = useCallback(
    (key: string) => {
      if (typeof window === "undefined") return;
      const current = (sessionMeta[key]?.name ?? "").trim();
      const nextRaw = window.prompt("Task name", current);
      if (nextRaw === null) return;
      const next = nextRaw.slice(0, TASK_NAME_MAX_CHARS).trim();
      if (next) {
        updateSessionMeta(key, { name: next, nameSource: "user", autoName: undefined });
      } else {
        updateSessionMeta(key, { name: undefined, nameSource: undefined });
      }
    },
    [sessionMeta, updateSessionMeta]
  );

  const folderValue = useMemo(() => {
    if (!currentKey) return "";
    return sessionMeta[currentKey]?.lastTitle ?? sessionMeta[currentKey]?.lastCwd ?? activeSession?.cwd ?? "";
  }, [activeSession?.cwd, currentKey, sessionMeta]);

  const buildAiRecentNames = useCallback(
    (limit = 8) => {
      const entries = Object.values(sessionMeta)
        .map((meta) => {
          const label = (meta.name ?? "").trim() || (meta.autoName ?? "").trim();
          const at = typeof meta.updatedAt === "number" && Number.isFinite(meta.updatedAt) ? meta.updatedAt : 0;
          return { label, at };
        })
        .filter((entry) => entry.label);
      entries.sort((a, b) => b.at - a.at);
      const out: string[] = [];
      const seen = new Set<string>();
      for (const entry of entries) {
        if (seen.has(entry.label)) continue;
        seen.add(entry.label);
        out.push(entry.label);
        if (out.length >= limit) break;
      }
      return out;
    },
    [sessionMeta]
  );

  const suggestAiNameForSession = useCallback(
    async (targetSessionId: string, key: string, options?: { includeOutput?: boolean; applyManual?: boolean }) => {
      if (!targetSessionId || !key) return;
      if (!aiStatusLoaded) {
        setAiNameStatus("AI naming unavailable.");
        return;
      }
      if (!aiNamingEnabled) {
        setAiNameStatus("AI naming disabled on server.");
        return;
      }

      if (aiSuggestInFlightRef.current) return aiSuggestInFlightRef.current;

      const run = (async () => {
        try {
          const includeOutput = typeof options?.includeOutput === "boolean" ? options.includeOutput : aiIncludeOutput;
          addClientLog("ai_name.suggest.start", { sessionId: targetSessionId, includeOutput });
          setAiNameStatus("Suggesting…");
          const recentNames = buildAiRecentNames(8);
          const payload: Record<string, any> = { includeOutput };
          if (recentNames.length) payload.recentNames = recentNames;
          const meta = sessionMeta[key];
          const codexPrompt = (meta?.codexLastPrompt ?? "").trim();
          if (codexPrompt) payload.codexPrompt = codexPrompt;
          const codexLogTail = (meta?.codexLogTail ?? "").trim();
          if (codexLogTail) payload.codexLogTail = codexLogTail;
          const codexModelLabel = (meta?.codexModel ?? "").trim();
          if (codexModelLabel) payload.codexModel = codexModelLabel;

          const response = await postJson<{ name: string; requestId?: string }>(
            `${apiBase}/ai/sessions/${encodeURIComponent(targetSessionId)}/suggest-name`,
            payload
          );
          const suggested = String(response?.name ?? "").trim();
          if (!suggested) {
            setAiNameStatus("Suggest failed: empty response.");
            addClientLog("ai_name.suggest.empty", { sessionId: targetSessionId });
            return;
          }

	          if (options?.applyManual) {
	            updateSessionMeta(key, { name: suggested, nameSource: "ai", autoName: undefined });
	          } else {
	            updateSessionMeta(key, {
	              autoName: suggested,
              autoNamedAt: Date.now(),
              autoNameRequestId: response.requestId
            });
          }

          setAiNameStatus("Suggested.");
          addClientLog("ai_name.suggest.ok", { sessionId: targetSessionId, requestId: response.requestId ?? undefined });
        } catch (err) {
          const message = err instanceof Error ? err.message : "suggest failed";
          setAiNameStatus(`Suggest failed: ${message}`);
          addClientLog("ai_name.suggest.error", { sessionId: targetSessionId, error: message });
        }
      })();

      aiSuggestInFlightRef.current = run;
      try {
        return await run;
      } finally {
        if (aiSuggestInFlightRef.current === run) {
          aiSuggestInFlightRef.current = null;
        }
      }
    },
    [
      addClientLog,
      aiIncludeOutput,
      aiNamingEnabled,
      aiStatusLoaded,
      apiBase,
      buildAiRecentNames,
      sessionMeta,
      updateSessionMeta
    ]
  );

	  const applyAiAutoNameToManual = useCallback(() => {
	    if (!currentKey) return;
	    if (!currentAutoName) return;
	    if (currentManualName && typeof window !== "undefined") {
	      if (!window.confirm("Overwrite the manual task name with the AI suggestion?")) return;
	    }
	    updateSessionMeta(currentKey, { name: currentAutoName, nameSource: "ai", autoName: undefined });
	  }, [currentAutoName, currentKey, currentManualName, updateSessionMeta]);

  const clearAiAutoName = useCallback(() => {
    if (!currentKey) return;
    updateSessionMeta(currentKey, { autoName: undefined });
  }, [currentKey, updateSessionMeta]);

  const bulkAiNameOpenSessions = useCallback(async (options?: BulkAiNameOptions) => {
    if (!aiStatusLoaded) {
      setAiNameStatus("AI naming unavailable.");
      return;
    }
    if (!aiNamingEnabled) {
      setAiNameStatus("AI naming disabled on server.");
      return;
    }
    if (aiSuggestInFlightRef.current) {
      setAiNameStatus("AI naming already in progress.");
      return;
    }
    const sessions = options?.sessions ?? activeSessions;
    if (sessions.length === 0) {
      setAiNameStatus("No open sessions.");
      return;
    }

    const run = (async () => {
      // Migrate any draft names stored under ephemeral session ids into stable tmux keys.
      // This prevents bulk naming from overwriting "hidden" manual names.
      setSessionMeta((prev) => {
        let changed = false;
        const next: SessionMetaStore = { ...prev };
        for (const session of sessions) {
          if (!session.tmuxName) continue;
          const ephemeralKey = keyForSession(session.id);
          const stableKey = keyForSession(session.id, session.tmuxName);
          if (ephemeralKey === stableKey) continue;
          const existingStable = next[stableKey];
          const existingEphemeral = next[ephemeralKey];
          if (!existingEphemeral || existingStable) continue;
          next[stableKey] = existingEphemeral;
          delete next[ephemeralKey];
          changed = true;
        }
        if (!changed) return prev;
        saveSessionMeta(next);
        return next;
      });

      const targets = sessions.map((session) => {
        const stableKey = keyForSession(session.id, session.tmuxName);
        const ephemeralKey = keyForSession(session.id);
        const stableMeta = sessionMeta[stableKey];
        const ephemeralMeta = sessionMeta[ephemeralKey];
        const stableName = (stableMeta?.name ?? "").trim();
        const ephemeralName = (ephemeralMeta?.name ?? "").trim();
        const manualName = stableName || ephemeralName;
        const nameSource = stableMeta?.nameSource ?? ephemeralMeta?.nameSource;
        return { session, stableKey, manualName, nameSource };
      });

      const namedCount = targets.reduce((acc, t) => acc + (t.manualName ? 1 : 0), 0);
      const unnamedCount = targets.length - namedCount;

      const interactive = options?.interactive !== false;
      const overwriteAiManagedOnly = Boolean(options?.overwriteAiManagedOnly);
      let overwrite =
        typeof options?.overwrite === "boolean"
          ? options.overwrite
          : false;
      if (
        typeof options?.overwrite !== "boolean" &&
        interactive &&
        !overwriteAiManagedOnly &&
        namedCount > 0 &&
        typeof window !== "undefined"
      ) {
        overwrite = window.confirm(
          `Auto-name will update ${unnamedCount} unnamed session(s).\n\nOverwrite ${namedCount} existing manual name(s) too?`
        );
      }

      const includeOutput = aiIncludeOutput;
      const recentNames = buildAiRecentNames(8);
      const toProcess = targets.filter((t) => {
        if (!t.manualName) return true;
        if (overwrite) return true;
        if (overwriteAiManagedOnly) return t.nameSource === "ai";
        return false;
      });
      if (toProcess.length === 0) {
        setAiNameStatus("Nothing to rename.");
        return;
      }

      addClientLog("ai_name.bulk.start", {
        count: toProcess.length,
        overwrite,
        overwriteAiManagedOnly,
        includeOutput,
        interactive
      });
      let okCount = 0;
      let errCount = 0;
      for (let i = 0; i < toProcess.length; i += 1) {
        const target = toProcess[i];
        try {
          setAiNameStatus(`Bulk naming ${i + 1}/${toProcess.length}…`);
          const payload: Record<string, any> = { includeOutput };
          if (recentNames.length) payload.recentNames = recentNames;
          const meta = sessionMeta[target.stableKey];
          const codexPrompt = (meta?.codexLastPrompt ?? "").trim();
          if (codexPrompt) payload.codexPrompt = codexPrompt;
          const codexLogTail = (meta?.codexLogTail ?? "").trim();
          if (codexLogTail) payload.codexLogTail = codexLogTail;
          const codexModelLabel = (meta?.codexModel ?? "").trim();
          if (codexModelLabel) payload.codexModel = codexModelLabel;
          const response = await postJson<{ name: string; requestId?: string }>(
            `${apiBase}/ai/sessions/${encodeURIComponent(target.session.id)}/suggest-name`,
            payload
          );
          const suggested = String(response?.name ?? "").trim();
          if (!suggested) throw new Error("empty response");
          updateSessionMeta(target.stableKey, { name: suggested, nameSource: "ai", autoName: undefined });
          okCount += 1;
          addClientLog("ai_name.bulk.ok", {
            sessionId: target.session.id,
            requestId: response.requestId ?? undefined
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : "bulk suggest failed";
          errCount += 1;
          addClientLog("ai_name.bulk.error", { sessionId: target.session.id, error: message });
        }
      }

      setAiNameStatus(`Bulk naming done: ${okCount}/${toProcess.length}${errCount ? ` (${errCount} failed)` : ""}.`);
    })();

    aiSuggestInFlightRef.current = run;
    try {
      await run;
    } finally {
      if (aiSuggestInFlightRef.current === run) {
        aiSuggestInFlightRef.current = null;
      }
    }
  }, [
    activeSessions,
    addClientLog,
    aiIncludeOutput,
    aiNamingEnabled,
    aiStatusLoaded,
    apiBase,
    buildAiRecentNames,
    sessionMeta,
    updateSessionMeta
  ]);

  const onBulkAiRenameClick = useCallback(() => {
    void (async () => {
      try {
        const active = await getJson<{ sessions: SessionSummary[] }>(`${apiBase}/sessions`);
        await bulkAiNameOpenSessions({ sessions: active.sessions ?? [] });
      } catch {
        await bulkAiNameOpenSessions();
      }
    })();
  }, [apiBase, bulkAiNameOpenSessions]);

  // After a disconnect/reconnect (e.g. prod restart), refresh manual names for:
  // - unnamed sessions, and
  // - sessions previously named by AI (never overwrites user-set names).
  useEffect(() => {
    if (!aiAutoBulkNameOnReconnect) return;
    if (!aiStatusLoaded || !aiNamingEnabled) return;
    if (conn.status !== "connected") return;
    if (!aiAutoBulkPendingRef.current) return;

    const connKey = `${conn.sessionId}|${conn.wsUrl}`;
    if (aiAutoBulkLastConnKeyRef.current === connKey) return;
    aiAutoBulkLastConnKeyRef.current = connKey;
    aiAutoBulkPendingRef.current = false;

    addClientLog("ai_name.bulk.auto_trigger", { sessionId: conn.sessionId });
    void (async () => {
      try {
        const active = await getJson<{ sessions: SessionSummary[] }>(`${apiBase}/sessions`);
        await bulkAiNameOpenSessions({
          sessions: active.sessions ?? [],
          interactive: false,
          overwriteAiManagedOnly: true
        });
      } catch {
        // bulkAiNameOpenSessions already logs and updates status.
      }
    })();
  }, [aiAutoBulkNameOnReconnect, aiStatusLoaded, aiNamingEnabled, conn, apiBase, bulkAiNameOpenSessions, addClientLog]);

  useEffect(() => {
    if (!aiNamingEnabled) return;
    if (!aiAutoNameOnAttach) return;
    if (!activeSessionId) return;
    if (!currentKey) return;
    if (currentManualName) return;
    if (currentAutoName) return;
    if (aiAutoNameAttemptedRef.current.has(activeSessionId)) return;

    if (aiAutoNameTimerRef.current !== null) {
      window.clearTimeout(aiAutoNameTimerRef.current);
      aiAutoNameTimerRef.current = null;
    }

    aiAutoNameTimerRef.current = window.setTimeout(() => {
      aiAutoNameTimerRef.current = null;
      if (aiAutoNameAttemptedRef.current.has(activeSessionId)) return;
      aiAutoNameAttemptedRef.current.add(activeSessionId);
      void suggestAiNameForSession(activeSessionId, currentKey).catch(() => {
        // suggestAiNameForSession already logs and updates status.
      });
    }, AI_AUTONAME_ATTACH_DELAY_MS);

    return () => {
      if (aiAutoNameTimerRef.current !== null) {
        window.clearTimeout(aiAutoNameTimerRef.current);
        aiAutoNameTimerRef.current = null;
      }
    };
  }, [
    activeSessionId,
    aiAutoNameOnAttach,
    aiNamingEnabled,
    currentAutoName,
    currentKey,
    currentManualName,
    suggestAiNameForSession
  ]);

  const statusText = useMemo(() => {
    const trimmed = statusLine.trim();
    if (!trimmed) return "";
    if (/^(Connected|Reattached)\s+\([^)]+\)$/.test(trimmed)) return "";
    if (trimmed === "Connected" || trimmed === "Reattached") return "";
    if (trimmed === "Connecting…" || trimmed === "Disconnected") return "";
    return trimmed;
  }, [statusLine]);

  const uiStatus = useMemo(() => {
    if (conn.status === "connected" && !terminalReady) return "connecting";
    return conn.status;
  }, [conn.status, terminalReady]);
  const isTerminalReady = conn.status === "connected" && terminalReady;

  const orderedVisibleMobileActionIds = useMemo(() => {
    const order = normalizeMobileActionOrder(mobileActionOrder);
    return order.filter((id) => (id === "disconnect" ? isTerminalReady : true));
  }, [isTerminalReady, mobileActionOrder]);

  const statusTitle = useMemo(() => {
    if (statusText) return statusText;
    switch (uiStatus) {
      case "connected":
        return "Connected";
      case "connecting":
        return "Connecting…";
      case "disconnected":
        return "Disconnected";
      default:
        return "Idle";
    }
  }, [uiStatus, statusText]);

  const attentionCount = useMemo(() => {
    let count = 0;
    for (const session of activeSessions) {
      if (session.id === sessionId) continue;
      const at = sessionMeta[session.id]?.attentionAt;
      if (typeof at === "number" && Number.isFinite(at)) count += 1;
    }
    return count;
  }, [activeSessions, sessionId, sessionMeta]);

  const attentionLabel = useMemo(() => {
    if (attentionCount <= 0) return "";
    return attentionCount === 1 ? "1 session needs attention" : `${attentionCount} sessions need attention`;
  }, [attentionCount]);

  const aiRenameDisabled = !aiStatusLoaded || !aiNamingEnabled || activeSessions.length === 0;
  const aiRenameTitle = useMemo(() => {
    if (!aiStatusLoaded) return "AI naming unavailable";
    if (!aiNamingEnabled) return "AI naming disabled on server";
    if (activeSessions.length === 0) return "No open sessions";
    return "Auto-name open sessions";
  }, [activeSessions.length, aiNamingEnabled, aiStatusLoaded]);

  const availableTmuxSessions = useMemo(() => {
    if (savedSessions.length === 0) return { sessions: [], hiddenCount: 0 };
    const open = new Set<string>();
    for (const session of activeSessions) {
      if (session.mode !== "tmux") continue;
      if (session.tmuxName) open.add(session.tmuxName);
    }
    const sessions = savedSessions.filter((session) => !open.has(session.name));
    return { sessions, hiddenCount: savedSessions.length - sessions.length };
  }, [activeSessions, savedSessions]);

  const openAllTmuxSessions = useCallback(async () => {
    if (openAllTmuxInFlightRef.current) return openAllTmuxInFlightRef.current;
    const run = (async () => {
      const open = new Set<string>();
      for (const session of activeSessions) {
        if (session.mode !== "tmux") continue;
        if (session.tmuxName) open.add(session.tmuxName);
      }

      const targets = savedSessions.map((session) => session.name).filter((name) => !open.has(name));
      if (targets.length === 0) {
        setStatusLine(savedSessions.length === 0 ? "No tmux sessions found." : "All tmux sessions are already open.");
        return;
      }

      const ok = window.confirm(
        `Open ${targets.length} tmux session${targets.length === 1 ? "" : "s"}?\n\n` +
          `This will create ${targets.length} web session tab${targets.length === 1 ? "" : "s"} at the top.\n` +
          `If you hit the server session limit, it will stop early.\n\n` +
          `Note: this will NOT auto-open macOS Terminal windows.`
      );
      if (!ok) return;

      setOpeningAllTmuxSessions(true);
      addClientLog("tmux_open_all.start", { count: targets.length });
      setStatusLine(`Opening ${targets.length} tmux session${targets.length === 1 ? "" : "s"}…`);

      const size = getTerminalSize();
      let opened = 0;
      for (const name of targets) {
        try {
          await postJson<CreateSessionResponse>(`${apiBase}/sessions`, {
            mode: "tmux",
            tmuxName: name,
            launchTerminal: false,
            ...(size ?? {})
          });
          opened += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : "open failed";
          addClientLog("tmux_open_all.error", { error: message, opened, total: targets.length });
          setStatusLine(`Open failed: ${message} (opened ${opened}/${targets.length})`);
          if (message.startsWith("Session limit exceeded")) break;
          // For other errors, keep going so we open as many as possible.
        }
      }

      await refreshSessions();
      setStatusLine(`Opened ${opened}/${targets.length} tmux session${opened === 1 ? "" : "s"}.`);
      addClientLog("tmux_open_all.ok", { opened, total: targets.length });
    })();
    openAllTmuxInFlightRef.current = run;
    try {
      return await run;
    } finally {
      if (openAllTmuxInFlightRef.current === run) {
        openAllTmuxInFlightRef.current = null;
      }
      setOpeningAllTmuxSessions(false);
    }
  }, [activeSessions, addClientLog, apiBase, getTerminalSize, refreshSessions, savedSessions]);

  const cycleSession = useCallback(
    (delta: 1 | -1) => {
      if (orderedActiveSessions.length < 2) return;
      const index = orderedActiveSessions.findIndex((session) => session.id === sessionId);
      if (index < 0) return;
      const nextIndex = (index + delta + orderedActiveSessions.length) % orderedActiveSessions.length;
      const nextSession = orderedActiveSessions[nextIndex];
      if (!nextSession) return;
      void onAttachActive(nextSession.id);
    },
    [orderedActiveSessions, onAttachActive, sessionId]
  );

  const handleSwipe = useCallback(
    (direction: "left" | "right") => {
      cycleSession(direction === "left" ? 1 : -1);
    },
    [cycleSession]
  );

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (orderedActiveSessions.length < 2) return;

      const isAlt = event.altKey && !event.metaKey && !event.ctrlKey;
      if (!isAlt) return;

      const isTab = event.code === "Tab";
      const isPrev = (isTab && event.shiftKey) || event.code === "BracketLeft";
      const isNext = (isTab && !event.shiftKey) || event.code === "BracketRight";

      if (!isPrev && !isNext) return;

      event.preventDefault();
      event.stopPropagation();
      cycleSession(isPrev ? -1 : 1);
    };

    window.addEventListener("keydown", handleKeydown, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleKeydown, { capture: true });
    };
  }, [orderedActiveSessions.length, cycleSession]);

  const revealControls = useCallback(() => {
    setControlsHidden(false);
    if (isSmallScreen) setMobileControlsOpen(true);
  }, [isSmallScreen]);

  const compactDockEdge = compactDock.startsWith("left") ? "left" : "right";

  const computeCompactDock = useCallback(
    (clientX: number, clientY: number): CompactDock => {
      const rect = terminalWrapRef.current?.getBoundingClientRect();
      const left = rect?.left ?? 0;
      const top = rect?.top ?? 0;
      const width = rect?.width ?? window.innerWidth;
      const height = rect?.height ?? window.innerHeight;
      const midX = left + width / 2;
      const edge = clientX < midX ? "left" : "right";
      const third = height / 3;
      const relativeY = Math.min(Math.max(clientY - top, 0), height);
      let zone: "top" | "middle" | "bottom" = "middle";
      if (relativeY < third) zone = "top";
      else if (relativeY > third * 2) zone = "bottom";
      return `${edge}-${zone}` as CompactDock;
    },
    []
  );

  const handleCompactPointerDown = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const drag = compactDragRef.current;
    drag.active = true;
    drag.moved = false;
    drag.suppressClick = false;
    drag.pointerId = event.pointerId;
    drag.startX = event.clientX;
    drag.startY = event.clientY;
    setCompactDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const handleCompactPointerMove = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      const drag = compactDragRef.current;
      if (!drag.active || drag.pointerId !== event.pointerId) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        drag.moved = true;
      }
      const nextDock = computeCompactDock(event.clientX, event.clientY);
      setCompactDock((prev) => (prev === nextDock ? prev : nextDock));
    },
    [computeCompactDock]
  );

  const handleCompactPointerUp = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const drag = compactDragRef.current;
    if (!drag.active || drag.pointerId !== event.pointerId) return;
    drag.active = false;
    drag.pointerId = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setCompactDragging(false);
    if (drag.moved) drag.suppressClick = true;
  }, []);

  const handleCompactClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const drag = compactDragRef.current;
      if (drag.suppressClick) {
        drag.suppressClick = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      revealControls();
    },
    [revealControls]
  );

  const showFullControls = !controlsHidden && (!isSmallScreen || mobileControlsOpen);
  const showTabletHelperBar = !isSmallScreen && terminalHelperBarOnTablet;

  useEffect(() => {
    const label = currentManualName.trim() || "";
    const titleBits: string[] = [];
    if (label) titleBits.push(label);
    else if (sessionId) titleBits.push(shortId(sessionId));
    if (folderValue) titleBits.push(truncateMiddle(folderValue, 48));
    titleBits.push("console");
    document.title = titleBits.join(" — ");
  }, [currentManualName, folderValue, sessionId]);

  useEffect(() => {
    terminalRef.current?.fit();
  }, [settingsOpen, controlsHidden, sessionsOpen, activeSessions.length, mobileControlsOpen, isSmallScreen, taskNameStripVisible]);
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.dataset.terminalReady = isTerminalReady ? "1" : "0";
  }, [isTerminalReady]);

  return (
    <div
      className={`app ${controlsHidden ? "compact" : ""} ${controlsHidden ? `compactDock-${compactDockEdge}` : ""} ${
        settingsOpen ? "settingsOpen" : ""
      } ${showTabletHelperBar ? "showTerminalMobileBar" : ""}`}
    >
	      {isSmallScreen && (
		        <div className="mobileTopbar" data-editing={mobileActionEditMode ? "1" : "0"}>
	          <div className="mobileTopbarInfo" title={`Mode: ${mode} • ${statusTitle}`}>
	            <span className="statusDot" data-status={uiStatus} aria-hidden="true" />
              <span className="mobileTopbarTitle" aria-hidden="true">
                {mode}
              </span>
	          </div>
		          <div
		            className="mobileTopbarActions"
		            data-dragging={draggingMobileActionId ? "1" : "0"}
		            data-editing={mobileActionEditMode ? "1" : "0"}
		            title={mobileActionEditMode ? "Edit mode: long-press and drag to reorder." : undefined}
		          >
	            {orderedVisibleMobileActionIds.map((actionId) => {
	              let button: JSX.Element | null = null;
	              switch (actionId) {
	                case "sessions":
	                  button = (
	                    <button
	                      className="mobileButton"
	                      ref={sessionsToggleMobileRef}
	                      aria-controls="sessions-panel"
	                      aria-expanded={sessionsOpen}
	                      data-active={sessionsOpen ? "1" : "0"}
	                      data-attention={attentionCount > 0 ? "1" : "0"}
	                      onClick={() => {
	                        const next = !sessionsOpen;
	                        if (next) setSettingsOpen(false);
	                        setSessionsOpen(next);
	                        if (next) void refreshSessions();
	                      }}
	                      aria-label={
	                        sessionsOpen
	                          ? "Close sessions"
	                          : attentionLabel
	                            ? `Sessions (${attentionLabel})`
	                            : "Sessions"
	                      }
	                      title={
	                        sessionsOpen
	                          ? "Close sessions"
	                          : attentionLabel
	                            ? `Sessions (${attentionLabel})`
	                            : "Sessions"
	                      }
	                    >
	                      <span
	                        className="terminalMobileIcon"
	                        aria-hidden="true"
	                        style={maskStyleForSvgButton(sessionsOpen ? "ui-x.svg" : "ui-layers.svg")}
	                      />
	                    </button>
	                  );
	                  break;
	                case "aiRename":
	                  button = (
	                    <button
	                      className="mobileButton"
	                      onClick={onBulkAiRenameClick}
	                      disabled={aiRenameDisabled}
	                      aria-label="AI rename open sessions"
	                      title={aiRenameTitle}
	                    >
	                      <span
	                        className="terminalMobileIcon"
	                        aria-hidden="true"
	                        style={maskStyleForSvgButton("ui-sparkles.svg")}
	                      />
	                    </button>
	                  );
	                  break;
                  case "codexBrief":
                    button = (
                      <button
                        className="mobileButton"
                        onClick={() => void runCodexBrief()}
                        disabled={briefRunning}
                        data-loading={briefRunning ? "1" : "0"}
                        aria-label="Codex brief"
                        title={briefRunning ? "Generating brief…" : "Codex brief"}
                      >
                        <span
                          className="terminalMobileIcon"
                          aria-hidden="true"
                          style={maskStyleForSvgButton("ui-codex-brief.svg")}
                        />
                      </button>
                    );
                    break;
	                case "openAllTmux":
	                  button = (
	                    <button
	                      className="mobileButton"
	                      onClick={() => void openAllTmuxSessions()}
	                      disabled={openingAllTmuxSessions || availableTmuxSessions.sessions.length === 0}
	                      aria-label="Open all tmux sessions"
	                      title={
	                        availableTmuxSessions.sessions.length === 0
	                          ? "No tmux sessions to open"
	                          : `Open ${availableTmuxSessions.sessions.length} tmux session${
	                              availableTmuxSessions.sessions.length === 1 ? "" : "s"
	                            } as web tabs`
	                      }
	                    >
	                      <span
	                        className="terminalMobileIcon"
	                        aria-hidden="true"
	                        style={maskStyleForSvgButton("ui-open-all.svg")}
	                      />
	                    </button>
	                  );
	                  break;
	                case "newSession":
	                  button = (
	                    <button
	                      className="mobileButton"
	                      onClick={onCreate}
	                      disabled={conn.status === "connecting" || creatingSession}
	                      aria-label="New session"
	                      title="New session"
	                    >
	                      <span
	                        className="terminalMobileIcon"
	                        aria-hidden="true"
	                        style={maskStyleForSvgButton("ui-circle-plus.svg")}
	                      />
	                    </button>
	                  );
	                  break;
	                case "disconnect":
	                  button = (
	                    <button
	                      className="mobileButton"
	                      onClick={onDisconnectOnly}
	                      disabled={conn.status !== "connected"}
	                      aria-label="Disconnect"
	                      title="Disconnect"
	                    >
	                      <span
	                        className="terminalMobileIcon"
	                        aria-hidden="true"
	                        style={maskStyleForSvgButton("ui-square-stop.svg")}
	                      />
	                    </button>
	                  );
	                  break;
                case "reconnect":
                  button = (
                    <button
                      className="mobileButton"
                      onClick={onReattach}
                      disabled={!sessionId && !safeGet(sessionStore, SESSION_STORAGE_KEY)}
                      aria-label="Reconnect"
                      title="Reconnect"
                    >
                      <span
                        className="terminalMobileIcon"
                        aria-hidden="true"
                        style={maskStyleForSvgButton("ui-arrow-right-to-line.svg")}
                      />
                    </button>
                  );
                  break;
                case "endSession":
                  button = (
                    <button
                      className="mobileButton"
                      onClick={onDeleteCurrent}
                      disabled={!sessionId && !safeGet(sessionStore, SESSION_STORAGE_KEY)}
                      aria-label="Delete session"
                      title="Delete session"
                    >
                      <span
                        className="terminalMobileIcon"
                        aria-hidden="true"
                        style={maskStyleForSvgButton("ui-trash-2.svg")}
                      />
                    </button>
                  );
                  break;
                case "docs":
                  button = (
                    <a className="mobileButton" href={docsUrl} target="_blank" rel="noreferrer" aria-label="Docs" title="Docs">
                      <span
                        className="terminalMobileIcon"
                        aria-hidden="true"
                        style={maskStyleForSvgButton("ui-folder.svg")}
                      />
                    </a>
                  );
                  break;
                case "tasks":
                  button = (
                    <a
                      className="mobileButton"
                      href={tasksUrl}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="Tasks"
                      title="Tasks"
                    >
                      <span
                        className="terminalMobileIcon"
                        aria-hidden="true"
                        style={maskStyleForSvgButton("ui-clipboard.svg")}
                      />
                    </a>
                  );
                  break;
	                case "refresh":
	                  button = (
	                    <button
	                      className="mobileButton"
	                      onClick={() => void onRefreshCurrentTab()}
	                      aria-label="Refresh tab"
	                      title="Refresh tab"
	                    >
	                      <span
	                        className="terminalMobileIcon"
	                        aria-hidden="true"
	                        style={maskStyleForSvgButton("ui-refresh-cw.svg")}
	                      />
	                    </button>
	                  );
	                  break;
	                case "controls":
	                  button = (
	                    <button
	                      className="mobileButton"
	                      onClick={() => {
	                        setControlsHidden(false);
	                        setMobileControlsOpen((prev) => !prev);
	                      }}
	                      data-active={mobileControlsOpen ? "1" : "0"}
	                      aria-label={mobileControlsOpen ? "Hide controls" : "Controls"}
	                      title={mobileControlsOpen ? "Hide controls" : "Controls"}
	                    >
	                      <span
	                        className="terminalMobileIcon"
	                        aria-hidden="true"
	                        style={maskStyleForSvgButton(mobileControlsOpen ? "ui-x.svg" : "ui-sliders.svg")}
	                      />
	                    </button>
	                  );
	                  break;
                case "hide":
                  button = (
                    <button
                      className="mobileButton"
                      onClick={() => {
                        setControlsHidden(true);
                        setMobileControlsOpen(false);
                      }}
                      aria-label="Hide controls"
                      title="Hide"
                    >
                      <span
                        className="terminalMobileIcon"
                        aria-hidden="true"
                        style={maskStyleForSvgButton("ui-chevrons-up.svg")}
                      />
                    </button>
                  );
                  break;
	                case "settings":
	                  button = (
	                    <button
	                      className="mobileButton settingsToggle"
	                      ref={settingsToggleMobileRef}
	                      onClick={(event) => {
	                        const next = !settingsOpen;
	                        if (next) settingsRestoreFocusRef.current = event.currentTarget;
	                        setSettingsOpen(next);
	                        if (next) setSessionsOpen(false);
	                      }}
	                      aria-haspopup="dialog"
	                      aria-expanded={settingsOpen}
	                      aria-controls="settings-dialog"
	                      data-active={settingsOpen ? "1" : "0"}
	                      aria-label={settingsOpen ? "Close settings" : "Settings"}
	                      title={settingsOpen ? "Close settings" : "Settings"}
	                    >
	                      <span
	                        className="terminalMobileIcon"
	                        aria-hidden="true"
	                        style={maskStyleForSvgButton(settingsOpen ? "ui-x.svg" : "ui-settings.svg")}
	                      />
	                    </button>
	                  );
	                  break;
	                default:
	                  button = null;
	              }

	              if (!button) return null;
	              const dragging = draggingMobileActionId === actionId;
	              return (
	                <div
	                  key={actionId}
	                  className={`mobileActionHandle${dragging ? " dragging" : ""}`}
	                  data-mobile-action-id={actionId}
	                  onContextMenu={(event) => {
	                    event.preventDefault();
	                    event.stopPropagation();
	                  }}
	                  onPointerDown={(event) => handleMobileActionPointerDown(event, actionId)}
	                  onPointerMove={handleMobileActionPointerMove}
	                  onPointerUp={handleMobileActionPointerUp}
	                  onPointerCancel={handleMobileActionPointerUp}
	                  onClickCapture={handleMobileActionClickCapture}
	                >
	                  {button}
	                </div>
	              );
	            })}
		          </div>
		          <div className="mobileTopbarEdit">
		            <button
		              className="mobileButton mobileEditToggle"
		              onClick={() => setMobileActionEditMode((prev) => !prev)}
		              aria-pressed={mobileActionEditMode}
		              data-active={mobileActionEditMode ? "1" : "0"}
		              aria-label={mobileActionEditMode ? "Done editing toolbar" : "Edit toolbar"}
		              title={mobileActionEditMode ? "Done" : "Edit"}
		            >
		              {mobileActionEditMode ? "Done" : "Edit"}
		            </button>
		          </div>
		        </div>
		      )}
      {showFullControls && (
        <div className={`topbar ${isSmallScreen ? "mobileControls" : ""}`}>
        <select className="select" value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
          <option value="node">node</option>
          <option value="shell">shell</option>
          <option value="readonly_tail">readonly_tail</option>
          <option value="tmux">tmux</option>
        </select>
        <button
          className="button"
          onClick={onCreate}
          disabled={conn.status === "connecting" || creatingSession}
          aria-label="New session"
          title="New session"
        >
          <span className="terminalMobileIcon" aria-hidden="true" style={maskStyleForSvgButton("ui-circle-plus.svg")} />
          <span className="buttonLabel">New session</span>
        </button>
        <button
          className="button"
          onClick={onDisconnectOnly}
          disabled={conn.status !== "connected"}
          aria-label="Disconnect"
          title="Disconnect"
        >
          <span className="terminalMobileIcon" aria-hidden="true" style={maskStyleForSvgButton("ui-square-stop.svg")} />
          <span className="buttonLabel">Disconnect</span>
        </button>
        <button
          className="button danger"
          onClick={onDeleteCurrent}
          disabled={!sessionId && !safeGet(sessionStore, SESSION_STORAGE_KEY)}
          aria-label="Delete session"
          title="Delete session"
        >
          <span className="terminalMobileIcon" aria-hidden="true" style={maskStyleForSvgButton("ui-trash-2.svg")} />
          <span className="buttonLabel">Delete</span>
        </button>
			        <button
			          className="button settingsToggle"
			          ref={settingsToggleRef}
			          onClick={(event) => {
			            const next = !settingsOpen;
			            if (next) settingsRestoreFocusRef.current = event.currentTarget;
			            setSettingsOpen(next);
			            if (next) setSessionsOpen(false);
			          }}
			          aria-haspopup="dialog"
			          aria-expanded={settingsOpen}
			          aria-controls="settings-dialog"
			          data-active={settingsOpen ? "1" : "0"}
	              aria-label={settingsOpen ? "Close settings" : "Settings"}
	              title={settingsOpen ? "Close settings" : "Settings"}
			        >
          <span
            className="terminalMobileIcon"
            aria-hidden="true"
            style={maskStyleForSvgButton(settingsOpen ? "ui-x.svg" : "ui-settings.svg")}
          />
          <span className="buttonLabel">{settingsOpen ? "Close" : "Settings"}</span>
        </button>
        <button
          className="button"
          onClick={onReattach}
          disabled={!sessionId && !safeGet(sessionStore, SESSION_STORAGE_KEY)}
          aria-label="Reconnect"
          title="Reconnect"
        >
          <span className="terminalMobileIcon" aria-hidden="true" style={maskStyleForSvgButton("ui-refresh-cw.svg")} />
          <span className="buttonLabel">Reconnect</span>
        </button>
			        <button
			          className="button"
			          ref={sessionsToggleRef}
			          aria-controls="sessions-panel"
			          aria-expanded={sessionsOpen}
			          onClick={() => {
			            const next = !sessionsOpen;
			            if (next) setSettingsOpen(false);
			            setSessionsOpen(next);
			            if (next) void refreshSessions();
		          }}
		          data-active={sessionsOpen ? "1" : "0"}
              aria-label={sessionsOpen ? "Close sessions" : "Sessions"}
              title={sessionsOpen ? "Close sessions" : "Sessions"}
		        >
          <span
            className="terminalMobileIcon"
            aria-hidden="true"
            style={maskStyleForSvgButton(sessionsOpen ? "ui-x.svg" : "ui-layers.svg")}
		          />
			          <span className="buttonLabel">Sessions</span>
			        </button>
			        <button
			          type="button"
			          className="iconButton"
			          onClick={onBulkAiRenameClick}
			          disabled={aiRenameDisabled}
			          aria-label="AI rename open sessions"
			          title={aiRenameTitle}
			        >
			          <span className="terminalMobileIcon" aria-hidden="true" style={maskStyleForSvgButton("ui-sparkles.svg")} />
			        </button>
              <button
                type="button"
                className="iconButton briefButton"
                data-testid="codex-brief-button"
                data-loading={briefRunning ? "1" : "0"}
                onClick={() => void runCodexBrief()}
                disabled={briefRunning}
                aria-label="Codex brief"
                title={briefRunning ? "Generating brief…" : "Codex brief"}
              >
                <span className="terminalMobileIcon" aria-hidden="true" style={maskStyleForSvgButton("ui-codex-brief.svg")} />
                {formatCentsShort(briefLastCost?.totalCents ?? null) && (
                  <span className="briefBadge" data-testid="codex-brief-cost">
                    {formatCentsShort(briefLastCost?.totalCents ?? null)}
                  </span>
                )}
              </button>
			        <button
			          type="button"
			          className="iconButton"
		          onClick={() => void openAllTmuxSessions()}
		          disabled={openingAllTmuxSessions || availableTmuxSessions.sessions.length === 0}
	          aria-label="Open all tmux sessions"
	          title={
	            availableTmuxSessions.sessions.length === 0
	              ? "No tmux sessions to open"
	              : `Open ${availableTmuxSessions.sessions.length} tmux session${
	                  availableTmuxSessions.sessions.length === 1 ? "" : "s"
	                } as web tabs`
	          }
		        >
		          <span className="terminalMobileIcon" aria-hidden="true" style={maskStyleForSvgButton("ui-open-all.svg")} />
		        </button>
		        <a className="button" href={docsUrl} target="_blank" rel="noreferrer" aria-label="Docs" title="Docs">
		          <span className="terminalMobileIcon" aria-hidden="true" style={maskStyleForSvgButton("ui-folder.svg")} />
		          <span className="buttonLabel">Docs</span>
		        </a>
	        <a
	          className="iconButton"
	          href={tasksUrl}
          target="_blank"
          rel="noreferrer"
          aria-label="Open task library"
          title="Tasks"
        >
          <span className="terminalMobileIcon" aria-hidden="true" style={maskStyleForSvgButton("ui-clipboard.svg")} />
        </a>
        <div className="spacer" />
        <div className="status" title={statusTitle} aria-live="polite">
          <span className="statusDot" data-status={conn.status} aria-hidden="true" />
          {statusText && <span className="statusText">{statusText}</span>}
        </div>
	        <button
	          className="button"
	          onClick={() => {
	            setControlsHidden(true);
	            setMobileControlsOpen(false);
	          }}
            aria-label="Hide controls"
            title="Hide"
	        >
	          <span className="terminalMobileIcon" aria-hidden="true" style={maskStyleForSvgButton("ui-chevrons-up.svg")} />
	          <span className="buttonLabel">Hide</span>
	        </button>
		      </div>
		      )}
			      <div className="main">
			        {taskNameStripVisible && (
			          <div className="autoNameStrip" title={taskNameStripValue}>
			            {taskNameStripLabel && <span className="autoNameStripLabel">{taskNameStripLabel}</span>}
			            <span className="autoNameStripValue">{taskNameStripValue}</span>
			          </div>
			        )}
	        {orderedActiveSessions.length > 0 && (
	          <div
	            className="sessionTabs"
	            ref={sessionTabsRef}
	            data-dragging={draggingSessionTabKey ? "1" : "0"}
	            role="tablist"
	            aria-label="Sessions"
	          >
				          {(() => {
	                  const badgeCounts = new Map<string, number>();
	                  return orderedActiveSessions.map((session) => {
					              const k = keyForSession(session.id, session.tmuxName);
				              const meta = sessionMeta[k];
				              const taskName = (meta?.name ?? "").trim();
                    const baseBadge = deriveSessionTabBadge(taskName, session.tmuxName, session.id);
                    const seen = badgeCounts.get(baseBadge) ?? 0;
                    badgeCounts.set(baseBadge, seen + 1);
                    const badge = seen === 0 ? baseBadge : disambiguateSessionTabBadge(baseBadge, session.id);
			              const name = taskName || session.tmuxName || shortId(session.id);
			              const detail = meta?.lastTitle || session.cwd || "";
				              const label = name || shortId(session.id);
				              const color = sessionTabColor(k);
				              const isActive = sessionId === session.id;
			              const needsAttention =
			                !isActive && typeof meta?.attentionAt === "number" && Number.isFinite(meta.attentionAt);
              const serverCodexState = session.codexState;
              const codexExecRunning = codexRunning && codexSessionKeyRef.current === k;
              const codexState = codexExecRunning
                ? "running"
                : isActive && terminalCodexState !== "idle"
                  ? terminalCodexState
                  : (serverCodexState ?? meta?.codexState ?? "idle");
              const style = { "--tab-color": color } as CSSProperties;
	              return (
	                <button
	                  key={session.id}
		                  type="button"
		                  className={`sessionTab ${isActive ? "active" : ""}${draggingSessionTabKey === k ? " dragging" : ""}`}
		                  data-attention={needsAttention ? "1" : "0"}
		                  data-session-key={k}
	                  onContextMenu={(event) => {
	                    event.preventDefault();
	                    event.stopPropagation();
	                  }}
		                  onPointerDown={(event) => handleSessionTabPointerDown(event, k)}
		                  onPointerMove={handleSessionTabPointerMove}
		                  onPointerUp={handleSessionTabPointerUp}
		                  onPointerCancel={handleSessionTabPointerUp}
		                  onClick={(event) => {
		                    handleSessionTabClick(event);
		                    if (event.defaultPrevented) return;
		                    if (!isActive) onAttachActive(session.id);
		                  }}
	                  role="tab"
	                  aria-selected={isActive}
	                  aria-label={label}
                  title={detail ? `${label} — ${detail}` : label}
		                  style={style}
		                >
			                  <span className="sessionTabCap" aria-hidden="true" />
			                  <span className={`sessionTabStatus ${codexState}`} title={`Codex: ${codexState}`} />
			                  <span className="sessionTabLabel" aria-hidden="true">
			                    {badge}
			                  </span>
			                </button>
		              );
			            });
                  })()}
		          </div>
		        )}
        {sessionsOpen && (
          <div className="sessionPanel" id="sessions-panel" role="region" aria-label="Sessions" ref={sessionPanelRef}>
            <div className="sessionPanelHeader">
              <div className="sessionTitle">Sessions</div>
              <div className="sessionPanelActions">
                <button
                  type="button"
                  className="button"
                  onClick={() => void onRefreshCurrentTab()}
                  title="Refresh current tab and sync sessions list"
                >
                  Refresh tab
                </button>
	                <button
	                  type="button"
	                  className="button"
	                  onClick={() => {
	                    void bulkAiNameOpenSessions().catch(() => {
	                      // bulkAiNameOpenSessions already logs and updates status.
	                    });
	                  }}
	                  disabled={!aiStatusLoaded || !aiNamingEnabled || activeSessions.length === 0}
	                  title={
	                    !aiStatusLoaded
	                      ? "AI naming unavailable"
	                      : !aiNamingEnabled
	                        ? "AI naming disabled on server"
	                        : activeSessions.length === 0
	                          ? "No open sessions"
	                          : "Auto-name open sessions"
	                  }
	                >
	                  AI rename
	                </button>
	                <button
	                  type="button"
	                  className="button danger"
	                  onClick={() => void endAllActiveSessions()}
	                  disabled={orderedActiveSessions.length === 0}
	                  title={
	                    orderedActiveSessions.length === 0
	                      ? "No active web sessions"
	                      : "End all active web sessions (tmux sessions stay alive)"
	                  }
	                >
	                  End all
	                </button>
	                <button
	                  type="button"
	                  className="iconButton"
	                  onClick={() => setSessionsOpen(false)}
	                  aria-label="Close sessions"
                >
                  <svg viewBox="0 0 24 24" role="img" focusable="false" aria-hidden="true">
                    <path
                      d="M6 6l12 12M18 6L6 18"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>
	            </div>
	            <div className="sessionSection">
	              <div className="sessionTitle">Active (web)</div>
	              {orderedActiveSessions.length === 0 && <div className="sessionEmpty">No active sessions</div>}
	              {orderedActiveSessions.map((session, index) => (
	                <div className={`sessionRow ${sessionId === session.id ? "active" : ""}`} key={session.id}>
	                  <div className="sessionInfo">
			                  {(() => {
			                    const k = keyForSession(session.id, session.tmuxName);
		                    const meta = sessionMeta[k];
		                    const systemName = session.tmuxName || shortId(session.id);
		                    const taskName = (meta?.name ?? "").trim();
		                    const detail = meta?.lastTitle || session.cwd || "";
		                    const codexExecRunning = codexRunning && codexSessionKeyRef.current === k;
		                    const serverCodexState = session.codexState;
		                    const codexState = codexExecRunning
                      ? "running"
                      : sessionId === session.id && terminalCodexState !== "idle"
                        ? terminalCodexState
                        : (serverCodexState ?? meta?.codexState ?? "idle");
                    return (
	                      <>
	                        <div className="sessionNameRow">
	                          <span className={`sessionStatusDot ${codexState}`} title={`Codex: ${codexState}`} />
	                          <div className="sessionName">{systemName}</div>
		                        </div>
		                        {taskName && (
		                          <div className="sessionTaskName" title={taskName}>
		                            {taskName}
		                          </div>
		                        )}
		                        <div className="sessionMeta">
		                          {session.mode}
	                          {detail ? ` • ${detail}` : ""}
	                        </div>
	                      </>
                    );
	                  })()}
	                </div>
		                  <div className="sessionActions">
	                      <button
	                        type="button"
	                        className="iconButton"
	                        onClick={() => moveSessionTabBy(keyForSession(session.id, session.tmuxName), -1)}
	                        disabled={orderedActiveSessions.length < 2 || index === 0}
	                        aria-label="Move tab left"
	                        title="Move tab left"
	                      >
	                        <span
	                          className="terminalMobileIcon"
	                          aria-hidden="true"
	                          style={maskStyleForSvgButton("ui-arrow-left.svg")}
	                        />
	                      </button>
	                      <button
	                        type="button"
	                        className="iconButton"
	                        onClick={() => moveSessionTabBy(keyForSession(session.id, session.tmuxName), 1)}
	                        disabled={orderedActiveSessions.length < 2 || index === orderedActiveSessions.length - 1}
	                        aria-label="Move tab right"
	                        title="Move tab right"
	                      >
	                        <span
	                          className="terminalMobileIcon"
	                          aria-hidden="true"
	                          style={maskStyleForSvgButton("ui-arrow-right.svg")}
	                        />
	                      </button>
	                      <button
	                        type="button"
	                        className="iconButton"
	                        onClick={() => promptRenameTaskForKey(keyForSession(session.id, session.tmuxName))}
                        aria-label="Rename task"
                        title="Rename task"
                      >
                        <span
                          className="terminalMobileIcon"
                          aria-hidden="true"
                          style={maskStyleForSvgButton("edit-svgrepo-com.svg")}
                        />
                      </button>
	                    <button className="button" onClick={() => onAttachActive(session.id)}>
	                      Open
	                    </button>
	                    <button
	                      className="button danger"
                      onClick={() => {
                        if (!window.confirm("Delete this session?")) return;
                        void deleteActiveSession(session.id);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
	            <div className="sessionSection">
		              <div className="sessionTitleRow">
		                <div className="sessionTitle">tmux (server)</div>
		              </div>
	              {availableTmuxSessions.hiddenCount > 0 && (
	                <div
	                  className="sessionMeta"
                  title="Tmux sessions that already have an active web session are shown in Active above."
                >
                  Hidden {availableTmuxSessions.hiddenCount} already open above
                </div>
              )}
              {savedSessions.length === 0 && <div className="sessionEmpty">No tmux sessions</div>}
              {savedSessions.length > 0 && availableTmuxSessions.sessions.length === 0 && (
                <div className="sessionEmpty">All tmux sessions are already open above</div>
              )}
              {availableTmuxSessions.sessions.map((session) => (
                <div className="sessionRow" key={session.name}>
                  <div className="sessionInfo">
		                  {(() => {
		                    const k = keyForSession(session.name, session.name);
		                    const meta = sessionMeta[k];
		                    const systemName = session.name;
		                    const taskName = (meta?.name ?? "").trim();
		                    const detail = meta?.lastTitle || formatTmuxSessionDetail(session);
		                    const codexState = meta?.codexState ?? "idle";
		                    return (
		                      <>
	                        <div className="sessionNameRow">
	                          <span className={`sessionStatusDot ${codexState}`} title={`Codex: ${codexState}`} />
	                          <div className="sessionName">{systemName}</div>
		                        </div>
		                        {taskName && (
		                          <div className="sessionTaskName" title={taskName}>
		                            {taskName}
		                          </div>
		                        )}
		                        <div className="sessionMeta">{detail}</div>
		                      </>
	                    );
	                  })()}
	                </div>
	                  <div className="sessionActions">
                      <button
                        type="button"
                        className="iconButton"
                        onClick={() => promptRenameTaskForKey(keyForSession(session.name, session.name))}
                        aria-label="Rename task"
                        title="Rename task"
                      >
                        <span
                          className="terminalMobileIcon"
                          aria-hidden="true"
                          style={maskStyleForSvgButton("edit-svgrepo-com.svg")}
                        />
                      </button>
	                    <button className="button" onClick={() => onAttachPersistent(session.name)}>
	                      Open
	                    </button>
	                    <button
	                      className="button danger"
                      disabled={isNumericSessionName(session.name)}
                      title={
                        isNumericSessionName(session.name)
                          ? "Delete disabled: numeric (manual) session"
                          : (typeof session.attachedCount === "number"
                                ? session.attachedCount
                                : session.attached
                                  ? 1
                                  : 0) > 0
                            ? "Force delete this tmux session (currently attached)"
                            : "Delete this tmux session"
                      }
                      onClick={() => {
                        if (isNumericSessionName(session.name)) return;
                        const attachedCount =
                          typeof session.attachedCount === "number" ? session.attachedCount : session.attached ? 1 : 0;
                        if (attachedCount > 0) {
                          const ok = window.confirm(
                            `This tmux session is currently attached (${attachedCount} client${
                              attachedCount === 1 ? "" : "s"
                            }). Force delete anyway? This will disconnect it.`
                          );
                          if (!ok) return;
                          void deletePersistentSession(session.name, { force: true });
                          return;
                        }
                        if (!window.confirm("Delete this tmux session?")) return;
                        void deletePersistentSession(session.name);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {settingsOpen && (
          <div className="overlay settingsOverlay" onClick={() => setSettingsOpen(false)}>
            <div
              className="settingsCard"
              id="settings-dialog"
              tabIndex={-1}
              ref={settingsCardRef}
              role="dialog"
              aria-modal="true"
              aria-label="Settings"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="settingsHeader">
                <div className="settingsTitle">Settings</div>
                <button
                  type="button"
                  className="iconButton"
                  onClick={() => setSettingsOpen(false)}
                  aria-label="Close settings"
                >
                  <svg viewBox="0 0 24 24" role="img" focusable="false" aria-hidden="true">
                    <path
                      d="M6 6l12 12M18 6L6 18"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>
              <div className="settingsBody">
                <div className="audioPanel terminalPanel">
                  <div className="audioHeader">
                    <div className="audioTitle">Terminal</div>
                  </div>
                  <div className="audioSection">
                    <div className="audioSectionTitle">Font size</div>
                    <div className="audioRow">
                      <label className="audioToggle">
                        Size
                        <input
                          className="audioRange"
                          type="range"
                          min={TERMINAL_FONT_MIN}
                          max={TERMINAL_FONT_MAX}
                          step="1"
                          value={terminalFontSize}
                          onChange={(e) => applyTerminalFontSize(Number(e.target.value))}
                        />
                        <span className="audioValue">{terminalFontSize}px</span>
                      </label>
                      <button
                        type="button"
                        className="button"
                        onClick={() => stepTerminalFontSize(-1)}
                        aria-label="Decrease terminal font size"
                      >
                        A-
                      </button>
                      <button
                        type="button"
                        className="button"
                        onClick={() => stepTerminalFontSize(1)}
                        aria-label="Increase terminal font size"
                      >
                        A+
	                      </button>
	                    </div>
		                  </div>
		                  <div className="audioSection">
			                    <div className="audioSectionTitle">UI</div>
			                    <div className="audioRow">
			                      <label
			                        className="audioToggle"
			                        title="Shows the Esc/Tab/Ctrl+C helper bar under the terminal on tablets."
			                      >
			                        <input
			                          type="checkbox"
			                          checked={terminalHelperBarOnTablet}
			                          onChange={(e) => applyTerminalHelperBarOnTablet(e.target.checked)}
			                        />
			                        Tablet helper keys
			                      </label>
			                    </div>
			                    <div className="audioRow">
			                      <label
			                        className="audioToggle"
			                        title="When creating a new tmux session, prompt for a tmux session name instead of auto-generating one."
			                      >
			                        <input
			                          type="checkbox"
			                          checked={promptTmuxNameOnCreate}
			                          onChange={(e) => applyPromptTmuxNameOnCreate(e.target.checked)}
			                        />
			                        Prompt for tmux name
			                      </label>
			                    </div>
			                  </div>
			                </div>
                    <div className="audioPanel">
                      <div className="audioHeader">
                        <div className="audioTitle">Applets</div>
                        {appletsStackRestartEnabled ? (
                          <div className="audioHint">
                            {appletsStackLogPath ? `Log: ${appletsStackLogPath}` : "Enabled"}
                          </div>
                        ) : (
                          <div className="audioHint">
                            Disabled: set CONSOLE_ENABLE_APPLETS_STACK_RESTART=1 and restart
                          </div>
                        )}
                      </div>
                      <div className="audioSection">
                        <div className="audioSectionTitle">Stack</div>
                        <div className="audioRow">
                          <button
                            type="button"
                            className="button danger"
                            data-testid="applets-restart"
                            onClick={() => void restartAppletsStack()}
                            disabled={!appletsStackRestartEnabled || appletsStackRestarting}
                            title="Restarts FastAPI (:8000) + the applets UI proxy (:3000)"
                          >
                            Restart applets
                          </button>
                          <div className="audioStatus">{appletsStackStatus}</div>
                        </div>
                        <div className="audioNotice">
                          Restarts the applets stack as a detached process (no tmux session).
                        </div>
                      </div>
                      <div className="audioSection">
                        <div className="audioSectionTitle">Console terminal</div>
                        <div className="audioRow">
                          <button
                            type="button"
                            className="button danger"
                            onClick={() => void restartConsoleStack("prod")}
                            disabled={!appletsStackRestartEnabled || consoleRestartBusy !== null}
                            title="Restart prod console stack (tmux: applets_console_bounce)"
                          >
                            Restart prod
                          </button>
                          <button
                            type="button"
                            className="button danger"
                            onClick={() => void restartConsoleStack("root")}
                            disabled={!appletsStackRestartEnabled || consoleRestartBusy !== null}
                            title="Restart root console stack (tmux: applets_root_bounce)"
                          >
                            Restart root
                          </button>
                          <button
                            type="button"
                            className="button danger"
                            onClick={() => void restartConsoleStack("dev")}
                            disabled={!appletsStackRestartEnabled || consoleRestartBusy !== null}
                            title="Restart dev servers + UIs (tmux: applets_dev)"
                          >
                            Restart dev
                          </button>
                          <div className="audioStatus">{consoleRestartStatus}</div>
                        </div>
                        <div className="audioNotice">
                          Runs detached tmux restarts (prod/root) or recreates the `applets_dev` session (dev).
                        </div>
                      </div>
                    </div>
		                <div className="audioPanel">
		                  <div className="audioHeader">
		                    <div className="audioTitle">AI naming</div>
	                    {aiStatusLoaded ? (
	                      aiNamingEnabled ? (
	                        <div className="audioHint">{aiModel ? `Model: ${aiModel}` : "Enabled"}</div>
	                      ) : (
	                        <div className="audioHint">Disabled: set CONSOLE_ENABLE_AI_NAMING=1 and restart</div>
	                      )
	                    ) : (
	                      <div className="audioHint">Unavailable</div>
	                    )}
	                  </div>
	                  <div className="audioSection">
	                    <div className="audioSectionTitle">Automation</div>
	                    <div className="audioRow">
	                      <label
	                        className="audioToggle"
	                        onClick={(e) => {
	                          if ((e.target as HTMLElement).tagName === "INPUT") return;
	                          if (!aiStatusLoaded || !aiNamingEnabled) return;
	                          e.preventDefault();
	                          applyAiAutoNameOnAttach(!aiAutoNameOnAttach);
	                        }}
	                      >
		                        <input
		                          type="checkbox"
		                          checked={aiAutoNameOnAttach}
		                          disabled={!aiStatusLoaded || !aiNamingEnabled}
		                          data-testid="ai-autoname-attach"
		                          onChange={(e) => applyAiAutoNameOnAttach(e.target.checked)}
		                        />
		                        Auto-name on attach
		                      </label>
		                      <label
		                        className="audioToggle"
		                        title="Includes recent terminal output in the prompt."
		                        onClick={(e) => {
		                          if ((e.target as HTMLElement).tagName === "INPUT") return;
		                          if (!aiStatusLoaded || !aiNamingEnabled) return;
		                          e.preventDefault();
		                          applyAiIncludeOutput(!aiIncludeOutput);
		                        }}
		                      >
			                        <input
			                          type="checkbox"
			                          checked={aiIncludeOutput}
			                          disabled={!aiStatusLoaded || !aiNamingEnabled}
			                          data-testid="ai-autoname-include-output"
			                          onChange={(e) => applyAiIncludeOutput(e.target.checked)}
			                        />
			                        Include output tail
			                      </label>
		                      <label
		                        className="audioToggle"
		                        title="After reconnect (e.g. prod restart), auto-refresh AI-named sessions and fill unnamed sessions. Never overwrites user-set names."
		                        onClick={(e) => {
		                          if ((e.target as HTMLElement).tagName === "INPUT") return;
		                          if (!aiStatusLoaded || !aiNamingEnabled) return;
		                          e.preventDefault();
		                          applyAiAutoBulkNameOnReconnect(!aiAutoBulkNameOnReconnect);
		                        }}
		                      >
			                        <input
			                          type="checkbox"
			                          checked={aiAutoBulkNameOnReconnect}
			                          disabled={!aiStatusLoaded || !aiNamingEnabled}
			                          data-testid="ai-autobulk-reconnect"
			                          onChange={(e) => applyAiAutoBulkNameOnReconnect(e.target.checked)}
			                        />
			                        Auto-bulk on reconnect
			                      </label>
		                      <div className="audioStatus">{aiNameStatus}</div>
		                    </div>
	                    {aiIncludeOutput && (
	                      <div className="audioNotice">
	                        Warning: output tail may include secrets. Leave off unless you need better names.
	                      </div>
	                    )}
	                  </div>
	                  <div className="audioSection">
	                    <div className="audioSectionTitle">Suggestion</div>
	                    <div className="audioRow">
	                      <button
	                        type="button"
	                        className="button"
	                        onClick={() => {
	                          if (!activeSessionId || !currentKey) {
	                            setAiNameStatus("Connect a session first.");
	                            return;
	                          }
	                          void suggestAiNameForSession(activeSessionId, currentKey).catch(() => {
	                            // suggestAiNameForSession already logs and updates status.
	                          });
	                        }}
	                        disabled={!aiStatusLoaded || !aiNamingEnabled || !activeSessionId || !currentKey}
	                      >
	                        Suggest now
	                      </button>
	                      <button
	                        type="button"
	                        className="button"
	                        onClick={applyAiAutoNameToManual}
	                        disabled={!currentKey || !currentAutoName}
	                        title={
	                          currentManualName
	                            ? "Overwrites the manual name."
	                            : "Use the AI suggestion as the manual name."
	                        }
	                      >
	                        Use suggestion
	                      </button>
	                      <button
	                        type="button"
	                        className="button danger"
	                        onClick={clearAiAutoName}
	                        disabled={!currentKey || !currentAutoName}
	                      >
	                        Clear
	                      </button>
	                    </div>
	                    {currentAutoName && (
	                      <div className="audioNotice" title={currentAutoName}>
	                        Suggested: {currentAutoName}
	                      </div>
	                    )}
		                    {currentManualName && (
		                      <div className="audioNotice" title={currentManualName}>
		                        Manual: {currentManualName}
		                      </div>
		                    )}
		                  </div>
		                  <div className="audioSection">
		                    <div className="audioSectionTitle">Bulk</div>
		                    <div className="audioRow">
		                      <button
		                        type="button"
		                        className="button"
		                        onClick={() => {
		                          void bulkAiNameOpenSessions().catch(() => {
		                            // bulkAiNameOpenSessions already logs and updates status.
		                          });
		                        }}
		                        disabled={!aiStatusLoaded || !aiNamingEnabled || activeSessions.length === 0}
		                      >
		                        Auto-name open sessions
		                      </button>
		                      <div className="audioStatus">{activeSessions.length} open</div>
		                    </div>
		                    <div className="audioNotice">
		                      Updates manual task names for active web sessions (open tabs). Prompts before overwriting.
		                    </div>
		                  </div>
		                </div>
			                <div className="audioPanel">
			                  <div className="audioHeader">
			                    <div className="audioTitle">Audio</div>
		                    {!activeSessionId && <div className="audioHint">Connect a session to enable audio.</div>}
                        {activeSessionId && !audioPrefsReady && (
                          <div className="audioHint">Loading audio settings...</div>
                        )}
	                  </div>
		                  <div className="audioSection">
	                    <div className="audioSectionTitle">
	                      TTS (read {ttsSource === "codex" ? "codex output" : "terminal output"})
	                    </div>
	                    {ttsEnabled && ttsEngine !== "browser" && <div className="audioNotice">AI-generated voice</div>}
	                    <div className="audioRow">
	                      <label
	                        className="audioToggle"
	                        onClick={(e) => {
	                          if ((e.target as HTMLElement).tagName === "INPUT") return;
	                          if (!activeSessionId || !audioPrefsReady) return;
	                          e.preventDefault();
	                          const next = !ttsEnabled;
	                          setTtsEnabled(next);
	                          if (next && ttsEngine !== "browser") {
	                            void ensureTtsAudio("toggle");
	                          }
	                        }}
	                      >
	                        <input
	                          type="checkbox"
	                          checked={ttsEnabled}
	                          disabled={!activeSessionId || !audioPrefsReady}
	                          data-testid="tts-speak"
	                          onChange={(e) => {
	                            const next = e.target.checked;
	                            setTtsEnabled(next);
	                            if (next && ttsEngine !== "browser") {
	                              void ensureTtsAudio("toggle");
	                            }
	                          }}
		                        />
		                        Speak output
		                      </label>
	                      <div className="audioField">
	                        <span className="audioKey">Source</span>
	                        <select
	                          className="select"
		                          value={ttsSource}
		                          data-testid="tts-source"
		                          onChange={(e) => setTtsSource(e.target.value as "terminal" | "codex")}
		                          disabled={!activeSessionId || !ttsEnabled || !audioPrefsReady}
		                        >
	                          <option value="terminal">terminal</option>
	                          <option value="codex">codex</option>
	                        </select>
	                      </div>
	                      <div className="audioField">
	                        <span className="audioKey">Engine</span>
	                        <select
	                          className="select"
		                          value={ttsEngine}
		                          data-testid="tts-engine"
		                          onChange={(e) => {
		                            const next = e.target.value as "openai" | "piper" | "browser";
		                            setTtsEngine(next);
		                            if (ttsEnabled && next !== "browser") {
		                              void ensureTtsAudio("engine_select");
		                            }
		                          }}
		                          disabled={!activeSessionId || !audioPrefsReady}
		                        >
	                          <option value="openai">openai</option>
	                          <option value="piper">piper</option>
	                          <option value="browser" disabled={!speechSupported}>
	                            browser
	                          </option>
	                        </select>
	                      </div>
	                      <div className="audioField">
	                        <span className="audioKey">Voice</span>
	                        {ttsEngine === "browser" ? (
	                          <select
		                            className="select"
		                            value={ttsBrowserVoice}
		                            onChange={(e) => setTtsBrowserVoice(e.target.value)}
		                            disabled={!activeSessionId || !speechSupported || !audioPrefsReady}
		                          >
	                            {browserVoiceOptions.length === 0 ? (
	                              <option value="">No browser voices</option>
	                            ) : (
	                              browserVoiceOptions.map((voice) => (
	                                <option key={`${voice.name}-${voice.lang}`} value={voice.name}>
	                                  {voice.name} ({voice.lang})
	                                </option>
	                              ))
	                            )}
	                          </select>
	                        ) : (
	                          <input
	                            className="audioInput"
	                            placeholder="coral"
		                            value={ttsVoice}
		                            onChange={(e) => setTtsVoice(e.target.value)}
		                            disabled={!activeSessionId || !audioPrefsReady}
		                          />
		                        )}
	                      </div>
	                      <div className="audioStatus">{ttsStatus}</div>
	                    </div>
                    <div className="audioRow">
                      {ttsEngine !== "browser" && (
                        <label
	                          className="audioToggle"
	                          onClick={(e) => {
	                            if ((e.target as HTMLElement).tagName === "INPUT") return;
	                            if (!activeSessionId || !speechSupported || !audioPrefsReady) return;
	                            e.preventDefault();
	                            setTtsFallbackEnabled((prev) => !prev);
	                          }}
	                        >
	                          <input
	                            type="checkbox"
	                            checked={ttsFallbackEnabled}
	                            disabled={!activeSessionId || !speechSupported || !audioPrefsReady}
	                            data-testid="tts-fallback"
	                            onChange={(e) => setTtsFallbackEnabled(e.target.checked)}
	                          />
                          Browser TTS fallback
                        </label>
                      )}
                      {ttsEngine === "browser" && !speechSupported && (
                        <div className="audioStatus">SpeechSynthesis not supported.</div>
                      )}
                      {!speechSupported && ttsEngine !== "browser" && (
                        <div className="audioStatus">SpeechSynthesis not supported.</div>
                      )}
                      <button
                        type="button"
                        className="button"
                        onClick={() => void testTts()}
                        disabled={!audioPrefsReady || (ttsEngine === "browser" && !speechSupported)}
                      >
                        {ttsEngine === "browser" || (ttsFallbackEnabled && !ttsServerActive)
                          ? "Test browser TTS"
                          : "Test server TTS"}
                      </button>
                      <label className="audioToggle">
                        Volume
                        <input
                          className="audioRange"
                          type="range"
                          min="0"
                          max="1"
	                          step="0.05"
	                          value={ttsVolume}
	                          onChange={(e) => setTtsVolume(Number(e.target.value))}
	                          disabled={!activeSessionId || !audioPrefsReady}
	                        />
                        <span className="audioValue">{Math.round(ttsVolume * 100)}%</span>
                      </label>
                      <label className="audioToggle">
                        Rate
                        <input
                          className="audioRange"
                          type="range"
                          min="0.5"
                          max="2"
	                          step="0.1"
	                          value={ttsRate}
	                          onChange={(e) => setTtsRate(Number(e.target.value))}
	                          disabled={!activeSessionId || !audioPrefsReady}
	                        />
                        <span className="audioValue">{ttsRate.toFixed(1)}x</span>
                      </label>
                    </div>
                  </div>
                  <div className="audioSection">
                    <div className="audioSectionTitle">STT (dictation)</div>
                    <div className="audioRow">
	                      <label
	                        className="audioToggle"
	                        onClick={(e) => {
	                          if ((e.target as HTMLElement).tagName === "INPUT") return;
	                          if (!activeSessionId || !audioPrefsReady) return;
	                          e.preventDefault();
	                          setSttEnabled((prev) => !prev);
	                        }}
	                      >
	                        <input
	                          type="checkbox"
	                          checked={sttEnabled}
	                          disabled={!activeSessionId || !audioPrefsReady}
	                          onChange={(e) => setSttEnabled(e.target.checked)}
	                        />
                        Dictate to terminal
                      </label>
                      <select
	                        className="select"
	                        value={sttEngine}
	                        onChange={(e) => setSttEngine(e.target.value as "cpp" | "openai")}
	                        disabled={!activeSessionId || !audioPrefsReady}
	                      >
                        <option value="cpp">whisper.cpp</option>
                        <option value="openai">openai</option>
                      </select>
                      <input
                        className="audioInput"
	                        placeholder="Model"
	                        value={sttModel}
	                        onChange={(e) => setSttModel(e.target.value)}
	                        disabled={!activeSessionId || !audioPrefsReady}
	                      />
                      <input
                        className="audioInput"
	                        placeholder="Lang (auto)"
	                        value={sttLang}
	                        onChange={(e) => setSttLang(e.target.value)}
	                        disabled={!activeSessionId || !audioPrefsReady}
	                      />
                      <div className="audioStatus">{sttStatus}</div>
                    </div>
                  </div>
                  <div className="audioSection">
                    <div className="audioSectionTitle">Notifications</div>
                    <div className="audioRow">
                      <label
                        className="audioToggle"
                        onClick={(e) => {
                          if ((e.target as HTMLElement).tagName === "INPUT") return;
                          e.preventDefault();
                          setBeepOnCodexDone((prev) => !prev);
                        }}
                      >
	                        <input
	                          type="checkbox"
	                          checked={beepOnCodexDone}
	                          data-testid="notify-beep-codex-done"
	                          onChange={(e) => setBeepOnCodexDone(e.target.checked)}
	                        />
	                        Beep when Codex finishes
	                      </label>
	                      <button
	                        type="button"
	                        className="button"
	                        data-testid="notify-test-beep"
	                        onClick={() => playBeepPreview()}
	                      >
	                        Test beep
	                      </button>
                      <div className="audioStatus">Terminal Codex CLI</div>
                    </div>
                  </div>
                </div>
                <div className="briefPanel">
                  <div className="briefHeader">
                    <div className="briefTitle">Codex brief</div>
                    <div className="briefHint">
                      {!briefPrefsReady ? "Loading…" : briefRunning ? "Generating…" : formatCentsShort(briefLastCost?.totalCents ?? null) || "Ready"}
                    </div>
                  </div>
                  <div className="audioSection">
                    <div className="audioSectionTitle">Run</div>
                    <div className="audioRow">
                      <button type="button" className="button" onClick={() => void runCodexBrief()} disabled={briefRunning}>
                        {briefRunning ? "Briefing…" : "Brief now"}
                      </button>
                      <button
                        type="button"
                        className="button danger"
                        onClick={() => {
                          try {
                            briefAbortRef.current?.abort();
                          } catch {
                            // ignore
                          }
                        }}
                        disabled={!briefRunning}
                        title="Cancels the in-flight request (best-effort)"
                      >
                        Cancel
                      </button>
                      <div className="audioStatus">{briefStatus}</div>
                    </div>
                    {briefLastCost?.note && <div className="audioNotice">{briefLastCost.note}</div>}
                    {briefLastCost && (
                      <div className="briefCost">
                        <span className="briefCostItem">
                          Total: {formatCentsShort(briefLastCost.totalCents ?? null) || "n/a"}
                        </span>
                        <span className="briefCostItem">
                          Responses: {formatCentsShort(briefLastCost.responsesCents ?? null) || "n/a"}
                        </span>
                        <span className="briefCostItem">
                          TTS: {formatCentsShort(briefLastCost.ttsCents ?? null) || "n/a"}
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="audioSection">
                    <div className="audioSectionTitle">Sources</div>
                    <div className="audioRow">
                      <label className="audioToggle">
                        <input
                          type="checkbox"
                          checked={briefPrefs.tmuxEnabled}
                          disabled={!briefPrefsReady}
                          onChange={(e) => setBriefPrefs((prev) => ({ ...prev, tmuxEnabled: e.target.checked }))}
                        />
                        TMUX
                      </label>
                      <label className="audioToggle">
                        <input
                          type="checkbox"
                          checked={briefPrefs.tasksEnabled}
                          disabled={!briefPrefsReady}
                          onChange={(e) => setBriefPrefs((prev) => ({ ...prev, tasksEnabled: e.target.checked }))}
                        />
                        Tasks
                      </label>
                    </div>
                  </div>

                  <div className="audioSection">
                    <div className="audioSectionTitle">TMUX</div>
                    <div className="audioRow">
                      <input
                        className="audioInput"
                        placeholder="Match regex"
                        value={briefPrefs.tmuxMatchRegex}
                        onChange={(e) => setBriefPrefs((prev) => ({ ...prev, tmuxMatchRegex: e.target.value }))}
                        disabled={!briefPrefsReady || !briefPrefs.tmuxEnabled}
                      />
                      <input
                        className="audioInput"
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={25}
                        value={briefPrefs.tmuxMaxSessions}
                        onChange={(e) =>
                          setBriefPrefs((prev) => ({
                            ...prev,
                            tmuxMaxSessions: clampInt(e.target.value, { min: 1, max: 25, fallback: prev.tmuxMaxSessions })
                          }))
                        }
                        disabled={!briefPrefsReady || !briefPrefs.tmuxEnabled}
                        title="Max sessions"
                      />
                      <input
                        className="audioInput"
                        type="number"
                        inputMode="numeric"
                        min={10}
                        max={24 * 60}
                        value={briefPrefs.tmuxRecentMinutes}
                        onChange={(e) =>
                          setBriefPrefs((prev) => ({
                            ...prev,
                            tmuxRecentMinutes: clampInt(e.target.value, {
                              min: 10,
                              max: 24 * 60,
                              fallback: prev.tmuxRecentMinutes
                            })
                          }))
                        }
                        disabled={!briefPrefsReady || !briefPrefs.tmuxEnabled}
                        title="Recent minutes"
                      />
                    </div>
                    <div className="audioNotice">Matches session names; ranks by last activity when available.</div>
                  </div>

                  <div className="audioSection">
                    <div className="audioSectionTitle">Tasks</div>
                    <div className="audioRow">
                      <input
                        className="audioInput"
                        placeholder="Folder (empty=auto)"
                        value={briefPrefs.tasksFolder}
                        onChange={(e) => setBriefPrefs((prev) => ({ ...prev, tasksFolder: e.target.value }))}
                        disabled={!briefPrefsReady || !briefPrefs.tasksEnabled}
                      />
                      <input
                        className="audioInput"
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={60}
                        value={briefPrefs.tasksMaxFiles}
                        onChange={(e) =>
                          setBriefPrefs((prev) => ({
                            ...prev,
                            tasksMaxFiles: clampInt(e.target.value, { min: 1, max: 60, fallback: prev.tasksMaxFiles })
                          }))
                        }
                        disabled={!briefPrefsReady || !briefPrefs.tasksEnabled}
                        title="Max files"
                      />
                      <input
                        className="audioInput"
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={24 * 14}
                        value={briefPrefs.tasksRecentHours}
                        onChange={(e) =>
                          setBriefPrefs((prev) => ({
                            ...prev,
                            tasksRecentHours: clampInt(e.target.value, {
                              min: 1,
                              max: 24 * 14,
                              fallback: prev.tasksRecentHours
                            })
                          }))
                        }
                        disabled={!briefPrefsReady || !briefPrefs.tasksEnabled}
                        title="Recent hours"
                      />
                    </div>
                    <textarea
                      className="briefTextarea"
                      placeholder="Include globs (one per line)"
                      value={(briefPrefs.tasksIncludeGlobs ?? []).join("\n")}
                      onChange={(e) =>
                        setBriefPrefs((prev) => ({
                          ...prev,
                          tasksIncludeGlobs: splitGlobsText(e.target.value).slice(0, 20)
                        }))
                      }
                      disabled={!briefPrefsReady || !briefPrefs.tasksEnabled}
                    />
                    <textarea
                      className="briefTextarea"
                      placeholder="Exclude globs (one per line)"
                      value={(briefPrefs.tasksExcludeGlobs ?? []).join("\n")}
                      onChange={(e) =>
                        setBriefPrefs((prev) => ({
                          ...prev,
                          tasksExcludeGlobs: splitGlobsText(e.target.value).slice(0, 40)
                        }))
                      }
                      disabled={!briefPrefsReady || !briefPrefs.tasksEnabled}
                    />
                  </div>

                  <div className="audioSection">
                    <div className="audioSectionTitle">OpenAI</div>
                    <div className="audioRow">
                      <input
                        className="audioInput"
                        placeholder="Responses model"
                        value={briefPrefs.openAiModel}
                        onChange={(e) => setBriefPrefs((prev) => ({ ...prev, openAiModel: e.target.value }))}
                        disabled={!briefPrefsReady}
                      />
                      <input
                        className="audioInput"
                        placeholder="TTS model"
                        value={briefPrefs.ttsModel}
                        onChange={(e) => setBriefPrefs((prev) => ({ ...prev, ttsModel: e.target.value }))}
                        disabled={!briefPrefsReady}
                      />
                      <input
                        className="audioInput"
                        placeholder="Voice"
                        value={briefPrefs.voice}
                        onChange={(e) => setBriefPrefs((prev) => ({ ...prev, voice: e.target.value }))}
                        disabled={!briefPrefsReady}
                      />
                      <input
                        className="audioInput"
                        type="number"
                        inputMode="numeric"
                        min={10}
                        max={180}
                        value={briefPrefs.spokenSeconds}
                        onChange={(e) =>
                          setBriefPrefs((prev) => ({
                            ...prev,
                            spokenSeconds: clampInt(e.target.value, { min: 10, max: 180, fallback: prev.spokenSeconds })
                          }))
                        }
                        disabled={!briefPrefsReady}
                        title="Spoken seconds"
                      />
                    </div>
                  </div>

                  <div className="audioSection">
                    <div className="audioSectionTitle">Privacy</div>
                    <div className="audioRow">
                      <label className="audioToggle">
                        <input
                          type="checkbox"
                          checked={briefPrefs.redactPaths}
                          disabled={!briefPrefsReady}
                          onChange={(e) => setBriefPrefs((prev) => ({ ...prev, redactPaths: e.target.checked }))}
                        />
                        Redact paths
                      </label>
                      <input
                        className="audioInput"
                        type="number"
                        inputMode="numeric"
                        min={200}
                        max={20_000}
                        value={briefPrefs.maxCharsPerFile}
                        onChange={(e) =>
                          setBriefPrefs((prev) => ({
                            ...prev,
                            maxCharsPerFile: clampInt(e.target.value, {
                              min: 200,
                              max: 20_000,
                              fallback: prev.maxCharsPerFile
                            })
                          }))
                        }
                        disabled={!briefPrefsReady}
                        title="Max chars/file"
                      />
                    </div>
                  </div>

                  {briefLastReportJson && (
                    <div className="audioSection">
                      <div className="audioSectionTitle">Last report</div>
                      <pre className="briefReport">{briefLastReportJson}</pre>
                      {briefLastSpokenScript && (
                        <div className="audioNotice" title={briefLastSpokenScript}>
                          Spoken: {briefLastSpokenScript}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div className="debugPanel">
                  <div className="debugHeader">
                    <div className="debugTitle">Client log</div>
                    <div className="debugActions">
                      <button className="button" onClick={copyClientLog}>
                        Copy
                      </button>
                      <button className="button danger" onClick={clearClientLog}>
                        Clear
                      </button>
                    </div>
                  </div>
                  <pre className="debugLog">{clientLogText || "No logs yet."}</pre>
                </div>
              </div>
            </div>
          </div>
        )}
        <div className={`terminalWrap${codexActive ? " codexRunning" : ""}`} ref={terminalWrapRef}>
          {controlsHidden && (
            <button
              type="button"
              className={`compactToggle${compactDragging ? " dragging" : ""}`}
              data-dock={compactDock}
              aria-label="Show controls"
              title="Show controls"
              onClick={handleCompactClick}
              onPointerDown={handleCompactPointerDown}
              onPointerMove={handleCompactPointerMove}
              onPointerUp={handleCompactPointerUp}
              onPointerCancel={handleCompactPointerUp}
            >
              <span className="compactToggleIcon" aria-hidden="true">
                <svg viewBox="0 0 24 24" role="img" focusable="false">
                  <path
                    d="M4 7h9"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                  <circle cx="16.5" cy="7" r="2.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
                  <path
                    d="M4 12h5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                  <circle cx="12.5" cy="12" r="2.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
                  <path
                    d="M4 17h11"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                  <circle cx="19.5" cy="17" r="2.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
                </svg>
              </span>
              <span className="compactToggleLabel">Show controls</span>
            </button>
          )}
          <button
            type="button"
            className="uploadFab"
            onClick={onUploadClick}
            disabled={uploading}
            title="Upload image"
            aria-label="Upload image"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M7 6.5a3.5 3.5 0 0 1 6.64-1.58A4.5 4.5 0 0 1 18.5 9a3.5 3.5 0 0 1-.5 6.96H7.5a3.5 3.5 0 0 1-.5-6.96V6.5Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <path
                d="M12 9v6m0 0-2.5-2.5M12 15l2.5-2.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <TerminalView
            ref={terminalRef}
            conn={conn}
            onDisconnect={onDisconnect}
            onSocketEvent={handleSocketEvent}
            onOutput={handleTerminalOutput}
            onSwipe={handleSwipe}
            onTitleChange={(title) => {
              if (!currentKey) return;
              const patch: Partial<SessionMeta> = { lastTitle: title || undefined };
              const cwdCandidate = normalizeCwdCandidate(title);
              if (cwdCandidate) {
                patch.lastCwd = cwdCandidate;
                saveLastCwd(cwdCandidate);
              }
              updateSessionMeta(currentKey, patch);
            }}
            onCwdChange={(raw) => {
              if (!currentKey) return;
              const cwdCandidate = normalizeCwdCandidate(raw);
              if (!cwdCandidate) return;
              updateSessionMeta(currentKey, { lastCwd: cwdCandidate });
              saveLastCwd(cwdCandidate);
            }}
            onCodexSignal={handleCodexSignal}
          />
          {disconnectDialogOpen && (
            <div className="overlay" onClick={() => setDisconnectDialogOpen(false)}>
              <div
                className="card"
                role="dialog"
                aria-modal="true"
                aria-label="Disconnect"
                onClick={(event) => event.stopPropagation()}
              >
                <h2>Disconnect</h2>
                <p>Disconnect ends this web session (detaches). Your tmux session on the server stays alive.</p>
                <div className="row">
                  <button
                    className="button"
                    onClick={() => {
                      setDisconnectDialogOpen(false);
                      onDetachCurrent();
                    }}
                  >
                    Disconnect
                  </button>
                  <button
                    className="button danger"
                    onClick={() => {
                      setDisconnectDialogOpen(false);
                      onDeleteCurrent();
                    }}
                  >
                    Delete
                  </button>
                  <button className="button" onClick={() => setDisconnectDialogOpen(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}
        {conn.status === "disconnected" && !creatingSession && (
          <div className="overlay">
            <div className="card">
              <h2>Disconnected</h2>
                <p>Reconnect reattaches to the existing PTY session (if still alive). Delete kills the session.</p>
                <div className="row">
                  <button className="button" onClick={onReattach}>
                    Reconnect
                  </button>
                  <button className="button danger" onClick={onDeleteCurrent}>
                    Delete
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
        <input ref={uploadInputRef} type="file" accept="image/*" multiple hidden onChange={onUploadChange} />
      </div>
    </div>
  );
}
