// Runs on the audio rendering thread, so it stays plain JavaScript loaded by URL.
// Downmixes to mono, resamples to 16 kHz by averaging each output sample's
// input window (a cheap low-pass), and posts 16-bit PCM in 128 ms chunks.
const TARGET_SAMPLE_RATE = 16_000;
const CHUNK_SAMPLES = 2_048;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / TARGET_SAMPLE_RATE;
    this.position = 0;
    this.sum = 0;
    this.count = 0;
    this.chunk = new Int16Array(CHUNK_SAMPLES);
    this.length = 0;
    this.port.addEventListener("message", (event) => {
      if (event.data !== "flush") return;
      const rest = this.chunk.slice(0, this.length);
      this.length = 0;
      this.port.postMessage({ type: "flushed", pcm: rest.buffer }, [rest.buffer]);
    });
    this.port.start();
  }

  process(inputs) {
    const input = inputs[0];
    if (input === undefined || input.length === 0) return true;
    const channels = input.length;
    const frames = input[0].length;
    for (let frame = 0; frame < frames; frame += 1) {
      let sample = 0;
      for (let channel = 0; channel < channels; channel += 1) sample += input[channel][frame];
      this.sum += sample / channels;
      this.count += 1;
      this.position += 1;
      if (this.position < this.step) continue;
      this.position -= this.step;
      const value = Math.max(-1, Math.min(1, this.sum / this.count));
      this.sum = 0;
      this.count = 0;
      this.chunk[this.length] = value < 0 ? value * 32_768 : value * 32_767;
      this.length += 1;
      if (this.length === CHUNK_SAMPLES) {
        this.port.postMessage({ type: "chunk", pcm: this.chunk.buffer }, [this.chunk.buffer]);
        this.chunk = new Int16Array(CHUNK_SAMPLES);
        this.length = 0;
      }
    }
    return true;
  }
}

registerProcessor("t3-pcm-capture", PcmCaptureProcessor);
