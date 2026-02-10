import { Readable } from "node:stream";
import type { TtsEngine, TtsSynthesisConfig } from "../ttsEngine.js";

export type OpenAiEngineOptions = {
  apiKey: string;
  baseUrl: string;
};

export class OpenAiTtsEngine implements TtsEngine {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: OpenAiEngineOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/+$/g, "");
  }

  getSampleRate() {
    return 24_000;
  }

  async synthesize(
    text: string,
    cfg: TtsSynthesisConfig,
    onChunk: (chunk: Buffer) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const response = await fetch(`${this.baseUrl}/v1/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: cfg.model,
        voice: cfg.voice,
        input: text,
        response_format: cfg.format
      }),
      signal
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`OpenAI TTS failed (${response.status}): ${errText || response.statusText}`);
    }

    const body = response.body;
    if (!body) return;

    const stream =
      typeof (body as any).getReader === "function" ? Readable.fromWeb(body as any) : (body as any);

    for await (const chunk of stream) {
      if (signal?.aborted) break;
      if (!chunk) continue;
      onChunk(Buffer.from(chunk as Uint8Array));
    }
  }
}
