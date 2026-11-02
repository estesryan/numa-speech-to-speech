// AudioWorklet: forwards microphone samples to the main thread in ~40 ms blocks (lib/audio/microphone.ts).
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(Math.round(sampleRate * 0.04));
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      let offset = 0;
      while (offset < channel.length) {
        const n = Math.min(
          channel.length - offset,
          this.block.length - this.filled,
        );
        this.block.set(channel.subarray(offset, offset + n), this.filled);
        this.filled += n;
        offset += n;
        if (this.filled === this.block.length) {
          this.port.postMessage(this.block.slice());
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);
