# 18 — Voice Pipeline: STT Chunking, Ammani Brain, Fish TTS Streaming & LRU Cache

> **Canonical status:** Voice/distribution batch. Pipeline truth for FR-5/FR-6/FR-7.
> Wire formats: `06` §6.4–§6.6 · Types: `05` §5.1/§5.4 · Budgets: `01` NFR-1/2/3.

## 18.1 — Pipeline Overview

```mermaid
flowchart LR
    MIC(["Mic\npush-to-talk"]) --> CH["chunker\n5s win / 0.5s overlap"] --> STT["Whisper\nlarge-v3-turbo\np50 <500ms"]
    STT --> TX["transcript\nbilingual verbatim\n+ correction window"]
    TX --> BR["brain\ngpt-oss-120b\n2.0s / 5.0s"]
    BR --> OUT["intent + Ammani reply\n(validated JSON)"]
    OUT --> CACHE{"LRU-50 hit?"}
    CACHE -->|hit| PLAY["play blob\n<50ms"]
    CACHE -->|miss| TTS["Fish s2.1-pro-free\nstream, first-chunk <800ms"]
    TTS --> STORE["store blob\n(evict LRU)"] --> PLAY
    PLAY --> SPK(["Speaker\nno focus APIs"])
```

Stage budgets are end-to-end additive worst case, but STT streams while the user still
speaks and TTS streams while the brain text is final — perceived latency is dominated
by the brain's 2.0 s golden path.

## 18.2 — STT: Groq Whisper Audio Chunking (normative)

1. **Capture:** push-to-talk (default) or wake-word gate; 16 kHz mono PCM; capture
   indicator always visible (`02` §2.2).
2. **Chunking:** 5.0 s windows, 0.5 s overlap, `≤ 25 MB` per multipart part.
   Overlap regions dedupe by `verbose_json` word timestamps — words fully inside the
   overlap's second half win; boundary words merge on timestamp equality (±40 ms).
3. **Request:** multipart per `06` §6.4, `language: ar` hint. Code-switching is
   expected: Arabic narrative in dialect, code/log tokens verbatim English.
4. **Stitch + correct:** concatenated transcript shown on CLI for a 3 s correction
   window (`02` §2.4); "no, I meant…" replaces pre-dispatch, else follow-up prompts.
5. **Failure:** per-chunk retry ×2, then `STT_FAILED` → "didn't catch that" (once) →
   text fallback (`02` §2.6). Latency proof: 200-utterance harness, p50 < 500 ms (`11` §11.3).

```ts
// src/voice/stt.ts — chunk descriptor
export interface AudioChunk {
  readonly index: number;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
  readonly bytes: Uint8Array;          // 16kHz mono PCM slice
  readonly overlapMs: 500;
}
export interface Transcript {
  readonly text: string;               // stitched, bilingual verbatim
  readonly language: string;           // provider-detected, informational
  readonly chunkCount: number;
  readonly roundTripMs: number;        // capture-end → transcript-ready
}
```

## 18.3 — Brain: Ammani Arabic Prompt System for `gpt-oss-120b` (normative)

### 18.3.1 System prompt (canonical shape — full text lives in `src/voice/prompts/ammani.system.md`)

```
You are the voice of the developer's ambient coding orchestrator.
Spoken output: authentic Ammani Jordanian Arabic (العامية الأردنية العمانية) —
natural, warm, concise. NEVER Modern Standard Arabic newsreader style.
Technical spans (code identifiers, file paths, log excerpts, error codes, session
names, CLI commands) stay in technical English, read with English pronunciation.
Never transliterate code into Arabic script. Never translate error codes.
Briefings: BLUF first — outcome + session identity in ≤ 15 spoken words, then at
most 3 change-clauses, then one next-action sentence. Total ≤ 45 spoken seconds.
Classify every input into exactly one intent: newSession | followUp | control.
Reply ONLY with the JSON shape below. No prose outside JSON.
```

### 18.3.2 Model call

`openai/gpt-oss-120b` on Groq, `temperature 0.4`, `max_tokens 300`, `stream: false`
(wire shape in `06` §6.5). Client-side timer: soft flag at 2.0 s (ledger mark only),
hard abort at 5.0 s → `BRAIN_TIMEOUT` → fallback briefing. Key via keyring `groq`
pool (`acquire`/`release`, `20`).

### 18.3.3 Output schema (validated before any speech — invalid output = fallback, never raw speech)

```ts
export const BrainOutputSchema = z.object({
  intent: z.enum(['newSession', 'followUp', 'control']),
  control: z.enum(['approve', 'cancel', 'repeat', 'switchVoice', 'none']).default('none'),
  reply: z.string().min(1).max(1200),       // Ammani narrative + EN technical spans
  sessionDirective: z.string().optional(),  // prompt text when intent ≠ control
});
export type BrainOutput = z.infer<typeof BrainOutputSchema>;
```

### 18.3.4 Language audit

Every release runs the 100-briefing audit (`11` §11.5): zero non-technical English in
narrative spans; zero Arabic script inside code spans. Regressions block the gate.

## 18.4 — TTS: Fish Audio Streaming Integration (normative)

1. **Cache first:** key `sha256(normalize(text) + '|' + fishVoiceId)`; hit → play blob
   (< 50 ms), no provider call, no keyring acquisition.
2. **Synthesize:** `POST` streaming per `06` §6.6, model `s2.1-pro-free`, voice from
   `VOICE_IDS` (`05` §5.1). Active voice = operator toggle (`male-default` default);
   toggle applies at the next utterance boundary, never mid-word.
3. **Playback:** start on first chunk (p50 < 800 ms after text ready); stream to the
   background audio path — no window handles, no focus calls (`02` §2.2).
4. **Persist:** completed blobs within size cap enter the LRU (`set()` evicts
   synchronously, §18.5). Oversize single clips play but are never cached.
5. **Failure:** `TTS_FAILED` / 429 → forced keyring rollover + one retry → still red:
   log-first briefing + cached-phrase playback; operator notified once (E-7).

## 18.5 — 50-Item LRU Cache Implementation (normative)

```ts
// src/voice/cache.ts — backed by `lru-cache`, filesystem blob store
import { LRUCache } from 'lru-cache';

export class AudioCache {
  private readonly lru: LRUCache<string, AudioCacheEntry>;
  constructor(private readonly cfg: AudioCacheConfig) {
    this.lru = new LRUCache<string, AudioCacheEntry>({
      max: 50,                                   // entry bound (hard)
      maxSize: cfg.maxBytes,                     // byte bound (hard)
      sizeCalculation: (e) => e.bytes,
      dispose: (e) => void unlinkBlob(e.blobPath), // eviction deletes bytes
      updateAgeOnGet: true,                      // lastHitAt = recency
    });
  }
  async get(text: string, voice: VoiceId): Promise<Uint8Array | null> {
    const key = cacheKey(text, voice);           // sha256(normalized + voiceId)
    const hit = this.lru.get(key);
    if (!hit) { stats.misses++; return null; }
    hit.hits++; hit.lastHitAt = nowIso(); stats.hits++;
    return readBlob(hit.blobPath);
  }
  async set(text: string, voice: VoiceId, audio: Uint8Array): Promise<void> {
    if (audio.byteLength > this.cfg.maxEntryBytes) return; // play-only, never cache
    const entry: AudioCacheEntry = { … };
    this.lru.set(entry.key, entry);              // eviction runs synchronously here
    await writeBlob(entry.blobPath, audio);
  }
}
```

Normalization before hashing: trim, collapse whitespace, unify Arabic presentation
forms + field stops — so "done." and "done" hit separately (punctuation is prosody),
but invisible Unicode differences never cause misses. Stats (`05` §5.4
`AudioCacheStats`) are exposed to the showcase dashboard (`22`).

---

*End of `18-VOICE-PIPELINE.md`. Next: `19-MOBILE-PAIRING.md`.*
