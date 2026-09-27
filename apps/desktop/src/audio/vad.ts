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

/**
 * L19 — when the microphone hardware should be acquired or released.
 *
 * The mic used to stay hot for as long as the window merely lost focus, which
 * for a voice-first HUD is a standing privacy and battery cost the user never
 * asked for. The rule is deliberately narrow:
 *
 *  - a **hidden** window releases the hardware unconditionally, because the
 *    user cannot see that it is listening;
 *  - a **visible** window re-acquires it only if the user had not muted;
 *  - the user's own mute choice is never overridden in either direction.
 *
 * `muted` is the user's toggle, NOT whether a track currently exists — the
 * distinction is what makes minimise/restore non-destructive.
 */
export type MicPolicy = 'release' | 'start' | 'none';

export function micPolicy(visibility: 'visible' | 'hidden', muted: boolean): MicPolicy {
  if (visibility === 'hidden') return 'release';
  return muted ? 'none' : 'start';
}

/**
 * SEC-7 — say WHY the microphone failed, not just that it did.
 *
 * `getUserMedia` rejects with a `DOMException` whose `name` is the only thing
 * that distinguishes the causes, and they need completely different responses:
 *
 *  - `NotAllowedError` — permission was refused. In a packaged Tauri build this
 *    is the live risk: wry registers a WebView2 `PermissionRequested` handler
 *    that leaves the microphone in `PERMISSION_STATE_DEFAULT` (it only
 *    explicitly allows clipboard reads), and `tauri-runtime-wry` exposes no
 *    passthrough to change that. Whether WebView2 then prompts or silently
 *    denies could not be verified from here, so the user has to be able to tell
 *    us which it was.
 *  - `NotFoundError` — no microphone at all. Nothing to fix in permissions.
 *  - `NotReadableError` — the device exists but another app holds it.
 *
 * Collapsing all three into one generic Arabic sentence made "voice is dead"
 * undiagnosable from a user's report alone.
 */
export function micFailureNotice(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'رُفض إذن الميكروفون — فعّله من إعدادات ويندوز ثم أعد المحاولة';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'لا يوجد ميكروفون متصل بالجهاز';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'الميكروفون مستخدم من تطبيق آخر — أغلقه ثم أعد المحاولة';
    default:
      return 'تعذّر الوصول إلى الميكروفون';
  }
}