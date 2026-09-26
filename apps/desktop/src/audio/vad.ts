// Voice activity detection for barge-in/ducking (P4b follow-up). Pure DSP:
// normalized RMS energy of an Int16 mono frame, gated against a threshold
// calibrated so room tone stays silent and voice bursts trip it. The daemon
// never sees ducked frames; barge-in frames go up immediately with an abort.

/** RMS energy in dBFS (silence floors at -100). */
export function frameEnergyDb(frame: Int16Array): number {
  if (frame.length === 0) return -100;
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const v = (frame[i] as number) / 32768;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / frame.length);
  if (rms <= 0) return -100;
  return Math.max(-100, 20 * Math.log10(rms));
}

/** Speech gate: amplitude 4000/32768 ≈ -18 dBFS trips at the -30 dB default. */
export function isSpeechFrame(frame: Int16Array, thresholdDb = -30): boolean {
  return frameEnergyDb(frame) > thresholdDb;
}

/** View raw uplink bytes (Int16LE) as samples without copying. */
export function bytesToSamples(bytes: Uint8Array): Int16Array {
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
}

/** Barge-in policy: what the uplink does with one frame while TTS is playing. */
export type BargeDecision = 'duck' | 'barge' | 'send';

export function bargePolicy(speaking: boolean, frame: Uint8Array, thresholdDb = -30): BargeDecision {
  if (!speaking) return 'send';
  return isSpeechFrame(bytesToSamples(frame), thresholdDb) ? 'barge' : 'duck';
}