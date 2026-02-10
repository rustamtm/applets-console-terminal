export function pcmRms16(buffer: Buffer): number {
  if (!buffer.length) return 0;
  const sampleCount = Math.floor(buffer.length / 2);
  if (sampleCount === 0) return 0;
  let sum = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const sample = buffer.readInt16LE(i * 2);
    sum += sample * sample;
  }
  return Math.sqrt(sum / sampleCount);
}
