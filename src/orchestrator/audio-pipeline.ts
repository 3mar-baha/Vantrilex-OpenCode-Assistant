import type { SessionId } from '../common/brands.js';
import { AudioIngest, isLoudWindow } from '../voice/ingest.js';
import { STT_TIMEOUT_MS, SttTimeoutError } from '../voice/stt.js';

// Voice capture pipeline (P4): ingest windows → Whisper transcript → brain
// reply → session dispatch. Three fail-closed rules: silence is gated before
// the STT provider (an empty transcript spends nothing downstream, and
// without an active session nothing is dispatched), and no fabricated prompts.
//
// D1 — the silence gate exists because Whisper hallucinates on room tone and
// the brain then reasons about the invented text, so the assistant answers
// itself. Three independent layers, each with its own counter so the
// observability record can attribute a silence to a cause:
//   1. speech gate   — energy by default; the daemon injects Silero (vad.ts)
//   2. no_speech_prob — Whisper's own verdict on what we already paid for
//   3. repeat dedupe — a transcript seen in the last few windows is dropped
export interface Utterance {
  readonly transcript: string;
  readonly reply: string;
  readonly receipt: string | null;
}

/** Whisper `verbose_json` exposes no_speech_prob; a bare string means "unknown". */
export type Transcription = string | { readonly text: string; readonly noSpeechProb?: number };

/** Mirrors whisper.cpp's documented `-vth 0.6` default for a speech gate. */
export const NO_SPEECH_DROP = 0.6;

/** How many recent transcripts are remembered for the repeat check. */
const REPEAT_MEMORY = 5;

export interface AudioPipelineDeps {
  readonly ingest?: AudioIngest;
  /**
   * Replaces the energy gate when present (Silero). `true` transcribes the
   * window, `false` discards it before the STT provider is called.
   */
  speechGate?(window: Uint8Array): Promise<boolean>;
  transcribe(pcm: Uint8Array): Promise<Transcription>;
  think(transcript: string): Promise<{ reply: string; receipt?: string | null }>;
  /** Optional raw-text fallback. When absent, nothing is ever dispatched implicitly. */
  dispatch?(text: string): Promise<{ receipt: string }>;
  activeSessionId(): SessionId | undefined;
  onUtterance?(utterance: Utterance): void;
  /**
   * D5: a transcription window that timed out. The window is abandoned and the
   * loop CONTINUES with the next one — a single stalled provider call must not
   * cost the rest of the capture session.
   */
  onSttTimeout?(ms: number): void;
}

export class AudioPipeline {
  private readonly ingest: AudioIngest;
  private readonly deps: AudioPipelineDeps;
  private recent: string[] = [];
  private gatedCount = 0;
  private hallucinationCount = 0;
  private repeatCount = 0;
  private sttTimeouts = 0;

  constructor(deps: AudioPipelineDeps) {
    this.deps = deps;
    this.ingest = deps.ingest ?? new AudioIngest();
  }

  get bufferedBytes(): number {
    return this.ingest.bufferedBytes;
  }

  get droppedWindows(): number {
    return this.ingest.droppedWindows;
  }

  /** Windows discarded by the speech gate before the STT provider. */
  get gatedWindows(): number {
    return this.gatedCount;
  }

  /** Transcripts dropped because Whisper itself reported no speech. */
  get hallucinationDrops(): number {
    return this.hallucinationCount;
  }

  /** Transcripts dropped as a verbatim repeat of a recent utterance. */
  get repeatDrops(): number {
    return this.repeatCount;
  }

  /** Windows abandoned because transcription timed out. */
  get sttTimeoutDrops(): number {
    return this.sttTimeouts;
  }

  reset(): void {
    this.ingest.reset();
    this.recent = [];
  }

  async pushChunk(chunk: Uint8Array): Promise<void> {
    for (const window of this.ingest.push(chunk)) {
      if (!(await this.isSpeech(window))) {
        this.gatedCount += 1;
        continue;
      }
      const result = await this.transcribeWindow(window);
      // A timed-out window is dropped, not thrown: the loop must keep flowing.
      if (result === null) continue;
      const text = typeof result === 'string' ? result : result.text;
      const noSpeechProb = typeof result === 'string' ? undefined : result.noSpeechProb;
      const transcript = text.trim();
      if (transcript.length === 0) continue;
      if (noSpeechProb !== undefined && noSpeechProb > NO_SPEECH_DROP) {
        this.hallucinationCount += 1;
        continue;
      }
      if (this.isRepeat(transcript)) {
        this.repeatCount += 1;
        continue;
      }
      this.remember(transcript);
      const thought = await this.deps.think(transcript);
      // A think-provided receipt means the think stage already dispatched
      // (e.g. the coordinator chain). Raw text is only dispatched when an
      // explicit fallback exists — never implicitly.
      let receipt: string | null = thought.receipt ?? null;
      if (receipt === null && this.deps.dispatch !== undefined && this.deps.activeSessionId() !== undefined) {
        receipt = (await this.deps.dispatch(transcript)).receipt;
      }
      this.deps.onUtterance?.({ transcript, reply: thought.reply, receipt });
    }
  }

  /** An injected detector replaces the energy gate; it never stacks on top. */
  private async isSpeech(window: Uint8Array): Promise<boolean> {
    if (this.deps.speechGate !== undefined) return this.deps.speechGate(window);
    return isLoudWindow(window);
  }

  /**
   * D5: drop a window whose transcription timed out instead of throwing.
   * `pushChunk` awaits windows serially, so propagating would abandon every
   * later window too — the wedge this fix exists to remove. Any other error is
   * a real failure and still propagates.
   */
  private async transcribeWindow(window: Uint8Array): Promise<Transcription | null> {
    try {
      return await this.deps.transcribe(window);
    } catch (err) {
      if (!(err instanceof SttTimeoutError)) throw err;
      this.sttTimeouts += 1;
      this.deps.onSttTimeout?.(STT_TIMEOUT_MS);
      return null;
    }
  }

  /** Punctuation/whitespace/case insensitive so trivial variants still repeat. */
  private isRepeat(transcript: string): boolean {
    return this.recent.includes(repeatKey(transcript));
  }

  private remember(transcript: string): void {
    this.recent.push(repeatKey(transcript));
    if (this.recent.length > REPEAT_MEMORY) this.recent.shift();
  }
}

function repeatKey(text: string): string {
  return text
    .replace(/[؟?!.،,:؛;'"«»()[\]{}\-—–]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
