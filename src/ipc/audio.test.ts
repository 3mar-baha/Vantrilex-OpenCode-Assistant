import { describe, expect, test } from 'vitest';
import { decodeAudioChunk, encodeAudioChunk, AUDIO_DOWNLINK_TYPE, MAX_AUDIO_CHUNK } from './audio.js';

// P4b TDD — downlink framing: 1-byte type + u16be seq + MP3 payload.
describe('audio downlink framing', () => {
  test('encode/decode round-trips seq and bytes', () => {
    const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x11]);
    const frame = encodeAudioChunk(7, mp3);
    expect(frame[0]).toBe(AUDIO_DOWNLINK_TYPE);
    expect(frame.byteLength).toBe(1 + 2 + mp3.byteLength);
    const decoded = decodeAudioChunk(frame);
    expect(decoded).not.toBeNull();
    expect(decoded!.seq).toBe(7);
    expect([...decoded!.audio]).toEqual([...mp3]);
  });

  test('seq wraps at 16 bits', () => {
    const frame = encodeAudioChunk(70_000, new Uint8Array([1]));
    expect(decodeAudioChunk(frame)!.seq).toBe(70_000 % 65_536);
  });

  test('malformed frames are rejected, never thrown on', () => {
    expect(decodeAudioChunk(new Uint8Array(0))).toBeNull();
    expect(decodeAudioChunk(new Uint8Array([0x02, 0x00, 0x01]))).toBeNull();
    expect(decodeAudioChunk(new Uint8Array([AUDIO_DOWNLINK_TYPE, 0x00]))).toBeNull();
  });

  test('chunk cap is a sane streaming size', () => {
    expect(MAX_AUDIO_CHUNK).toBe(32 * 1024);
  });
});