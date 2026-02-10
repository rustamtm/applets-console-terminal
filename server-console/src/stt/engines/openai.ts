import type { SttEngine, SttRequest } from "../sttEngine.js";
import { pcm16ToWav } from "../wav.js";

export type OpenAiSttEngineOptions = {
  apiKey: string;
  baseUrl: string;
};

export class OpenAiSttEngine implements SttEngine {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: OpenAiSttEngineOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/+$/g, "");
  }

  async transcribe(audio: Buffer, req: SttRequest, signal?: AbortSignal): Promise<string> {
    const wav = pcm16ToWav(audio, req.sampleRate, 1);
    const form = new (globalThis as any).FormData();
    form.set("model", req.model);
    if (req.language && req.language !== "auto") {
      form.set("language", req.language);
    }
    const blob = new (globalThis as any).Blob([wav], { type: "audio/wav" });
    form.set("file", blob, "audio.wav");

    const response = await fetch(`${this.baseUrl}/v1/audio/transcriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`
      },
      body: form,
      signal
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`OpenAI STT failed (${response.status}): ${errText || response.statusText}`);
    }

    const json = (await response.json()) as { text?: string };
    return (json?.text ?? "").trim();
  }
}
