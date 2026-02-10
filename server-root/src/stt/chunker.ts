export class AudioChunker {
  private buffer = Buffer.alloc(0);
  private readonly windowBytes: number;
  private readonly overlapBytes: number;

  constructor(windowBytes: number, overlapBytes: number) {
    this.windowBytes = Math.max(0, windowBytes);
    this.overlapBytes = Math.max(0, overlapBytes);
  }

  push(chunk: Buffer): Buffer[] {
    if (!chunk.length) return [];
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const out: Buffer[] = [];
    if (this.windowBytes <= 0) return out;
    while (this.buffer.length >= this.windowBytes) {
      out.push(this.buffer.subarray(0, this.windowBytes));
      const keepFrom = Math.max(0, this.windowBytes - this.overlapBytes);
      this.buffer = this.buffer.subarray(keepFrom);
    }
    return out;
  }

  size() {
    return this.buffer.length;
  }

  takeAll() {
    const out = this.buffer;
    this.buffer = Buffer.alloc(0);
    return out;
  }

  clear() {
    this.buffer = Buffer.alloc(0);
  }
}
