import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { nowIso } from '../common/brands.js';
import { ownerOnlyAclAvailable } from './win-acl.js';
import { OrchestratorError } from '../common/errors.js';

// Encrypted vault — docs/12 §12.2, docs/20 §20.5. Ciphertext-only VaultBlob on
// disk; machine-scoped key file (0600). Electron `safeStorage` is preferred when
// present (dynamic import, no hard dependency); otherwise AES-256-GCM.
export const KEY_POOLS = ['groq', 'fish', 'openrouter'] as const;
export type KeyPool = (typeof KEY_POOLS)[number];

export interface VaultBlob {
  readonly version: 1;
  readonly updatedAt: string;
  readonly pools: Record<KeyPool, { readonly nonce: string; readonly ciphertext: string; readonly checksum: string }>;
}

interface PoolSecrets {
  readonly keys: string[];
}

// Warn once per process: machineKey() runs on every vault load, and a warning
// per load would drown the log it exists to produce.
let warnedAboutAcl = false;

/**
 * The 32-byte root secret every vault cipher is derived from.
 *
 * SUPPLIED BY THE RUST SUPERVISOR, not created here. The supervisor already owns
 * `write_protected_secret` and `restrict_to_owner`, and `SetNamedSecurityInfoW`
 * is the only way to express an owner-only DACL that does not lock the owner
 * out of the file — `icacls` was implemented here, measured, and removed for
 * exactly that reason. The supervisor passes the key as hex in
 * `VOXAURA_MACHINE_KEY`.
 *
 * The Node fallback is NOT equivalent and does not pretend to be: it creates the
 * file with a Unix mode Windows ignores, so a daemon run outside the supervisor
 * produces a key with no DACL. That is reported once rather than shipped as a
 * silent no-op, because the difference decides whether a profile's other users
 * can read the vault.
 */
function machineKey(): Buffer {
  const supplied = process.env['VOXAURA_MACHINE_KEY'];
  if (supplied !== undefined && supplied !== '') {
    const key = Buffer.from(supplied, 'hex');
    if (key.byteLength === 32) return key;
    // A wrong-length key would make every pool fail to decrypt with a checksum
    // error, which reads as vault corruption rather than a bad env var. Say what
    // is actually wrong instead.
    throw new OrchestratorError(
      'VAULT_CORRUPT',
      false,
      `VOXAURA_MACHINE_KEY is ${key.byteLength} bytes, expected 32`,
    );
  }

  const keyPath = join(homedir(), '.opencode-voice-runtime', 'machine.key');
  const acl = ownerOnlyAclAvailable();
  if (!acl.supported && !warnedAboutAcl) {
    warnedAboutAcl = true;
    process.emitWarning(
      `machine.key was created by the daemon with no owner-only DACL — ${acl.reason}. ` +
        'Run the app through the supervisor (or voxaura.exe) to have the Rust side create it properly.',
      'VoxauraVault',
    );
  }
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
    const encrypted = {} as Record<KeyPool, { readonly nonce: string; readonly ciphertext: string; readonly checksum: string }>;
    for (const pool of KEY_POOLS) encrypted[pool] = encryptPool(pools[pool]);
    const blob: VaultBlob = {
      version: 1,
      updatedAt: nowIso(),
      pools: encrypted,
    };
    mkdirSync(join(this.path, '..'), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(blob), { mode: 0o600 });
    renameSync(tmp, this.path);
    // The owner-only DACL is NOT applied here, and the earlier attempt to apply
    // it with `icacls` was removed because it produced a file nobody - including
    // the owner - could read, while reporting success. That is a worse outcome
    // than the exposure it claimed to remove: it would strand every saved
    // provider key. `win-acl.ts` holds the reproduction and the reasoning; the
    // real fix is to have the Rust supervisor create this file through
    // `write_protected_secret`, which fails closed and is already tested.
    return blob;
  }

  /** First-boot migration: env pools → encrypted vault (operator then unsets env). */
  bootstrapFromEnv(env: NodeJS.ProcessEnv = process.env): VaultBlob | null {
    const groq = (env['GROQ_API_KEYS'] ?? '').split(',').map((k) => k.trim()).filter((k) => k.length > 0);
    const fish = (env['FISH_AUDIO_KEYS'] ?? '').split(',').map((k) => k.trim()).filter((k) => k.length > 0);
    const openrouter = (env['OPENROUTER_API_KEYS'] ?? '').split(',').map((k) => k.trim()).filter((k) => k.length > 0);
    // Fail-closed 3-key mandate: every pool must be non-empty.
    if (groq.length === 0 || fish.length === 0 || openrouter.length === 0) return null;
    return this.save({ groq: { keys: groq }, fish: { keys: fish }, openrouter: { keys: openrouter } });
  }
}
