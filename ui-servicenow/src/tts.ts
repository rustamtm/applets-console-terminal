export type TtsFormat = {
  format: "pcm16";
  sampleRate: number;
  channels: number;
};

export class PcmPlayer {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private nextTime = 0;
  private sampleRate = 24_000;
  private volume = 1;
  private rate = 1;

  getState(): AudioContextState | null {
    return this.ctx ? this.ctx.state : null;
  }

  setFormat(format: TtsFormat) {
    if (format.sampleRate && format.sampleRate !== this.sampleRate) {
      this.sampleRate = format.sampleRate;
      this.resetContext();
    }
  }

  setVolume(volume: number) {
    const next = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
    this.volume = next;
    if (this.gain) {
      this.gain.gain.value = next;
    }
  }

  setRate(rate: number) {
    const next = Number.isFinite(rate) ? Math.max(0.5, Math.min(2, rate)) : 1;
    this.rate = next;
  }

  async resume() {
    this.ensureContext();
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
  }

  enqueuePCM16(buffer: ArrayBuffer) {
    if (!buffer) return;
    this.ensureContext();
    const ctx = this.ctx;
    if (!ctx) return;
    const int16 = new Int16Array(buffer);
    if (!int16.length) return;
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i += 1) {
      float32[i] = int16[i] / 0x7fff;
    }
    const audioBuffer = ctx.createBuffer(1, float32.length, ctx.sampleRate);
    audioBuffer.copyToChannel(float32, 0);
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.playbackRate.value = this.rate;
    if (this.gain) {
      source.connect(this.gain);
    } else {
      source.connect(ctx.destination);
    }
    const now = ctx.currentTime;
    if (this.nextTime < now) {
      this.nextTime = now + 0.02;
    }
    if (this.nextTime - now > 2) {
      this.nextTime = now + 0.02;
    }
    source.start(this.nextTime);
    const duration = audioBuffer.duration / this.rate;
    this.nextTime += duration;
  }

  stop() {
    if (this.ctx) {
      this.ctx.close().catch(() => undefined);
      this.ctx = null;
    }
    this.gain = null;
    this.nextTime = 0;
  }

  private resetContext() {
    if (this.ctx) {
      this.ctx.close().catch(() => undefined);
      this.ctx = null;
    }
    this.gain = null;
    this.nextTime = 0;
  }

  private ensureContext() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: this.sampleRate });
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.ctx.destination);
    }
  }
}
