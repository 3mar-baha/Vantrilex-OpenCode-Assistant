// Audio downlink framing (P4b): the daemon streams synthesized speech to the
// shell as binary WS frames. Layout: [type:1][seq:u16be][mp3…]. The header
// keeps speech chunks distinguishable from any future binary kinds without a
// handshake; the renderer needs no session state to play them (single-user
// companion: audio is broadcast, control stays per-session).
export const AUDIO_DOWNLINK_TYPE = 0x01;
export const MAX_AUDIO_CHUNK = 32 * 1024;

export function encodeAudioChunk(seq: number, mp3: Uint8Array): Uint8Array {
  const out = new Uint8Array(3 + mp3.byteLength);
  out[0] = AUDIO_DOWNLINK_TYPE;
  out[1] = (seq >> 8) & 0xff;
  out[2] = seq & 0xff;
  out.set(mp3, 3);
  return out;
}

export interface DecodedAudioChunk {
  readonly seq: number;
  readonly audio: Uint8Array;
}

export function decodeAudioChunk(frame: Uint8Array): DecodedAudioChunk | null {
  if (frame.byteLength < 4) return null;
  if (frame[0] !== AUDIO_DOWNLINK_TYPE) return null;
  const seq = ((frame[1] as number) << 8) | (frame[2] as number);
  return { seq, audio: frame.subarray(3) };
}

/** Split MP3 bytes into transmittable chunks with ascending sequence numbers. */
export function splitAudio(mp3: Uint8Array, firstSeq = 0): Array<{ seq: number; chunk: Uint8Array }> {
  const out: Array<{ seq: number; chunk: Uint8Array }> = [];
  let seq = firstSeq;
  for (let offset = 0; offset < mp3.byteLength; offset += MAX_AUDIO_CHUNK) {
    out.push({ seq: seq % 65_536, chunk: mp3.subarray(offset, offset + MAX_AUDIO_CHUNK) });
    seq += 1;
  }
  return out;
}