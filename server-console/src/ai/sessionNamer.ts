import crypto from "node:crypto";

export type OpenAiChatConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
};

export type SessionNameInputs = {
  mode?: string;
  tmuxName?: string;
  cwd?: string;
  lastCwd?: string;
  lastTitle?: string;
  outputTail?: string;
  codexPrompt?: string;
  codexLogTail?: string;
  codexModel?: string;
  recentNames?: string[];
};

const SUGGESTED_NAME_MAX_CHARS = 96;
const OUTPUT_TAIL_MAX_CHARS = 4_000;
const CODEX_PROMPT_MAX_CHARS = 2_000;

function clampString(value: unknown, max: number): string {
  const s = String(value ?? "").trim();
  if (!s) return "";
  if (s.length <= max) return s;
  return s.slice(0, max);
}

function clampTail(value: unknown, max: number): string {
  const s = String(value ?? "").trim();
  if (!s) return "";
  if (s.length <= max) return s;
  return s.slice(-max);
}

function derivePathHint(cwdLike: string): string {
  const cleaned = String(cwdLike ?? "").trim();
  if (!cleaned) return "";
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length === 0) return "";
  const idx = parts.lastIndexOf("applets");
  const rel = idx !== -1 ? parts.slice(idx + 1, idx + 3) : parts.slice(-2);
  return rel.join("/");
}

function uniqKeepOrder(values: string[], max = 12): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const v = String(raw ?? "").trim();
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

function redactSecrets(input: string): string {
  let out = input;
  // Very rough redactions; keep this conservative (avoid false positives exploding output).
  out = out.replace(/\bsk-[A-Za-z0-9]{20,}\b/g, "sk-REDACTED");
  out = out.replace(/\b(OPENAI_API_KEY|CONSOLE_APP_TOKEN|CF_ACCESS_CLIENT_SECRET)\s*=\s*\S+/g, "$1=REDACTED");
  out = out.replace(/\bAuthorization:\s*Bearer\s+\S+/gi, "Authorization: Bearer REDACTED");
  return out;
}

function normalizeSuggestedName(raw: string): string {
  let name = String(raw ?? "").trim();
  name = name.replace(/^[`"']+|[`"']+$/g, "").trim();
  name = name.replace(/\s+/g, " ").trim();
  // Keep it short and filename-ish (UI labels).
  if (name.length > SUGGESTED_NAME_MAX_CHARS) name = name.slice(0, SUGGESTED_NAME_MAX_CHARS).trim();
  name = name.replace(/[:\-\s]+$/g, "").trim();
  return name;
}

async function postChatCompletion(
  cfg: OpenAiChatConfig,
  payload: Record<string, unknown>,
  signal?: AbortSignal
): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1_000, cfg.timeoutMs));
  const combined = signal
    ? (AbortSignal as any).any
      ? (AbortSignal as any).any([signal, controller.signal])
      : controller.signal
    : controller.signal;

  try {
    const response = await fetch(`${cfg.baseUrl.replace(/\/+$/g, "")}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: combined
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`OpenAI chat failed (${response.status}): ${errText || response.statusText}`);
    }

    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function suggestSessionName(
  inputs: SessionNameInputs,
  cfg: OpenAiChatConfig,
  signal?: AbortSignal
): Promise<{ name: string; requestId: string }> {
  const mode = clampString(inputs.mode, 40);
  const tmuxName = clampString(inputs.tmuxName, 140);
  const cwd = clampString(inputs.cwd, 300);
  const lastCwd = clampString(inputs.lastCwd, 300);
  const lastTitle = clampString(inputs.lastTitle, 300);
  const outputTail = clampTail(redactSecrets(clampTail(inputs.outputTail, OUTPUT_TAIL_MAX_CHARS)), OUTPUT_TAIL_MAX_CHARS);
  const codexPrompt = clampString(redactSecrets(clampString(inputs.codexPrompt, CODEX_PROMPT_MAX_CHARS)), CODEX_PROMPT_MAX_CHARS);
  const codexLogTail = clampTail(
    redactSecrets(clampTail(inputs.codexLogTail, OUTPUT_TAIL_MAX_CHARS)),
    OUTPUT_TAIL_MAX_CHARS
  );
  const codexModel = clampString(inputs.codexModel, 80);
  const recentNames = uniqKeepOrder(inputs.recentNames ?? [], 10);
  const pathHint = derivePathHint(lastCwd || cwd);

  const requestId = crypto.randomBytes(8).toString("hex");

  const system =
    "You generate short session names for a terminal tab. " +
    `Return a single concise label (4-10 words, <= ${SUGGESTED_NAME_MAX_CHARS} chars), plain text only. ` +
    "No quotes, no markdown, no emojis. " +
    "Be specific. Prefer Codex prompt/output when provided. Use only the provided signals (do not guess). " +
    "Avoid usernames/hosts, full absolute paths, secrets, long hashes/ids, and timestamps. " +
    "Prefer a stable format like '<area>: <task>'.";

  const user = [
    "Context signals:",
    mode ? `- mode: ${mode}` : null,
    tmuxName ? `- tmux: ${tmuxName}` : null,
    pathHint ? `- path hint: ${pathHint}` : null,
    lastCwd ? `- cwd: ${lastCwd}` : cwd ? `- cwd: ${cwd}` : null,
    lastTitle ? `- title: ${lastTitle}` : null,
    codexModel ? `- codex model: ${codexModel}` : null,
    codexPrompt ? `- codex prompt:\n${codexPrompt}` : null,
    codexLogTail ? `- codex tail:\n${codexLogTail}` : null,
    recentNames.length ? `- recent session names: ${recentNames.join(" | ")}` : null,
    outputTail ? `- terminal tail:\n${outputTail}` : null
  ]
    .filter(Boolean)
    .join("\n");

  const json = await postChatCompletion(
    cfg,
    {
      model: cfg.model,
      temperature: 0.2,
      max_tokens: 36,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    },
    signal
  );

  const content = String(json?.choices?.[0]?.message?.content ?? "").trim();
  const name = normalizeSuggestedName(content);
  if (!name) {
    throw new Error("OpenAI returned an empty name");
  }

  return { name, requestId };
}
