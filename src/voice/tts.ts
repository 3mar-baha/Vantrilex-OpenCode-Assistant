import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nowIso, VOICE_IDS } from '../common/brands.js';
import type { VoiceId } from '../common/brands.js';
import { AudioCache, cacheKey, type AudioCacheConfig } from './cache.js';
import type { Keyring } from './keyring.js';

// TTS engine — docs/18 §18.4, docs/06 §6.6. Cache-first; Fish Audio `s2.1-pro-free`
// streaming synthesis; voice from VOICE_IDS; keyring-supplied key per call.
// AudioOut is a sink interface: FileAudioOut persists + hands off to the OS
// (no focus APIs); device streaming binds later without changing this path.
/**
 * R7: the free tier is a PROMOTION with a hard end date.
 *
 * Fish Audio's official docs state S2.1 Pro Free access runs THROUGH
 * 2026-11-30, with no SLA, no TTFA guarantee, and requests retained for model
 * training. After that date every install loses speech output simultaneously
 * unless a paid plan is bought or the provider is changed.
 *
 * That date is recorded here because a magic string with no lifecycle is how
 * the 402 on 2026-09-27 was misdiagnosed as a code fault for hours. When the
 * date passes, this is a migration decision, not a bug: the fallback options
 * are a paid Fish plan, Groq `canopylabs/orpheus-arabic-saudi` (already proven
 * working in this project), or the WebSocket endpoint on a paid model.
 *
 * Do NOT switch this to a paid slug to "fix" a 402. See the note on
 * `fishHeaders` — a paid slug 402s identically and the error names the wrong
 * cause.
 */
export const TTS_MODEL = 's2.1-pro-free';
export const TTS_FIRST_CHUNK_BUDGET_MS = 800;
/** Longest single synthesis request: run-ons hard-split on word boundaries. */
export const MAX_SENTENCE_CHARS = 400;

/**
 * Conversational interjections stripped from the START of a sentence only.
 *
 * Deliberately tiny. A bare `تمام` is a legitimate answer and must survive; it
 * is listed here only in its comma form. This list is the highest-risk,
 * lowest-evidence rule in the sanitiser, so it is exported for review rather
 * than buried in a regex.
 */
export const SPEECH_FILLERS = ['يعني', 'طيب', 'يعني،', 'طيب،', 'اوك', 'تمام،'] as const;

const TERMINATORS = '.!?؟!…';

/**
 * Strip everything with no spoken form (D2). Adapted from
 * `pipecat-ai/pipecat` `utils/text/transforms/strip_markdown.py`
 * (BSD-2-Clause), extended for Arabic and for non-Latin script.
 *
 * The contract, inherited from that module's docstring: the sanitiser must be
 * **alphanumeric-preserving** — it removes decoration, never a word. That is
 * what makes it safe to run on model output that has already been reasoned
 * over, and it is pinned by test.
 *
 * Explicit non-goal: folding Arabic letter variants (أإآٱ→ا, ى→ي, ؤ→و). Those
 * are phonemic distinctions in MSA — `على` is correct with ى, `آمن` carries a
 * real madda, `أرد` has a distinct glottal onset. Folding them would invent a
 * dialect. Under-normalising is safe; over-normalising mispronounces. Only
 * tashkīl and tatweel — pure orthography — are removed.
 */
export function stripSpeechText(input: string): string {
  let text = input;

  // Fenced code blocks: unpronounceable, removed whole.
  text = text.replace(/```[\s\S]*?```/g, '');
  text = text.replace(/~~~[\s\S]*?~~~/g, '');
  // Inline code: keep the content, drop the delimiter.
  text = text.replace(/`([^`]+)`/g, '$1');
  // Link/image: keep the label, drop the target.
  text = text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Emphasis, widest first.
  text = text.replace(/\*{3}(.+?)\*{3}/g, '$1');
  text = text.replace(/_{3}(.+?)_{3}/g, '$1');
  text = text.replace(/\*{2}(.+?)\*{2}/g, '$1');
  text = text.replace(/_{2}(.+?)_{2}/g, '$1');
  text = text.replace(/\*(.+?)\*/g, '$1');
  text = text.replace(/(^|[\s(])_([^_]+)_(?=$|[\s).,،؟!])/g, '$1$2');
  // Block structure.
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  text = text.replace(/^\s{0,3}>\s?/gm, '');
  text = text.replace(/^\s*[-*_]{3,}\s*$/gm, '');
  // List markers keep the words. `[ \t]*` rather than `\s+` so a tight "-نص"
  // is still a bullet.
  text = text.replace(/^\s*[-*+•]+[ \t]*/gm, '');
  text = text.replace(/^\s*\d{1,3}[.)][ \t]*/gm, '');

  // URLs and bare paths: spelled out letter by letter, never understood.
  text = text.replace(/\bhttps?:\/\/\S+/gi, '');
  text = text.replace(/(?<![\p{L}\p{N}])\S*[\p{L}\p{N}]\/[\p{L}\p{N}\-._/]+/gu, '');
  // Fenced/inline leftovers and stray control characters.
  text = text.replace(/```/g, '');

  // Emoji and pictograph blocks, plus the regional-indicator pair used by flags.
  // Combining marks (ZWJ, variation selector, skin-tone keycap) are stripped
  // below with the other format characters rather than here: a character class
  // containing combining marks is ambiguous, and `no-misleading-character-class`
  // is right to complain.
  text = text.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}]/gu, '');
  // Bidi controls, zero-width and other invisible format characters. The
  // combining marks (ZWJ, VS16, keycap) are alternated rather than listed in a
  // class: a class containing combining marks is ambiguous, and
  // `no-misleading-character-class` is right to reject it.
  text = text.replace(/\u200E|\u200F|[\u202A-\u202E\u2066-\u2069\u200B-\u200D\uFEFF]|\uFE0F|\u20E3/g, '');
  // Arabic orthography only: tashkil (U+064B–U+0652, U+0670) and tatweel.
  text = text.replace(/[\u064B-\u0652\u0670\u0640]/g, '');

  // Collapse whitespace left behind by every removal above. The second rule is
  // the one that matters: removing a trailing emoji or a diacritic must not
  // leave a floating space before the terminator ("تمام 🎉." → "تمام .").
  text = text
    .replace(/[^\S\n]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .replace(/[ \t]+([.!?؟!…،,:;])/g, '$1')
    .trim();

  text = stripFillers(text);

  if (!isSpeakable(text)) return '';
  return /\S$/.test(text) && TERMINATORS.includes(text.slice(-1)) ? text : `${text}.`;
}

/** Remove leading interjections per line, once each, at a word boundary. */
function stripFillers(text: string): string {
  let out = text;
  for (const filler of SPEECH_FILLERS) {
    const re = new RegExp(`^${escapeRegex(filler)}\\s*[,،]?\\s*`, 'gm');
    out = out.replace(re, '');
  }
  return out.trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when at least one letter or digit survives — the never-synthesize rule. */
export function isSpeakable(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

export interface AudioOut {
  play(audio: Uint8Array, voice: VoiceId): Promise<{ startedMs: number }>;
  /** Progressive sink: receives chunks as they synthesize; default callers may omit. */
  playStream?(chunks: AsyncIterable<Uint8Array>, voice: VoiceId): Promise<{ startedMs: number }>;
}

/**
 * Sentence splitter for streaming TTS (directive 5): Arabic and Latin
 * terminators plus newlines bound sentences; the mark stays attached so
 * prosody survives; punctuation-less run-ons hard-split on word boundaries
 * so no single synthesis request grows without bound.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const chunk of text.split(/\n+/)) {
    const parts = chunk.match(/[^.!?؟!…]+[.!?؟!…]+|[^.!?؟!…]+$/g) ?? [];
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.length === 0) continue;
      if (trimmed.length <= MAX_SENTENCE_CHARS) {
        out.push(trimmed);
        continue;
      }
      let cur = '';
      for (const word of trimmed.split(/\s+/)) {
        const next = cur.length === 0 ? word : `${cur} ${word}`;
        if (next.length > MAX_SENTENCE_CHARS && cur.length > 0) {
          out.push(cur);
          cur = word;
        } else {
          cur = next;
        }
      }
      if (cur.length > 0) out.push(cur);
    }
  }
  return out;
}

/**
 * Barge-in generation gate (directive 4): the daemon captures a generation
 * before speaking a reply sentence-by-sentence; an `abort` command bumps the
 * generation so stale sentences never synthesize or broadcast afterwards.
 */
export class SpeechGate {
  private generation = 0;

  capture(): number {
    return this.generation;
  }

  isCurrent(gen: number): boolean {
    return gen === this.generation;
  }

  abort(): void {
    this.generation += 1;
  }
}

export class FileAudioOut implements AudioOut {
  constructor(private readonly dir: string = join(tmpdir(), 'opencode-voice-playback')) {}

  async play(audio: Uint8Array, voice: VoiceId): Promise<{ startedMs: number }> {
    return this.playStream(
      (async function* (): AsyncGenerator<Uint8Array> {
        yield audio;
      })(),
      voice,
    );
  }

  async playStream(chunks: AsyncIterable<Uint8Array>, voice: VoiceId): Promise<{ startedMs: number }> {
    const started = Date.now();
    mkdirSync(this.dir, { recursive: true });
    // L3: sweep before writing so the directory cannot grow without bound.
    sweepOldPlaybackFiles(this.dir, PLAYBACK_RETENTION_MS);
    const path = join(this.dir, `${cacheKey(nowIso(), voice)}.mp3`);
    const { openSync, writeSync, closeSync } = await import('node:fs');
    const fd = openSync(path, 'w');
    try {
      for await (const chunk of chunks) {
        writeSync(fd, chunk);
      }
    } finally {
      closeSync(fd);
    }
    return { startedMs: Date.now() - started };
  }
}

export interface FishTransport {
  synthesize(text: string, fishVoiceId: string): Promise<Uint8Array>;
  /** Progressive synthesis; engine times first yield as first-chunk TTFB. */
  synthesizeStream?(text: string, fishVoiceId: string): AsyncGenerator<Uint8Array>;
}

/**
 * The `TTSRequest` body we send, per the published Fish Audio openapi v1
 * schema. Exported so the policy is unit-testable without a network call and
 * reviewable without reading the transport.
 *
 * Every field is a deliberate choice against a reported symptom:
 * - `latency: 'normal'` — docs: "normal: best quality, balanced: reduced
 *   latency". We were paying latency for a voice that came out shouting.
 * - `prosody.volume: -2` — dB, negative is quieter. The documented,
 *   server-side headroom for an over-loud voice.
 * - `prosody.speed: 0.95` — a shade under normal pace.
 * - `temperature: 0.5` (default 0.7) — "controls expressiveness"; lower is
 *   more consistent, which is what a calm, dignified delivery needs.
 * - `repetition_penalty: 1.3` (default 1.2) — "penalty for repeating audio
 *   patterns"; the reported symptom was repeated words.
 * - `chunk_length: 300` (was 200) — the documented default and maximum; fewer
 *   word-boundary splits inside a clause means less garbling.
 * - `normalize: true` KEPT — the schema defines this as *text* normalisation
 *   for number stability, not an audio loudness control. An earlier audit
 *   blamed it for loudness; that reading was wrong and the field is unchanged.
 * - `condition_on_previous_chunks: true` — voice consistency across chunks.
 */
/**
 * Fish request headers.
 *
 * `model` MUST be an HTTP header, not a JSON body field. This is the single
 * least obvious thing about the Fish API and it fails in the most misleading
 * possible way: with the model in the body (or absent) the endpoint treats the
 * call as paid tier and answers **HTTP 402 "Insufficient API credit"** — even on
 * an account with thousands of unused free credits. Verified by probing all four
 * combinations against the live API: model-as-header returns audio, and both
 * model-in-body and no-model return 402.
 *
 * So the error names the one cause that is not actually wrong. An engineer
 * chasing it tops up a balance that was already fine, and the next request
 * still 402s.
 *
 * Extracted as a function purely so this is reachable from a test; the inline
 * version was untestable, and an untestable header is one refactor away from
 * being "tidied" into the body.
 */
export function fishHeaders(key: string): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    model: TTS_MODEL,
    Accept: 'audio/mpeg',
  };
}

/**
 * R3: turn a Fish HTTP status into an actionable, secret-safe message.
 *
 * Previously every non-ok status collapsed to `TTS failed: HTTP ${status}`. That
 * is not a diagnostic, it is a restatement: 402 means the account is out of
 * credit, 401 means the key is wrong, and 422 is a validation error whose body
 * names the offending field. All three produced the same opaque string, so the
 * one failure mode that cost the most time to diagnose — a 402 that looked like a
 * code fault — was the one this hid best.
 *
 * Deliberately does NOT include response text for 401/402: those bodies are
 * account metadata, and the message below is the whole point of putting them
 * behind a closed union rather than echoing whatever the server said.
 */
export function fishErrorMessage(status: number, detail: string | null = null): string {
  switch (status) {
    case 401:
    case 403:
      // The key was rejected. L17 already rotates the pool on this.
      //
      // The status is interpolated rather than hardcoded per branch: 401 and 403
      // share a cause but NOT a meaning. A 403 is a permission or entitlement
      // problem and a 401 is a bad credential, and an operator reading "401" when
      // the server said 403 is sent to debug the wrong thing entirely.
      return `TTS auth rejected (${status}) - the Fish API key is invalid, revoked or not entitled; rotate it`;
    case 402:
      // The one that matters most. NOT a key fault, so L17 correctly does not
      // rotate: adding credit is the fix, swapping keys is not.
      return 'TTS out of credit (402) - top up the Fish balance or wait for quota; the key itself is fine';
    case 422:
      // The only status whose body is worth surfacing: it is an array of
      // {loc, msg} and names the field that failed validation.
      return detail === null
        ? 'TTS request rejected by the API (422) - a parameter is out of range'
        : `TTS request rejected by the API (422): ${detail}`;
    case 429:
      return 'TTS rate limited (429) - backing off';
    case 404:
      return 'TTS voice model not found (404) - the reference_id does not resolve';
    default:
      return status >= 500
        ? `TTS provider error (${status}) - Fish failed on their side, safe to retry`
        : `TTS failed: HTTP ${status}`;
  }
}

/**
 * R3: extract a short, secret-safe detail from a Fish error body.
 *
 * Fish returns `{status, message}` for 401/402/404 and an ARRAY of
 * `{loc, type, msg}` for 422. Only 422 is read, because only 422 is a
 * validation report about our own request. Everything else returns null so the
 * caller cannot accidentally echo account metadata into a log line.
 */
export async function fishErrorDetail(res: Response): Promise<string | null> {
  if (res.status !== 422) return null;
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const first = parsed[0] as { loc?: unknown; msg?: unknown } | undefined;
  if (first === undefined) return null;
  const msg = typeof first.msg === 'string' ? first.msg : null;
  const loc = Array.isArray(first.loc) ? first.loc.filter((p) => typeof p === 'string' || typeof p === 'number').join('.') : null;
  if (msg === null && loc === null) return null;
  // Bounded: this reaches a log line and a notice banner.
  const detail = (loc === null ? '' : `${loc}: `) + (msg ?? 'invalid');
  return detail.slice(0, 120);
}

export function fishRequestBody(text: string, fishVoiceId: string): Record<string, unknown> {
  return {
    // Sanitised again here on purpose: this is the last gate before bytes hit
    // the network, and the daemon's `onUtterance` path calls the transport
    // directly, bypassing TtsEngine. stripSpeechText is idempotent, so the
    // engine's earlier pass costs nothing.
    text: stripSpeechText(text),
    reference_id: fishVoiceId,
    format: 'mp3',
    // R2: `balanced` rather than the `normal` default. Measured live against
    // the same short Arabic greeting, twice:
    //   normal   1,405-1,432 ms to first chunk
    //   balanced    426-556 ms to first chunk
    //   low         443-1,376 ms - high variance, most chunks, slowest end
    // A reproducible ~3x improvement to time-to-first-audio, which is the
    // number a voice product is actually judged on. `low` is tempting and
    // wrong: one fast sample, but it was both the slowest to complete and the
    // least predictable across runs.
    //
    // Audited against the official fish-audio-api skill; `balanced` is the
    // documented middle setting. See dossier/FISH-AUDIO-COMPLIANCE-AUDIT.md.
    latency: 'balanced',
    chunk_length: 300,
    min_chunk_length: 50,
    normalize: true,
    temperature: 0.5,
    top_p: 0.7,
    repetition_penalty: 1.3,
    condition_on_previous_chunks: true,
    prosody: { speed: 0.95, volume: -2, normalize_loudness: true },
  };
}

/** Hard abort for a synthesis request. A hung socket must not wedge a turn. */
export const FISH_TIMEOUT_MS = 20_000;

/**
 * L2: the combined per-reply audio is cached as ONE entry, so an unbounded
 * reply meant an unbounded allocation held for the length of the cache
 * lifetime. 2 MB is far more than a spoken paragraph and small enough to be
 * harmless when exceeded — in which case the entry is simply not written.
 */
export const SPEECH_CACHE_MAX_ENTRY_BYTES = 2 * 1024 * 1024;

/** L3: how long a written playback file is kept. */
export const PLAYBACK_RETENTION_MS = 15 * 60_000;

/**
 * Delete playback files older than `maxAgeMs`. Returns how many were removed.
 *
 * L3: `FileAudioOut` wrote one MP3 per reply into %TEMP% and nothing ever
 * cleaned up, so the directory grew for the lifetime of the machine. Best
 * effort by contract: a missing directory is zero, not an error.
 */
export function sweepOldPlaybackFiles(dir: string, maxAgeMs: number, now: number = Date.now()): number {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of entries) {
    const file = join(dir, name);
    try {
      if (now - statSync(file).mtimeMs < maxAgeMs) continue;
      unlinkSync(file);
      removed += 1;
    } catch {
      // A file held open by a still-playing sink is simply kept for next time.
    }
  }
  return removed;
}

/** Distinguishable from a provider 4xx/5xx so callers can tell them apart. */
export class TtsTimeoutError extends Error {
  constructor(ms: number) {
    super(`TTS request timed out after ${ms}ms`);
    this.name = 'TtsTimeoutError';
  }
}

/**
 * `fetch` with a hard abort, using the same idiom as `brain.ts` so the codebase
 * has one timeout pattern. L9: the Fish call previously had none, so a stalled
 * connection held the utterance chain and the `speaking` phase indefinitely.
 *
 * The timer is **raced**, not merely signalled. Passing an `AbortSignal` only
 * bounds the call if the fetch implementation honours it — a stub, a polyfill,
 * or a hung socket inside a proxy may simply never settle. Racing makes "returns
 * within `timeoutMs`" a property of this function rather than a hope about
 * someone else's code.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TtsTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fetchImpl(url, { ...init, signal: controller.signal }), expiry]);
  } catch (err) {
    // If the signal fired, report the timeout even if the underlying call
    // rejected with something else (a socket reset during teardown, say), so
    // callers see one cause rather than a different error per transport.
    if (controller.signal.aborted && !(err instanceof TtsTimeoutError)) throw new TtsTimeoutError(timeoutMs);
    throw err;
  } finally {
    // Always disarm: a live timer keeps the event loop (and the daemon) alive.
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class FishHttpTransport implements FishTransport {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly keyring: Keyring,
    private readonly endpoint = 'https://api.fish.audio/v1/tts',
    options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? FISH_TIMEOUT_MS;
  }

  async synthesize(text: string, fishVoiceId: string): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    for await (const chunk of this.synthesizeStream(text, fishVoiceId)) {
      parts.push(chunk);
    }
    const total = parts.reduce((n, p) => n + p.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  }

  async *synthesizeStream(text: string, fishVoiceId: string): AsyncGenerator<Uint8Array> {
    const key = this.keyring.acquire('fish');
    try {
      const res = await fetchWithTimeout(
        this.endpoint,
        {
          method: 'POST',
          headers: fishHeaders(Buffer.from(key.material).toString('utf8')),
          body: JSON.stringify(fishRequestBody(text, fishVoiceId)),
        },
        this.timeoutMs,
        this.fetchImpl,
      );
      if (!res.ok || res.body === null) {
        this.keyring.release(key, false, res.status);
        throw new Error(fishErrorMessage(res.status, await fishErrorDetail(res)));
      }
      this.keyring.release(key, true);
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          yield value;
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    } catch (err) {
      try {
        key.material.fill(0);
      } catch {
        // Zeroing is best-effort after transport failure.
      }
      throw err;
    }
  }
}

export class TtsEngine {
  private readonly cache: AudioCache;

  constructor(
    cfg: AudioCacheConfig,
    private readonly transport: FishTransport,
    private readonly out: AudioOut,
  ) {
    this.cache = new AudioCache(cfg);
  }

  async speak(text: string, voice: VoiceId): Promise<{ cacheHit: boolean; startedMs: number; firstChunkMs?: number }> {
    // Sanitise before the cache lookup: two text variants of the same reply
    // must not become two cache entries, nor poison one.
    const clean = stripSpeechText(text);
    if (!isSpeakable(clean)) return { cacheHit: false, startedMs: 0, firstChunkMs: 0 };
    const cached = await this.cache.get(clean, voice);
    if (cached !== null) {
      const { startedMs } = await this.out.play(new Uint8Array(cached), voice);
      return { cacheHit: true, startedMs, firstChunkMs: 0 };
    }
    if (this.transport.synthesizeStream !== undefined && this.out.playStream !== undefined) {
      // Progressive path: first chunk flows to the sink before synthesis completes.
      const stream = this.transport.synthesizeStream(clean, VOICE_IDS[voice]);
      const started = Date.now();
      let firstChunkMs = -1;
      const collected: Uint8Array[] = [];
      const tee = async function* (): AsyncGenerator<Uint8Array> {
        for await (const chunk of stream) {
          if (firstChunkMs < 0) firstChunkMs = Date.now() - started;
          collected.push(chunk);
          yield chunk;
        }
      };
      const { startedMs } = await this.out.playStream(tee(), voice);
      const total = collected.reduce((n, p) => n + p.byteLength, 0);
      const audio = new Uint8Array(total);
      let offset = 0;
      for (const part of collected) {
        audio.set(part, offset);
        offset += part.byteLength;
      }
      await this.cache.set(clean, voice, audio);
      return { cacheHit: false, startedMs, firstChunkMs };
    }
    const audio = await this.transport.synthesize(clean, VOICE_IDS[voice]);
    await this.cache.set(clean, voice, audio);
    const { startedMs } = await this.out.play(audio, voice);
    return { cacheHit: false, startedMs };
  }

  cacheStats(): { size: number; hits: number; misses: number } {
    const stats = this.cache.stats();
    return { size: stats.size, hits: stats.hits, misses: stats.misses };
  }

  /**
   * Sentence-level streaming (directive 5): the first sentence is dispatched
   * to Fish Audio immediately — first-chunk TTFB tracks one short clause,
   * never the full paragraph — and each sentence plays as its audio lands.
   * The full-text cache is preserved: hits play whole, misses cache whole.
   */
  async speakSentences(
    text: string,
    voice: VoiceId,
  ): Promise<{ cacheHit: boolean; startedMs: number; firstChunkMs?: number; sentences: number }> {
    const started = Date.now();
    // Sanitise once, then split: sanitising per sentence would re-add terminal
    // punctuation that splitSentences is entitled to consume.
    const clean = stripSpeechText(text);
    const sentences = splitSentences(clean);
    const cached = await this.cache.get(clean, voice);
    if (cached !== null) {
      const { startedMs } = await this.out.play(new Uint8Array(cached), voice);
      return { cacheHit: true, startedMs, firstChunkMs: 0, sentences: sentences.length };
    }
    if (sentences.length === 0) {
      return { cacheHit: false, startedMs: Date.now() - started, sentences: 0 };
    }
    const collected: Uint8Array[] = [];
    let firstChunkMs = -1;
    for (const sentence of sentences) {
      const audio = await this.transport.synthesize(sentence, VOICE_IDS[voice]);
      if (firstChunkMs < 0) firstChunkMs = Date.now() - started;
      collected.push(audio);
      await this.out.play(audio, voice);
    }
    const total = collected.reduce((n, p) => n + p.byteLength, 0);
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const part of collected) {
      combined.set(part, offset);
      offset += part.byteLength;
    }
    // L2: skip the whole-reply cache entry when the blob is oversized, rather
    // than allocating and holding it. Playback is unaffected; only the cache is.
    if (total <= SPEECH_CACHE_MAX_ENTRY_BYTES) {
      await this.cache.set(clean, voice, combined);
    }
    return { cacheHit: false, startedMs: Date.now() - started, firstChunkMs, sentences: sentences.length };
  }
}
