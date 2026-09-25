#!/usr/bin/env node
// Key inventory report — verifies which credentials are present WITHOUT ever
// printing their value. For each provider it reports the storage source, the
// byte length, and a truncated SHA-256 fingerprint you can compare against the
// provider dashboard. Raw secrets never reach stdout, logs, or shell history.
//
//   node scripts/key-report.mjs
//
// Safe by construction: no key material is written to disk or console.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileVault, decryptPool } from '../dist/voice/vault.js';

const ROOT = process.cwd();
const PROVIDERS = ['groq', 'fish', 'openrouter'];

function fingerprint(secret) {
  return `sha256:${createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 10)}`;
}

function readDotEnvLocal() {
  const path = join(ROOT, '.env.local');
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (value.length > 0) out[key] = value;
  }
  return out;
}

const env = readDotEnvLocal();

// Vault pools (authoritative when present).
const vaultPools = {};
const vaultPath = join(ROOT, 'vault', 'keyring.dat');
if (existsSync(vaultPath)) {
  try {
    const vault = new FileVault(vaultPath);
    const blob = vault.load();
    if (blob !== null) {
      for (const pool of PROVIDERS) {
        const entry = blob.pools?.[pool];
        if (entry === undefined) continue;
        try {
          vaultPools[pool] = decryptPool(entry).keys;
        } catch {
          vaultPools[pool] = ['<undecryptable on this machine>'];
        }
      }
    }
  } catch {
    // Vault unreadable here; env fallback below still reports presence.
  }
}

const envNames = { groq: 'GROQ_API_KEYS', fish: 'FISH_AUDIO_KEYS', openrouter: 'OPENROUTER_API_KEYS' };

console.log('Voxaura key inventory (values are never printed)');
console.log('='.repeat(58));
for (const provider of PROVIDERS) {
  const pooled = vaultPools[provider] ?? [];
  const envRaw = env[envNames[provider]] ?? '';
  const envKeys = envRaw.split(',').map((k) => k.trim()).filter((k) => k.length > 0);
  const source = pooled.length > 0 ? `vault/keyring.dat` : envKeys.length > 0 ? '.env.local' : 'none';
  const count = pooled.length > 0 ? pooled.length : envKeys.length;
  const list = pooled.length > 0 ? pooled : envKeys;
  const first = list[0];
  const detail =
    count === 0
      ? 'MISSING'
      : first !== undefined && first.startsWith('<')
        ? first
        : `len=${first?.length ?? 0} ${first !== undefined ? fingerprint(first) : ''}`;
  console.log(`${(provider + ':').padEnd(12)} ${String(count).padStart(2)} key(s)  source=${source.padEnd(16)} ${detail}`);
}
console.log('='.repeat(58));
console.log('Fingerprints are truncated SHA-256 of the secret: compare them with');
console.log('your provider dashboard to confirm the stored key, without exposing it.');