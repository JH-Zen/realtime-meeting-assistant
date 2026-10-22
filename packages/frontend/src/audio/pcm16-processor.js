/**
 * Microphone capture for the live STT path (design doc §16, Phase 5).
 *
 * The browser's audio graph runs at 44.1/48 kHz, the recogniser wants 16 kHz s16le, and the chunk
 * size the worker is happiest with is 100 ms. Doing all three inside an AudioWorklet keeps the main
 * thread free, which is what Test F's "no UI jank" depends on — a `ScriptProcessorNode` would decode
 * and resample on the UI thread.
 */
const TARGET_RATE = 16000;
const CHUNK_FRAMES = TARGET_RATE / 10;

class Pcm16Processor extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` is the render quantum's rate, i.e. the AudioContext's, not the recogniser's.
    this.step = sampleRate / TARGET_RATE;
    this.source = new Float32Array(0);
    this.read = 0;
    this.out = new Int16Array(CHUNK_FRAMES);
    this.filled = 0;
  }

  process(inputs) {
    const block = inputs[0]?.[0];
    if (block && block.length > 0) {
      const merged = new Float32Array(this.source.length + block.length);
      merged.set(this.source);
      merged.set(block, this.source.length);
      this.source = merged;
      this.consume();
    }
    // Returning true keeps the node alive; a worklet that stops responding mutes the pipeline.
    return true;
  }

  consume() {
    while (this.filled < CHUNK_FRAMES) {
      const lower = Math.floor(this.read);
      if (lower + 1 >= this.source.length) break;
      const weight = this.read - lower;
      const value = this.source[lower] * (1 - weight) + this.source[lower + 1] * weight;
      const clamped = value < -1 ? -1 : value > 1 ? 1 : value;
      this.out[this.filled] = (clamped * 32767) | 0;
      this.filled += 1;
      this.read += this.step;
    }
    if (this.filled === CHUNK_FRAMES) {
      const chunk = this.out;
      this.out = new Int16Array(CHUNK_FRAMES);
      this.filled = 0;
      this.port.postMessage(chunk, [chunk.buffer]);
    }
    // Drop what has already been interpolated, keeping one sample behind the cursor so the next
    // block can still interpolate across the boundary instead of stepping.
    const drop = Math.max(0, Math.floor(this.read) - 1);
    if (drop > 0) {
      this.source = this.source.slice(drop);
      this.read -= drop;
    }
  }
}

registerProcessor("pcm16-16k", Pcm16Processor);
