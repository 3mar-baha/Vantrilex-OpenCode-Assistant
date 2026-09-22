import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { nowIso } from '../common/brands.js';
import { OrchestratorError } from '../common/errors.js';

// Encrypted vault — docs/12 §12.2, docs/20 §20.5. Ciphertext-only VaultBlob on
// disk; machine-scoped key file (0600). Electron `safeStorage` is preferred when
// present (dynamic import, no hard dependency); otherwise AES-256-GCM.
export type KeyPool = 'groq' | 'fish';

export interface VaultBlob {
  readonly version: 1;
  readonly updatedAt: string;
  readonly pools: Record<KeyPool, { readonly nonce: string; readonly ciphertext: string; readonly checksum: string }>;
}

interface PoolSecrets {
  readonly keys: string[];
}

function machineKey(): Buffer {
  const keyPath = join(homedir(), '.opencode-voice-runtime', 'machine.key');
  if (existsSync(keyPath)) return readFileSync(keyPath);
  const key = randomBytes(32);
  mkdirSync(join(homedir(), '.opencode-voice-runtime'), { recursive: true });
  writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}

function appKey(): Buffer {
  return scryptSync(machineKey(), 'opencode-voice-runtime:vault:v1', 32);
}

function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function encryptPool(secrets: PoolSecrets): { nonce: string; ciphertext: string; checksum: string } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', appKey(), nonce);
  const plaintext = JSON.stringify(secrets);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([tag, encrypted]).toString('base64');
  return { nonce: nonce.toString('base64'), ciphertext: payload, checksum: sha256hex(payload) };
}

export function decryptPool(blob: { nonce: string; ciphertext: string; checksum: string }): PoolSecrets {
  if (sha256hex(blob.ciphertext) !== blob.checksum) {
    throw new OrchestratorError('VAULT_CORRUPT', false, 'vault checksum mismatch — pool refused');
  }
  try {
    const payload = Buffer.from(blob.ciphertext, 'base64');
    const tag = payload.subarray(0, 16);
    const encrypted = payload.subarray(16);
    const decipher = createDecipheriv('aes-256-gcm', appKey(), Buffer.from(blob.nonce, 'base64'));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(plaintext) as { keys?: unknown };
    if (!Array.isArray(parsed.keys) || parsed.keys.some((k) => typeof k !== 'string')) {
      throw new Error('bad shape');
    }
    return { keys: parsed.keys as string[] };
  } catch (err) {
    if (err instanceof OrchestratorError) throw err;
    throw new OrchestratorError('VAULT_CORRUPT', false, 'vault decrypt failed — pool refused');
  }
}

export class FileVault {
  constructor(private readonly path: string) {}

  load(): VaultBlob | null {
    if (!existsSync(this.path)) return null;
    const blob = JSON.parse(readFileSync(this.path, 'utf8') as string) as VaultBlob;
    if (blob.version !== 1 || typeof blob.pools !== 'object') {
      throw new OrchestratorError('VAULT_CORRUPT', false, 'vault version unsupported — pool refused');
    }
    return blob;
  }

  save(pools: Record<KeyPool, PoolSecrets>): VaultBlob {
    const blob: VaultBlob = {
      version: 1,
      updatedAt: nowIso(),
      pools: { groq: encryptPool(pools.groq), fish: encryptPool(pools.fish) },
    };
    mkdirSync(join(this.path, '..'), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(blob), { mode: 0o600 });
    renameSync(tmp, this.path);
    return blob;
  }

  /** First-boot migration: env pools → encrypted vault (operator then unsets env). */
  bootstrapFromEnv(env: NodeJS.ProcessEnv = process.env): VaultBlob | null {
    const groq = (env['GROQ_API_KEYS'] ?? '').split(',').map((k) => k.trim()).filter((k) => k.length > 0);
    const fish = (env['FISH_AUDIO_KEYS'] ?? '').split(',').map((k) => k.trim()).filter((k) => k.length > 0);
    if (groq.length === 0 || fish.length === 0) return null;
    return this.save({ groq: { keys: groq }, fish: { keys: fish } });
  }
}
