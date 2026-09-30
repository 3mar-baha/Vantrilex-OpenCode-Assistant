// Renderer voice capture (P4). Pure DSP (clamp / resample / encode) is fully
// unit-tested; the AudioCapture class owns the device lifecycle. Contract:
// 16 kHz mono Int16 frames of AUDIO_FRAME_MS over the binary WS channel.
// Capture is explicit and local: start() throws a clean error when no
// microphone exists, stop() is idempotent, and no audio leaves the machine
// except through the caller's onFrame sink.
import { dbToWaveEnergy, frameEnergyDb } from './vad.js';

export const TARGET_RATE = 16000;
const FRAME_SAMPLES = (TARGET_RATE * 100) / 1000;

export function floatToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] as number));
    out[i] = Math.round(clamped * 32767);
  }
  return out;
}

export function downsample(samples: Float32Array, fromRate: number, toRate: number = TARGET_RATE): Float32Array {
  if (!Number.isFinite(fromRate) || fromRate <= 0) throw new Error('invalid input sample rate');
  if (fromRate < toRate) throw new Error('upsampling is not supported');
  if (fromRate === toRate) return samples.slice();
  const ratio = fromRate / toRate;
  const length = Math.floor(samples.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const pos = i * ratio;
    const lo = Math.floor(pos);
    const frac = pos - lo;
    const a = samples[lo] as number;
    const b = (lo + 1 < samples.length ? samples[lo + 1] : a) as number;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

export function encodeFrame(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.byteLength);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i += 1) view.setInt16(i * 2, samples[i] as number, true);
  return out;
}

const WORKLET_MODULE = `
class VoxauraCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] !== undefined ? inputs[0][0] : undefined;
    if (channel !== undefined) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor('voxaura-capture', VoxauraCapture);
`;

export interface CaptureEvents {
  onFrame(bytes: Uint8Array): void;
  onError?(err: Error): void;
  /**
   * Live input energy (0..1) of the most recent 100 ms frame, mapped from its
   * dBFS by `dbToWaveEnergy` so it is anchored on the shared speech gate.
   * Fires once per emitted frame — never per audio block.
   */
  onEnergy?(energy: number): void;
}

interface AudioGraph {
  context: AudioContext;
  stream: MediaStream;
  node: AudioWorkletNode | ScriptProcessorNode;
}

export class AudioCapture {
  private graph: AudioGraph | null = null;
  private pending = new Float32Array(0);
  private running = false;

  get active(): boolean {
    return this.running;
  }

  async start(events: CaptureEvents): Promise<void> {
    if (this.running) return;
    const mediaDevices = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (mediaDevices?.getUserMedia === undefined || typeof AudioContext === 'undefined') {
      throw new Error('microphone unavailable in this environment');
    }
    let stream: MediaStream;
    try {
      stream = await mediaDevices.getUserMedia({
        audio: { sampleRate: TARGET_RATE, echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      // Preserve the DOMException's `name`. It is the ONLY thing that separates
      // "permission refused" from "no microphone" from "device busy", and
      // wrapping it in a plain Error collapsed all three into one — which is
      // what made SEC-7 undiagnosable from a user's report. The original is
      // kept as `cause`.
      const message = `microphone denied or absent: ${err instanceof Error ? err.message : 'unknown'}`;
      throw Object.assign(new Error(message), {
        name: err instanceof Error && err.name !== '' ? err.name : 'Error',
        cause: err,
      });
    }
    const context = new AudioContext({ sampleRate: 48000 });
    const source = context.createMediaStreamSource(stream);
    const emit = (input: Float32Array, inputRate: number): void => {
      try {
        const resampled = downsample(input, inputRate);
        const joined = new Float32Array(this.pending.length + resampled.length);
        joined.set(this.pending, 0);
        joined.set(resampled, this.pending.length);
        let offset = 0;
        while (offset + FRAME_SAMPLES <= joined.length) {
          const pcm = floatToInt16(joined.subarray(offset, offset + FRAME_SAMPLES));
          // A2 — the energy the HUD draws comes from the SAME 100 ms frame that
          // is about to be encoded, measured by the SAME function the uplink
          // gate compares against `SPEECH_GATE_DB`.
          //
          // It used to be `min(1, rms * 4)` over the raw 48 kHz input block: a
          // second opinion, on a second scale, about audio that had not been
          // quantised yet. A wave showing 0.2 could be a quiet room or a normal
          // sentence depending on which of the two numbers a reader trusted.
          //
          // One loop over 1,600 samples per 100 ms frame — 16k ops/s on the UI
          // path — and it REPLACES the previous measurement rather than adding
          // to it, so the frame cost is unchanged.
          events.onEnergy?.(dbToWaveEnergy(frameEnergyDb(pcm)));
          events.onFrame(encodeFrame(pcm));
          offset += FRAME_SAMPLES;
        }
        this.pending = joined.subarray(offset);
      } catch (err) {
        events.onError?.(err instanceof Error ? err : new Error('capture error'));
      }
    };

    let node: AudioWorkletNode | ScriptProcessorNode;
    try {
      const url = URL.createObjectURL(new Blob([WORKLET_MODULE], { type: 'application/javascript' }));
      await context.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const worklet = new AudioWorkletNode(context, 'voxaura-capture');
      worklet.port.onmessage = (ev: MessageEvent) => emit(ev.data as Float32Array, context.sampleRate);
      source.connect(worklet);
      node = worklet;
    } catch {
      // Legacy fallback where AudioWorklet is unavailable.
      const fallback = context.createScriptProcessor(4096, 1, 1);
      fallback.onaudioprocess = (ev: AudioProcessingEvent) =>
        emit(ev.inputBuffer.getChannelData(0), context.sampleRate);
      source.connect(fallback);
      fallback.connect(context.destination);
      node = fallback;
    }
    try {
      await context.resume();
    } catch {
      // Headless/fake devices may refuse resume; frames still flow on process.
    }
    this.graph = { context, stream, node };
    this.running = true;
  }

  stop(): void {
    this.running = false;
    this.pending = new Float32Array(0);
    const graph = this.graph;
    this.graph = null;
    if (graph === null) return;
    try {
      graph.node.disconnect();
    } catch {
      // already torn down
    }
    for (const track of graph.stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // already stopped
      }
    }
    void graph.context.close().catch(() => undefined);
  }
}