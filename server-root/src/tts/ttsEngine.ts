export type TtsSynthesisConfig = {
  model: string;
  voice: string;
  format: "pcm";
};

export type TtsChunkHandler = (chunk: Buffer) => void;

export interface TtsEngine {
  getSampleRate?: (cfg: TtsSynthesisConfig) => number;
  synthesize(
    text: string,
    cfg: TtsSynthesisConfig,
    onChunk: TtsChunkHandler,
    signal?: AbortSignal
  ): Promise<void>;
}

export const DEFAULT_TTS_SAMPLE_RATE = 24_000;
