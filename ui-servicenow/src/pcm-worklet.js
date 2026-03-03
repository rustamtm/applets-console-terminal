class PCMWorkletProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) {
      return true;
    }
    const channel = input[0];
    const factor = Math.max(1, Math.round(sampleRate / 16000));
    const outLen = Math.floor(channel.length / factor);
    const int16 = new Int16Array(outLen);
    let j = 0;
    for (let i = 0; i < channel.length && j < outLen; i += factor, j += 1) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      int16[j] = s * 0x7fff;
    }
    this.port.postMessage(int16.buffer, [int16.buffer]);
    return true;
  }
}

registerProcessor("pcm-worklet", PCMWorkletProcessor);
