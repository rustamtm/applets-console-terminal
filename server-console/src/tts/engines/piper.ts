import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { TtsEngine, TtsSynthesisConfig } from "../ttsEngine.js";

export type PiperEngineOptions = {
  binPath: string;
  modelPath: string;
  configPath?: string;
  sampleRate?: number;
};

const readJson = (file: string) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

const resolveConfigPath = (modelPath: string, configPath?: string) => {
  if (configPath) return configPath;
  const direct = `${modelPath}.json`;
  if (fs.existsSync(direct)) return direct;
  const alt = modelPath.replace(/\.onnx$/i, ".onnx.json");
  if (fs.existsSync(alt)) return alt;
  return undefined;
};

const resolveSampleRate = (modelPath: string, configPath?: string, fallback = 22_050) => {
  const cfgPath = resolveConfigPath(modelPath, configPath);
  if (!cfgPath) return fallback;
  const cfg = readJson(cfgPath);
  const rate =
    cfg?.audio?.sample_rate ??
    cfg?.audio?.sampleRate ??
    cfg?.sample_rate ??
    cfg?.sampleRate;
  const parsed = Number(rate);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export class PiperTtsEngine implements TtsEngine {
  private readonly binPath: string;
  private readonly modelPath: string;
  private readonly sampleRate: number;

  constructor(opts: PiperEngineOptions) {
    this.binPath = opts.binPath;
    this.modelPath = opts.modelPath;
    this.sampleRate = opts.sampleRate ?? resolveSampleRate(opts.modelPath, opts.configPath);
  }

  getSampleRate() {
    return this.sampleRate;
  }

  async synthesize(
    text: string,
    _cfg: TtsSynthesisConfig,
    onChunk: (chunk: Buffer) => void,
    signal?: AbortSignal
  ): Promise<void> {
    if (!text.trim()) return;
    if (!fs.existsSync(this.binPath)) {
      throw new Error(`piper binary not found at ${this.binPath}`);
    }
    if (!fs.existsSync(this.modelPath)) {
      throw new Error(`piper model not found at ${this.modelPath}`);
    }
    const child = spawn(this.binPath, ["--model", this.modelPath, "--output-raw"], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    const killChild = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    };

    if (signal) {
      if (signal.aborted) killChild();
      signal.addEventListener("abort", killChild, { once: true });
    }

    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.stdout?.on("data", (chunk) => {
      onChunk(Buffer.from(chunk as Buffer));
    });

    child.stdin?.write(text.trim() + "\n");
    child.stdin?.end();

    await new Promise<void>((resolve, reject) => {
      child.on("error", (err) => reject(err));
      child.on("close", (code) => {
        if (signal?.aborted) return resolve();
        if (code && code !== 0) {
          return reject(new Error(`piper failed (${code}): ${stderr.trim() || "unknown error"}`));
        }
        resolve();
      });
    });
  }
}
