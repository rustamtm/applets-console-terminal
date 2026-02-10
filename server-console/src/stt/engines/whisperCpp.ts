import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import type { SttEngine, SttRequest } from "../sttEngine.js";
import { pcm16ToWav } from "../wav.js";

export type WhisperCppEngineOptions = {
  binPath: string;
  modelPath: string;
};

const execFileAsync = promisify(execFile);

const resolveModelPathSync = (requested: string | undefined, fallback: string) => {
  const candidates: string[] = [];
  if (requested) {
    const cleaned = requested.replace(/\.bin$/i, "").replace(/\.gguf$/i, "");
    const variants = [cleaned];
    if (!cleaned.startsWith("ggml-")) variants.push(`ggml-${cleaned}`);
    for (const variant of variants) {
      candidates.push(
        variant,
        `${variant}.bin`,
        `${variant}.gguf`,
        path.resolve(process.cwd(), "transcribe/whisper_cpp/models", `${variant}.bin`),
        path.resolve(process.cwd(), "transcribe/whisper_cpp/models", `${variant}.gguf`),
        path.resolve(path.dirname(fallback), `${variant}.bin`),
        path.resolve(path.dirname(fallback), `${variant}.gguf`)
      );
    }
  }
  candidates.push(fallback);
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const stat = fsSync.statSync(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // ignore
    }
  }
  return undefined;
};

export class WhisperCppEngine implements SttEngine {
  private readonly binPath: string;
  private readonly modelPath: string;

  constructor(opts: WhisperCppEngineOptions) {
    this.binPath = opts.binPath;
    this.modelPath = opts.modelPath;
  }

  async transcribe(audio: Buffer, req: SttRequest, signal?: AbortSignal): Promise<string> {
    if (!fsSync.existsSync(this.binPath)) {
      throw new Error(`whisper.cpp binary not found at ${this.binPath}`);
    }
    const modelPath = resolveModelPathSync(req.model, this.modelPath);
    if (!modelPath) {
      throw new Error("whisper.cpp model not found");
    }
    const wav = pcm16ToWav(audio, req.sampleRate, 1);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "console-stt-"));
    const wavPath = path.join(tmpDir, "input.wav");
    await fs.writeFile(wavPath, wav);
    try {
      const args = [
        "-m",
        modelPath,
        "-f",
        wavPath,
        "-l",
        req.language || "auto",
        "--no-timestamps",
        "--print-progress",
        "false",
        "--temperature",
        "0",
        "--max-context",
        "0",
        "--entropy-thold",
        "2.4",
        "--logprob-thold",
        "-1.0"
      ];
      const { stdout, stderr } = await execFileAsync(this.binPath, args, { signal });
      if (stderr && stderr.toString().trim()) {
        // whisper-cli can be noisy; don't treat stderr as fatal unless process fails
      }
      const out = stdout.toString().trim();
      if (!out) return "";
      const lines = out.split("\n").map((line) => line.trim()).filter(Boolean);
      return lines.at(-1) ?? "";
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }
}
