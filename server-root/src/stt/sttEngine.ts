export type SttRequest = {
  model: string;
  language: string;
  sampleRate: number;
};

export interface SttEngine {
  transcribe(audio: Buffer, req: SttRequest, signal?: AbortSignal): Promise<string>;
}
