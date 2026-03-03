export class SttRecorder {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private gain: GainNode | null = null;
  private readonly onChunk: (buffer: ArrayBuffer) => void;
  private pcmQueue: Int16Array[] = [];
  private flushTimer: number | null = null;
  private startPromise: Promise<void> | null = null;
  private stopRequested = false;
  private readonly targetSamples = 16_000;

  constructor(onChunk: (buffer: ArrayBuffer) => void) {
    this.onChunk = onChunk;
  }

  async start() {
    if (this.ctx) return;
    if (this.startPromise) return this.startPromise;
    this.stopRequested = false;
    const constraints: MediaStreamConstraints = {
      audio: {
        noiseSuppression: true,
        autoGainControl: true,
        echoCancellation: true,
        channelCount: 1
      }
    };
    this.startPromise = (async () => {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.stream = stream;
      if (this.stopRequested) {
        this.stop();
        return;
      }

      const ctx = new AudioContext({ sampleRate: 48000 });
      this.ctx = ctx;
      try {
        await ctx.audioWorklet.addModule(new URL("./pcm-worklet.js", import.meta.url));
      } catch (err) {
        if (this.stopRequested) {
          this.stop();
          return;
        }
        this.stop();
        throw err;
      }

      if (this.stopRequested) {
        this.stop();
        return;
      }

      this.node = new AudioWorkletNode(ctx, "pcm-worklet");
      this.node.port.onmessage = (event) => {
        const data = event.data;
        if (data instanceof ArrayBuffer) {
          this.pcmQueue.push(new Int16Array(data));
        }
      };

      if (this.stopRequested) {
        this.stop();
        return;
      }

      this.source = ctx.createMediaStreamSource(stream);
      this.gain = ctx.createGain();
      this.gain.gain.value = 0;
      this.source.connect(this.node);
      this.node.connect(this.gain);
      this.gain.connect(ctx.destination);
      this.flushTimer = window.setInterval(() => this.flush(false), 250);
      if (ctx.state === "suspended") {
        await ctx.resume();
      }
    })();

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  stop() {
    this.stopRequested = true;
    this.flush(true);
    if (this.flushTimer) {
      window.clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      this.node?.disconnect();
      this.gain?.disconnect();
      this.source?.disconnect();
    } catch {
      // ignore
    }
    this.node = null;
    this.source = null;
    this.pcmQueue = [];
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.ctx) {
      this.ctx.close().catch(() => undefined);
      this.ctx = null;
    }
  }

  private flush(force: boolean) {
    if (!this.pcmQueue.length) return;
    const totalSamples = this.pcmQueue.reduce((sum, chunk) => sum + chunk.length, 0);
    if (!force && totalSamples < this.targetSamples) return;
    const merged = new Int16Array(totalSamples);
    let offset = 0;
    for (const chunk of this.pcmQueue) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.pcmQueue = [];
    this.onChunk(merged.buffer);
  }
}
