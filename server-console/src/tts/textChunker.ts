export class TextChunker {
  private buffer = "";

  constructor(private readonly maxChars: number) {}

  push(text: string): string[] {
    if (!text) return [];
    this.buffer += text;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    const out: string[] = [];
    for (const line of lines) {
      out.push(...this.splitLine(line));
    }
    return out;
  }

  flush(): string[] {
    if (!this.buffer) return [];
    const remaining = this.buffer;
    this.buffer = "";
    return this.splitLine(remaining);
  }

  private splitLine(raw: string): string[] {
    const line = raw.trim();
    if (!line) return [];
    const sentences = line.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [line];
    const out: string[] = [];
    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      if (!trimmed) continue;
      if (trimmed.length <= this.maxChars) {
        out.push(trimmed);
      } else {
        out.push(...this.splitLong(trimmed));
      }
    }
    return out;
  }

  private splitLong(text: string): string[] {
    const words = text.split(/\s+/).filter(Boolean);
    const out: string[] = [];
    let current = "";
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (next.length > this.maxChars && current) {
        out.push(current);
        current = word;
        continue;
      }
      current = next;
    }
    if (current) out.push(current);
    return out;
  }
}
