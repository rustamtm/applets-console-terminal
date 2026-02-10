export function pcm16ToWav(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  const rate = Number(sampleRate);
  const ch = Number(channels);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("Invalid sampleRate");
  if (!Number.isFinite(ch) || ch <= 0) throw new Error("Invalid channels");

  const bitsPerSample = 16;
  const blockAlign = (ch * bitsPerSample) / 8;
  const byteRate = rate * blockAlign;
  const dataSize = pcm.length;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM header size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(ch, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}

