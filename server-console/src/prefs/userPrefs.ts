import fs from "node:fs";
import path from "node:path";

export type AudioPrefs = {
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

export type BriefPrefs = {
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

type UserPrefs = {
  audio?: Partial<AudioPrefs>;
  brief?: Partial<BriefPrefs>;
  updatedAt?: string;
};

type UserPrefsStoreData = {
  version: 1;
  users: Record<string, UserPrefs>;
};

const DEFAULT_DATA: UserPrefsStoreData = { version: 1, users: {} };

function safeParse(content: string): UserPrefsStoreData {
  if (!content) return { ...DEFAULT_DATA };
  try {
    const parsed = JSON.parse(content) as UserPrefsStoreData;
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_DATA };
    if (parsed.version !== 1 || typeof parsed.users !== "object" || !parsed.users) {
      return { ...DEFAULT_DATA };
    }
    return parsed;
  } catch {
    return { ...DEFAULT_DATA };
  }
}

export class UserPrefsStore {
  private readonly filePath: string;
  private data: UserPrefsStoreData;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = this.load();
  }

  getAudio(userId: string): Partial<AudioPrefs> | null {
    const entry = this.data.users[userId];
    return entry?.audio ?? null;
  }

  updateAudio(userId: string, patch: Partial<AudioPrefs>): Partial<AudioPrefs> {
    const current = this.data.users[userId]?.audio ?? {};
    const next = { ...current, ...patch };
    this.data.users[userId] = {
      ...this.data.users[userId],
      audio: next,
      updatedAt: new Date().toISOString()
    };
    this.persist();
    return next;
  }

  getBrief(userId: string): Partial<BriefPrefs> | null {
    const entry = this.data.users[userId];
    return entry?.brief ?? null;
  }

  updateBrief(userId: string, patch: Partial<BriefPrefs>): Partial<BriefPrefs> {
    const current = this.data.users[userId]?.brief ?? {};
    const next = { ...current, ...patch };
    this.data.users[userId] = {
      ...this.data.users[userId],
      brief: next,
      updatedAt: new Date().toISOString()
    };
    this.persist();
    return next;
  }

  private load(): UserPrefsStoreData {
    try {
      if (!fs.existsSync(this.filePath)) return { ...DEFAULT_DATA };
      const content = fs.readFileSync(this.filePath, "utf8");
      return safeParse(content);
    } catch {
      return { ...DEFAULT_DATA };
    }
  }

  private persist() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    const payload = JSON.stringify(this.data, null, 2);
    fs.writeFileSync(tmpPath, payload, "utf8");
    fs.renameSync(tmpPath, this.filePath);
  }
}
