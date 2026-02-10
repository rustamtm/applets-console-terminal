import { execFile } from "node:child_process";

type CaptureOptions = {
  lines?: number;
  timeoutMs?: number;
  maxChars?: number;
};

function execFileText(
  file: string,
  args: string[],
  opts: { timeoutMs: number; maxBufferBytes: number }
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: opts.timeoutMs, maxBuffer: opts.maxBufferBytes, encoding: "utf8" },
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

async function getActivePaneId(tmuxName: string, timeoutMs: number): Promise<string | null> {
  const out = await execFileText("tmux", ["list-panes", "-t", tmuxName, "-F", "#{pane_active} #{pane_id}"], {
    timeoutMs,
    maxBufferBytes: 256 * 1024
  });
  const lines = out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;

  let firstPane: string | null = null;
  for (const line of lines) {
    const parts = line.split(/\s+/g);
    if (parts.length < 2) continue;
    const active = parts[0];
    const paneId = parts[1];
    if (!firstPane) firstPane = paneId;
    if (active === "1") return paneId;
  }
  return firstPane;
}

export async function captureTmuxTail(tmuxName: string, options?: CaptureOptions): Promise<string> {
  const lines = typeof options?.lines === "number" ? Math.max(20, Math.min(4000, options.lines)) : 800;
  const timeoutMs = typeof options?.timeoutMs === "number" ? Math.max(50, options.timeoutMs) : 650;
  const maxChars = typeof options?.maxChars === "number" ? Math.max(100, options.maxChars) : 12_000;

  const paneId = await getActivePaneId(tmuxName, timeoutMs);
  if (!paneId) return "";

  const out = await execFileText(
    "tmux",
    // -J joins wrapped lines for more readable context.
    ["capture-pane", "-p", "-J", "-S", `-${lines}`, "-t", paneId],
    { timeoutMs, maxBufferBytes: 2 * 1024 * 1024 }
  );

  const normalized = String(out ?? "").replace(/\r/g, "\n").trim();
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(-maxChars);
}

