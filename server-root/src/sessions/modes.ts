import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ModeName = "node" | "shell" | "readonly_tail" | "tmux";

export type SpawnSpec = {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
};

export type ModeConfig = {
  enableNode: boolean;
  enableShell: boolean;
  enableReadonlyTail: boolean;
  enableTmux: boolean;
  defaultShell: string;
  defaultCwd: string;
};

export type CreateSessionRequest = {
  mode: ModeName;
  cwd?: string;
  readonlyPath?: string;
  tmuxName?: string;
  cols?: number;
  rows?: number;
  resumeKey?: string;
  initialSnapshot?: string;
};

const SAFE_CWD_FALLBACK = "/tmp";

function sanitizeCwd(cwd: string): string {
  return cwd && path.isAbsolute(cwd) ? path.resolve(cwd) : SAFE_CWD_FALLBACK;
}

function expandHome(raw: string, homeDir: string): string {
  if (!raw.startsWith("~")) return raw;
  if (!homeDir) return raw;
  if (raw === "~") return homeDir;
  if (raw.startsWith("~/")) return path.join(homeDir, raw.slice(2));
  return raw;
}

function resolveCwd(defaultCwd: string, requested?: string): string {
  const base = sanitizeCwd(defaultCwd);
  if (!requested) return base;

  const raw = String(requested).trim();
  if (!raw) return base;

  const homeDir = os.homedir?.() ?? process.env.HOME ?? "";
  const expanded = expandHome(raw, homeDir);
  const resolved = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(base, expanded);
  const cwd = sanitizeCwd(resolved);

  try {
    const stat = fs.statSync(cwd);
    if (!stat.isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error("cwd must be an existing directory");
  }

  return cwd;
}

export function resolveSpawnSpec(cfg: ModeConfig, req: CreateSessionRequest): SpawnSpec {
  const cwd = resolveCwd(cfg.defaultCwd, req.cwd);
  const env = { ...process.env } as Record<string, string>;

  if (req.mode === "node") {
    if (!cfg.enableNode) throw new Error("Mode disabled: node");
    return { file: "node", args: [], cwd, env };
  }

  if (req.mode === "shell") {
    if (!cfg.enableShell) throw new Error("Mode disabled: shell");
    return { file: cfg.defaultShell, args: ["-l"], cwd, env };
  }

  if (req.mode === "readonly_tail") {
    if (!cfg.enableReadonlyTail) throw new Error("Mode disabled: readonly_tail");
    if (!req.readonlyPath) throw new Error("readonly_tail requires readonlyPath");
    if (!path.isAbsolute(req.readonlyPath)) throw new Error("readonlyPath must be absolute");
    return { file: "tail", args: ["-n", "200", "-f", "--", req.readonlyPath], cwd, env };
  }

  if (req.mode === "tmux") {
    if (!cfg.enableTmux) throw new Error("Mode disabled: tmux");
    if (!req.tmuxName) throw new Error("tmux requires tmuxName");
    if (!/^[A-Za-z0-9._-]+$/.test(req.tmuxName)) throw new Error("tmuxName must be alphanumeric");
    return { file: "tmux", args: ["new-session", "-A", "-s", req.tmuxName, "-c", cwd], cwd, env };
  }

  throw new Error(`Unknown mode: ${(req as any).mode}`);
}
