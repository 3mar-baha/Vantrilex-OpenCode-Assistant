#!/usr/bin/env node
// Operator CLI — docs/28 §28.1. doctor: pre-flight gate. vault bootstrap:
// migrates comma pools from env into the encrypted file vault (then unset env).
// live: full provider round-trip (Fish TTS → Whisper STT → brain → TTS → play)
// with latency report. Key material never reaches stdout (redacting discipline).
import { readFileSync } from 'node:fs';
import { loadConfig } from './common/index.js';
import { probeHealth } from './launcher/index.js';
import { FileVault } from './voice/vault.js';
import { Keyring } from './voice/keyring.js';
import { GroqWhisperClient, transcribeStream } from './voice/stt.js';
import { GroqBrainClient, requiresConfirmation } from './voice/brain.js';
import { FishHttpTransport, TtsEngine, FileAudioOut } from './voice/tts.js';
import { loadConfig as loadFullConfig } from './common/config.js';

const VAULT_PATH = 'vault/keyring.dat';

async function doctor(): Promise<number> {
  const cfg = loadConfig();
  const names = ['OPENCODE_SERVER_PASSWORD', 'GROQ_API_KEYS', 'FISH_AUDIO_KEYS'] as const;
  for (const name of names) {
    const set = (process.env[name] ?? '').length > 0;
    console.log(`${set ? 'ok  ' : 'miss'} ${name} ${set ? '(set, value hidden)' : '(unset)'}`);
  }
  const password = process.env.OPENCODE_SERVER_PASSWORD ?? '';
  const alive = password.length > 0 && (await probeHealth(cfg.serve.port, password));
  console.log(`${alive ? 'ok  ' : 'miss'} serve 127.0.0.1:${cfg.serve.port} ${alive ? '(healthy)' : '(unreachable)'}`);
  console.log(`info voice=${cfg.voice.default} briefings=${cfg.briefings} mic=${cfg.capture.micDefault}`);
  return alive ? 0 : 1;
}

function loadDotEnvLocal(): void {
  try {
    const text = readFileSync('.env.local', 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (process.env[key] === undefined || process.env[key] === '') {
        process.env[key] = value;
      }
    }
  } catch {
    // No local env file — vault or environment must supply keys.
  }
}

async function vaultBootstrap(): Promise<number> {
  loadDotEnvLocal();
  const vault = new FileVault(VAULT_PATH);
  const blob = vault.bootstrapFromEnv();
  if (blob === null) {
    console.log('miss vault: GROQ_API_KEYS and FISH_AUDIO_KEYS both required (env or .env.local)');
    return 1;
  }
  const groqCount = (process.env['GROQ_API_KEYS'] ?? '').split(',').filter((k) => k.length > 0).length;
  const fishCount = (process.env['FISH_AUDIO_KEYS'] ?? '').split(',').filter((k) => k.length > 0).length;
  console.log(`ok   vault: encrypted ${groqCount} groq + ${fishCount} fish keys -> ${VAULT_PATH} (counts only, zero material)`);
  console.log('next: unset env pools — the vault is now the single source');
  return 0;
}

async function liveLoop(): Promise<number> {
  const started = Date.now();
  const report: Record<string, number | string> = {};
  try {
    const vault = new FileVault(VAULT_PATH);
    const ring = Keyring.load(vault);
    try {
      const groqKey = ring.acquire('groq');
      const groqApiKey = Buffer.from(groqKey.material).toString('utf8');
      ring.release(groqKey, true);
      const fishKey = ring.acquire('fish');
      const fishApiKey = Buffer.from(fishKey.material).toString('utf8');
      void fishApiKey;
      ring.release(fishKey, true);

      // 1. Fish TTS of the Ammani test phrase (uses keyring internally).
      const cfg = loadFullConfig();
      const transport = new FishHttpTransport(ring);
      const out = new FileAudioOut();
      const engine = new TtsEngine(cfg.cache, transport, out);
      const ttsStart = Date.now();
      const first = await engine.speak('أمورك تمام، هذا اختبار الصوت', cfg.voice.default);
      report['tts_ms'] = Date.now() - ttsStart;
      report['tts_first_chunk_ms'] = first.firstChunkMs ?? 'n/a-buffered';
      report['tts_cache_hit'] = first.cacheHit ? 'yes' : 'no';

      // 2. Whisper STT round-trip on a generated 1s silent PCM (latency probe).
      const whisper = new GroqWhisperClient(groqApiKey);
      const silent = new Uint8Array(16_000 * 2);
      const sttStart = Date.now();
      const transcript = await transcribeStream(silent, whisper);
      report['stt_ms'] = Date.now() - sttStart;
      report['stt_chunks'] = transcript.chunkCount;
      report['stt_text_len'] = transcript.text.length;

      // 3. Brain round-trip (fixed digestive prompt; latency + budget verdict).
      const brain = new GroqBrainClient(groqApiKey);
      const brainStart = Date.now();
      const { output, elapsedMs, goldenBreached } = await brain.respond(
        'اختبار حي: التيستات خضرا',
        'live verification session',
      );
      void brainStart;
      report['brain_ms'] = elapsedMs;
      report['brain_golden_2s'] = goldenBreached ? 'BREACHED' : 'within';
      report['brain_intent'] = output.intent;
      report['destructive_gate_armed'] = String(requiresConfirmation(output.reply));

      // 4. Speak the brain reply (real TTS + file handoff for speaker playback).
      const replyStart = Date.now();
      await engine.speak(output.reply.slice(0, 200), cfg.voice.default);
      report['reply_tts_ms'] = Date.now() - replyStart;
    } finally {
      ring.destroy();
    }
    report['total_ms'] = Date.now() - started;
    report['budgets'] = 'stt<500ms brain_p50<=2000ms ceiling=5000ms tts_first_chunk<800ms';
    console.log(JSON.stringify(report, null, 2));
    return 0;
  } catch (err) {
    console.log(JSON.stringify({ ok: false, partial: report, error: err instanceof Error ? err.message : 'unknown' }));
    return 1;
  }
}

const command = process.argv[2];
if (command === 'doctor') {
  process.exit(await doctor());
} else if (command === 'vault' && process.argv[3] === 'bootstrap') {
  process.exit(await vaultBootstrap());
} else if (command === 'live') {
  process.exit(await liveLoop());
} else {
  console.log('usage: opencode-voice doctor | vault bootstrap | live');
  process.exit(2);
}
