import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Microphone state machine — docs/02 §2.7, FR-11. Launch default Armed;
// mute-listen keeps briefings live while capture is off (Ambient Output Mode).
export type MicMode = 'armed' | 'disarmed' | 'mute-listen';

export class MicControl {
  private mode: MicMode = 'armed';

  constructor(private readonly persistDir?: string) {
    if (persistDir !== undefined) {
      const saved = this.readPersisted(persistDir);
      if (saved !== null) this.mode = saved;
    }
  }

  get current(): MicMode {
    return this.mode;
  }

  /** Left-click: instant Armed ↔ Disarmed toggle (mute-listen exits to Armed). */
  toggleArmed(): MicMode {
    this.mode = this.mode === 'armed' ? 'disarmed' : 'armed';
    this.persist();
    return this.mode;
  }

  setMuteListen(muted: boolean): MicMode {
    this.mode = muted ? 'mute-listen' : 'armed';
    this.persist();
    return this.mode;
  }

  /** Capture path consults this; briefings consult briefingsLive(). */
  get captureLive(): boolean {
    return this.mode === 'armed';
  }

  get briefingsLive(): boolean {
    return this.mode === 'armed' || this.mode === 'mute-listen';
  }

  private statePath(): string {
    return join(this.persistDir as string, 'mic-state.json');
  }

  private readPersisted(dir: string): MicMode | null {
    const path = join(dir, 'mic-state.json');
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8') as string) as { mode?: unknown };
      if (parsed.mode === 'armed' || parsed.mode === 'disarmed' || parsed.mode === 'mute-listen') return parsed.mode;
      return null;
    } catch {
      return null;
    }
  }

  private persist(): void {
    if (this.persistDir === undefined) return;
    mkdirSync(this.persistDir, { recursive: true });
    writeFileSync(this.statePath(), JSON.stringify({ mode: this.mode }));
  }
}
