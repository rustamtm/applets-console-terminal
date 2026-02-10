import type { TtsEngine, TtsSynthesisConfig } from "./ttsEngine.js";

export type TtsQueueOptions = {
  maxDepth: number;
  onError?: (err: Error) => void;
};

export class TtsQueue {
  private readonly engine: TtsEngine;
  private readonly onAudio: (chunk: Buffer) => void;
  private readonly opts: TtsQueueOptions;
  private chain: Promise<void> = Promise.resolve();
  private depth = 0;
  private generation = 0;
  private currentAbort?: AbortController;

  constructor(engine: TtsEngine, onAudio: (chunk: Buffer) => void, opts: TtsQueueOptions) {
    this.engine = engine;
    this.onAudio = onAudio;
    this.opts = opts;
  }

  enqueue(text: string, cfg: TtsSynthesisConfig): boolean {
    if (!text) return true;
    if (this.depth >= this.opts.maxDepth) return false;
    this.depth += 1;
    const gen = this.generation;
    this.chain = this.chain.then(async () => {
      this.depth = Math.max(0, this.depth - 1);
      const controller = new AbortController();
      this.currentAbort = controller;
      try {
        await this.engine.synthesize(
          text,
          cfg,
          (chunk) => {
            if (this.generation !== gen) return;
            this.onAudio(chunk);
          },
          controller.signal
        );
      } catch (err) {
        if (controller.signal.aborted) return;
        const error = err instanceof Error ? err : new Error("tts synth failed");
        this.opts.onError?.(error);
      } finally {
        if (this.currentAbort === controller) this.currentAbort = undefined;
      }
    });
    return true;
  }

  clear() {
    this.generation += 1;
    this.depth = 0;
    if (this.currentAbort) {
      this.currentAbort.abort();
      this.currentAbort = undefined;
    }
  }
}
