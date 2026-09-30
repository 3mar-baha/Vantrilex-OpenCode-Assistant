#!/usr/bin/env node
// Operator CLI — docs/28 §28.1. doctor: pre-flight gate. vault bootstrap:
// migrates comma pools from env into the encrypted file vault (then unset env).
// live: full provider round-trip (Fish TTS → Whisper STT → brain → TTS → play)
// with latency report. Key material never reaches stdout (redacting discipline).
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { loadConfig } from './common/index.js';
import { probeHealth } from './launcher/index.js';
import { FileVault } from './voice/vault.js';
import { readKeyPools, vaultKeyStatus } from './voice/key-store.js';
import { Keyring, withKey } from './voice/keyring.js';
import { GroqWhisperClient, transcribeStream } from './voice/stt.js';
import { OpenRouterBrainClient, requiresConfirmation } from './voice/brain.js';
import { ensureVault, resolveVaultRoot } from './memory/vault.js';
import { createFishTransport } from './voice/fish-ws.js';
import { TtsEngine, FileAudioOut } from './voice/tts.js';
import { loadConfig as loadFullConfig } from './common/config.js';
import { assertParity, buildIndex, verifyKnowledge } from './knowledge/index.js';
import { collectBundle, defaultBundleSources, parseDoctorFlags, renderBundle, type DoctorFlags } from './diag/bundle.js';

const VAULT_PATH = 'vault/keyring.dat';

async function doctor(): Promise<number> {
  const cfg = loadConfig();
  const names = ['OPENCODE_SERVER_PASSWORD', 'GROQ_API_KEYS', 'FISH_AUDIO_KEYS', 'OPENROUTER_API_KEYS'] as const;
  for (const name of names) {
    const set = (process.env[name] ?? '').length > 0;
    console.log(`${set ? 'ok  ' : 'miss'} ${name} ${set ? '(set, value hidden)' : '(unset)'}`);
  }
  // L16: env presence is NOT key availability. The vault is the single
  // credential source (docs/12 I-5), and a normal installed run has every pool
  // unset in env. Reporting `miss` for all three there described a working app
  // as broken. The vault counts are the truth; env is secondary.
  const verdict = vaultKeyStatus(readKeyPools(new FileVault(VAULT_PATH)));
  for (const line of verdict.lines) console.log(line);
  const password = process.env.OPENCODE_SERVER_PASSWORD ?? '';
  const alive = password.length > 0 && (await probeHealth(cfg.serve.port, password));
  console.log(`${alive ? 'ok  ' : 'miss'} serve 127.0.0.1:${cfg.serve.port} ${alive ? '(healthy)' : '(unreachable)'}`);
  console.log(`info voice=${cfg.voice.default} briefings=${cfg.briefings} mic=${cfg.capture.micDefault}`);
  return alive && verdict.ok ? 0 : 1;
}

/**
 * `doctor --bundle` (M5) — one redacted JSON artifact for a public ticket.
 *
 * The no-flag path is deliberately NOT routed through here: `doctor()` above is
 * invoked unchanged, because a diagnostics flag that alters the existing output
 * is a regression wearing a feature's clothes. `parseDoctorFlags` decides which
 * of the two runs, and its `legacy` verdict is unit-tested.
 *
 * Exits 0 healthy · 1 degraded-but-collected · 2 collection-failed. `cli.ts`
 * already exits 2 for bad usage, so the JSON body carries `outcome` and `tool`
 * to tell the two apart; a usage error is not a bundle at all.
 */
async function doctorBundle(flags: DoctorFlags): Promise<number> {
  if (flags.error !== null) {
    console.log(JSON.stringify({ tool: 'voxaura-doctor-bundle', schemaVersion: 1, outcome: 'usage-error', error: flags.error, unknown: flags.unknown }, null, 2));
    return 2;
  }
  const result = await collectBundle(
    defaultBundleSources({
      env: process.env,
      cwd: process.cwd(),
      home: homedir(),
      readTextFile: (file) => {
        try {
          return readFileSync(file, 'utf8');
        } catch {
          return null;
        }
      },
    }),
  );
  const text = `${renderBundle(result.bundle)}\n`;
  if (flags.out !== null) {
    try {
      writeFileSync(flags.out, text);
    } catch (err) {
      // The artifact is the deliverable, so failing to write it is a collection
      // failure — and the bundle still goes to stdout rather than being lost.
      console.log(text);
      console.error(`doctor: could not write ${flags.out}: ${err instanceof Error ? err.message : 'unknown'}`);
      return 2;
    }
  }
  console.log(text.trimEnd());
  return result.exitCode;
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
    console.log('miss vault: GROQ_API_KEYS, FISH_AUDIO_KEYS and OPENROUTER_API_KEYS all required (env or .env.local)');
    return 1;
  }
  const groqCount = (process.env['GROQ_API_KEYS'] ?? '').split(',').filter((k) => k.length > 0).length;
  const fishCount = (process.env['FISH_AUDIO_KEYS'] ?? '').split(',').filter((k) => k.length > 0).length;
  const openrouterCount = (process.env['OPENROUTER_API_KEYS'] ?? '').split(',').filter((k) => k.length > 0).length;
  console.log(`ok   vault: encrypted ${groqCount} groq + ${fishCount} fish + ${openrouterCount} openrouter keys -> ${VAULT_PATH} (counts only, zero material)`);
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

      // 1. Fish TTS of the Ammani test phrase (uses keyring internally).
      const cfg = loadFullConfig();
      // `TTS_TRANSPORT=ws` measures the live WS transport against the HTTP one;
      // unset it and this is FishHttpTransport again.
      const transport = createFishTransport(ring);
      const out = new FileAudioOut();
      const engine = new TtsEngine(cfg.cache, transport, out);
      const ttsStart = Date.now();
      // Production speech path: sentence-streamed (first clause out ASAP).
      // Two-sentence probe so the report proves per-sentence dispatch live.
      const first = await engine.speakSentences('أمورك تمام. هذا اختبار الصوت!', cfg.voice.default);
      report['tts_ms'] = Date.now() - ttsStart;
      report['tts_first_chunk_ms'] = first.firstChunkMs ?? 'n/a-buffered';
      report['tts_cache_hit'] = first.cacheHit ? 'yes' : 'no';
      report['tts_sentences'] = first.sentences;

      // 2. Whisper STT round-trip on a generated 1s silent PCM (latency probe).
      const silent = new Uint8Array(16_000 * 2);
      const sttStart = Date.now();
      // L17: the key is held across the call and released with its real status,
      // so a revoked Groq key advances the pool instead of being retried.
      const transcript = await withKey(ring, 'groq', (key) =>
        transcribeStream(silent, new GroqWhisperClient(Buffer.from(key.material).toString('utf8'))),
      );
      report['stt_ms'] = Date.now() - sttStart;
      report['stt_chunks'] = transcript.chunkCount;
      report['stt_text_len'] = transcript.text.length;

      // 3. Brain round-trip via OpenRouter (fixed digestive prompt; latency + budget verdict).
      // Key from the vault pool — the single source; fail-closed when absent.
      const brainStart = Date.now();
      const { output, elapsedMs, goldenBreached } = await withKey(ring, 'openrouter', (key) =>
        new OpenRouterBrainClient(Buffer.from(key.material).toString('utf8')).respond(
          'اختبار حي: التيستات خضرا',
          'live verification session',
        ),
      );
      void brainStart;
      report['brain_ms'] = elapsedMs;
      report['brain_golden_2s'] = goldenBreached ? 'BREACHED' : 'within';
      report['brain_intent'] = output.intent;
      report['destructive_gate_armed'] = String(requiresConfirmation(output.reply));

      // 4. Speak the brain reply (real TTS + file handoff for speaker playback).
      const replyStart = Date.now();
      await engine.speakSentences(output.reply.slice(0, 200), cfg.voice.default);
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

// Daemon: adopt the running serve and host the WS-4097 control plane.
async function serveDaemon(): Promise<number> {
  loadDotEnvLocal();
  const { startDaemon, vaultPathFromEnv, ipcTokenFromEnv, ensureIpcToken } = await import('./daemon.js');
  const cfg = loadConfig();
  const password = process.env['OPENCODE_SERVER_PASSWORD'] ?? '';
  const token = ipcTokenFromEnv() || ensureIpcToken();
  const ipcPort = Number.parseInt(process.env['VOICE_IPC_PORT'] ?? '4097', 10);
  if (password.length === 0) {
    console.log('miss serve: OPENCODE_SERVER_PASSWORD is required');
    return 1;
  }
  try {
    const daemon = await startDaemon({
      servePort: cfg.serve.port,
      servePassword: password,
      ipcToken: token,
      ipcPort,
      vaultPath: vaultPathFromEnv(),
      directory: process.cwd(),
    });
    console.log(`ok   daemon: ws=127.0.0.1:${daemon.ipcPort} serve=${daemon.servePort} (token redacted)`);
    // Serve health, for free, because the handle exposes the live monitor. Printed
    // ONCE at start rather than polled: this line's job is to prove the wiring is
    // live and to name the state machine an operator will see in the UI, and a
    // repeating line in a long-running process is a line nobody reads.
    //
    // `healthy` here is the monitor's post-boot state, which the boot probe at
    // `daemon.ts:263` already proved — so this is a wiring assertion, not new
    // evidence. If it ever reads anything else, that is worth seeing on stderr.
    const serveHealth = daemon.serveHealth.status();
    console.log(
      `info serve-health: ${serveHealth.state}` +
        (serveHealth.state === 'healthy' ? '' : ` detail=${serveHealth.lastFault ?? 'unknown'} attempts=${serveHealth.attempts}`),
    );
    console.log('next: Ctrl+C to stop');
    await new Promise<void>((resolve) => {
      const stop = (): void => resolve();
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    });
    await daemon.stop();
    return 0;
  } catch (err) {
    console.log(`miss daemon: ${err instanceof Error ? err.message : 'unknown'}`);
    return 1;
  }
}

const command = process.argv[2];
// Self-bootstrap the Obsidian memory vault on first boot (portability
// invariant): missing notes are scaffolded; failures never block the CLI.
// Memory-vault bootstrap is an OPERATOR concern. `serve` is a long-running
// daemon that may be launched from an arbitrary working directory (an installed
// build runs with cwd = its own folder), so scaffolding notes there would litter
// the filesystem — it must never create the memory graph implicitly.
const OPERATOR_COMMANDS = new Set(['doctor', 'vault', 'live']);
if (command !== undefined && OPERATOR_COMMANDS.has(command)) {
  try {
    // Canonical memory graph: VOXAURA_VAULT_DIR when set, else <cwd>/vault —
    // the same root the daemon uses for keyring.dat, so keys and notes share
    // one vault.
    ensureVault('voxaura', resolveVaultRoot());
  } catch {
    // Fresh installs without a writable cwd proceed without memory notes.
  }
}
/**
 * `knowledge` — inspect the shared ground truth and prove the parity invariant.
 *
 * Exists so the knowledge layer is reachable from a composition root rather than
 * sitting as a library nobody imports, and so the parity claim is checkable from
 * a shell instead of only from a test log. Optionally takes a query:
 *   node dist/cli.js knowledge "المنفذ 4096"
 * Exits non-zero if Tier 1 is asymmetric, so it can gate a release.
 */
function knowledgeReport(): number {
  try {
    assertParity();
  } catch (err) {
    console.error(`knowledge: PARITY VIOLATION — ${(err as Error).message}`);
    return 1;
  }
  const report = verifyKnowledge();
  const index = buildIndex();
  console.log('knowledge: shared ground truth (Tier 1)');
  console.log(`  shared chunks : ${report.sharedChunks}`);
  console.log(`  digest        : ${report.digest}`);
  console.log(`  index size    : ${index.size}`);
  console.log(`  nour examples : ${report.nourExamples}`);
  console.log(`  kareem examples: ${report.kareemExamples}`);
  console.log(`  persona leaks : ${report.personaKeyLeaks}`);
  console.log(`  style asymmetries: ${report.styleIdAsymmetries}`);

  const query = process.argv[3];
  if (query !== undefined && query.length > 0) {
    console.log(`  query "${query}":`);
    for (const hit of index.search(query, 3)) {
      console.log(`    ${hit.score.toFixed(3)}  ${hit.id}  (${hit.source})`);
    }
  }
  return 0;
}

if (command === 'doctor') {
  const flags = parseDoctorFlags(process.argv.slice(3));
  process.exit(flags.legacy ? await doctor() : await doctorBundle(flags));
} else if (command === 'vault' && process.argv[3] === 'bootstrap') {
  process.exit(await vaultBootstrap());
} else if (command === 'live') {
  process.exit(await liveLoop());
} else if (command === 'serve') {
  process.exit(await serveDaemon());
} else if (command === 'knowledge') {
  process.exit(knowledgeReport());
} else {
  console.log('usage: opencode-voice doctor | vault bootstrap | live | serve | knowledge');
  process.exit(2);
}
