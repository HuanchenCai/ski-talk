// Capture worklet: collects mono float samples into fixed frames and posts them
// to the main thread, which wraps them as AudioData for the Opus encoder.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.frame = options.processorOptions.frameSamples; // e.g. 2880 = 60 ms @ 48 kHz
    this.buf = new Float32Array(this.frame);
    this.n = 0;
    this.active = true;
    this.port.onmessage = (e) => { if (e.data === 'stop') this.active = false; };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || !this.active) return this.active;
    let i = 0;
    while (i < ch.length) {
      const take = Math.min(ch.length - i, this.frame - this.n);
      this.buf.set(ch.subarray(i, i + take), this.n);
      this.n += take; i += take;
      if (this.n === this.frame) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(this.frame);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
