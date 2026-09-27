import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { containsSecret } from '../common/logger.js';
import type { EventEnvelope } from './events.js';

// Append-before-effect ledger — docs/10 §10.1. Side effects are downstream of the
// append; secret-pattern content throws before write (fail-closed, never redacted).
export interface LedgerRow {
  readonly seq: number;
  readonly event: EventEnvelope;
  readonly receivedAt: string;
  readonly briefingEnqueued: boolean;
  readonly gap?: boolean;
  readonly duplicate?: boolean;
}

export class Ledger {
  private seq = 0;
  private readonly file: string;

  constructor(dataDir: string, day: string = new Date().toISOString().slice(0, 10)) {
    mkdirSync(join(dataDir, 'ledger'), { recursive: true });
    this.file = join(dataDir, 'ledger', `${day}.jsonl`);
  }

  append(row: Omit<LedgerRow, 'seq'>): LedgerRow {
    const full: LedgerRow = { ...row, seq: this.seq };
    const line = JSON.stringify(full);
    if (containsSecret(line)) {
      throw new Error('ledger refused secret-bearing row (fail-closed)');
    }
    const fd = openSync(this.file, 'a');
    try {
      writeSync(fd, line + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.seq += 1;
    return full;
  }

  writeSnapshot(dataDir: string, snapshot: unknown): void {
    const line = JSON.stringify(snapshot);
    if (containsSecret(line)) {
      throw new Error('ledger refused secret-bearing snapshot (fail-closed)');
    }
    const target = join(dataDir, 'snapshot.json');
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, line);
    if (existsSync(target)) {
      writeFileSync(`${target}.bak`, readFileSync(target));
    }
    renameSync(tmp, target);
  }
}
