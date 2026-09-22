#!/usr/bin/env node
// Minimal operator CLI — docs/28 §28.1. Doctor runs the pre-flight gate;
// full command surface (sessions, vault, pair) lands with later milestones.
import { loadConfig } from './common/index.js';
import { probeHealth } from './launcher/index.js';

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

const command = process.argv[2];
if (command === 'doctor') {
  process.exit(await doctor());
} else {
  console.log('usage: opencode-voice doctor');
  process.exit(2);
}
