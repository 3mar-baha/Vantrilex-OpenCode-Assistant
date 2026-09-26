import type { SessionId } from '../common/brands.js';
import { AudioIngest } from '../voice/ingest.js';

// Voice capture pipeline (P4): ingest windows → Whisper transcript → brain
// reply → session dispatch. Two fail-closed rules: an empty transcript spends
// nothing downstream (silence is free), and without an active session nothing
// is dispatched (no fabricated prompts). All collaborators are injected so the
// daemon wires real clients while tests use stubs.
export interface Utterance {
  readonly transcript: string;
  readonly reply: string;
  readonly receipt: string | null;
}

export interface AudioPipelineDeps {
  readonly ingest?: AudioIngest;
  transcribe(pcm: Uint8Array): Promise<string>;
  think(transcript: string): Promise<{ reply: string }>;
  dispatch(text: string): Promise<{ receipt: string }>;
  activeSessionId(): SessionId | undefined;
  onUtterance?(utterance: Utterance): void;
}

export class AudioPipeline {
  private readonly ingest: AudioIngest;
  private readonly deps: AudioPipelineDeps;

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

  reset(): void {
    this.ingest.reset();
  }

  async pushChunk(chunk: Uint8Array): Promise<void> {
    for (const window of this.ingest.push(chunk)) {
      const transcript = (await this.deps.transcribe(window)).trim();
      if (transcript.length === 0) continue;
      const { reply } = await this.deps.think(transcript);
      const session = this.deps.activeSessionId();
      const receipt = session === undefined ? null : (await this.deps.dispatch(transcript)).receipt;
      this.deps.onUtterance?.({ transcript, reply, receipt });
    }
  }
}