import { z } from 'zod';
import type { AudioCacheConfig } from '../voice/cache.js';
import type { VoiceId } from './brands.js';

// Orchestrator configuration — see docs/05 §5.7 and docs/03 §3.6.
export interface OrchestratorConfig {
  readonly serve: { readonly hostname: '127.0.0.1'; readonly port: number };
  readonly voice: {
    readonly default: VoiceId;
    readonly brainGoldenMs: 2000;
    readonly brainCeilingMs: 5000;
    readonly sttModel: 'whisper-large-v3-turbo';
    readonly ttsModel: 's2.1-pro-free';
  };
  readonly cache: AudioCacheConfig;
  readonly capture: { readonly mode: 'push-to-talk' | 'wake-word'; readonly micDefault: 'armed' | 'disarmed' };
  readonly briefings: 'bluf' | 'full';
  readonly quietHours: string;
  readonly muteOnCall: boolean;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
}

const ConfigSchema = z.object({
  OPENCODE_PORT: z.coerce.number().int().positive().default(4096),
  VOICE_DEFAULT: z.enum(['male-default', 'female-toggle']).default('male-default'),
  TTS_CACHE_SIZE: z.coerce.number().int().positive().max(50).default(50),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  CAPTURE_MODE: z.enum(['push-to-talk', 'wake-word']).default('push-to-talk'),
  BRIEFINGS: z.enum(['bluf', 'full']).default('bluf'),
  QUIET_HOURS: z.string().default('22:00-07:00'),
  MUTE_ON_CALL: z.enum(['on', 'off']).default('on'),
  MIC_DEFAULT: z.enum(['armed', 'disarmed']).default('armed'),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): OrchestratorConfig {
  const parsed = ConfigSchema.parse(env);
  return {
    serve: { hostname: '127.0.0.1', port: parsed.OPENCODE_PORT },
    voice: {
      default: parsed.VOICE_DEFAULT,
      brainGoldenMs: 2000,
      brainCeilingMs: 5000,
      sttModel: 'whisper-large-v3-turbo',
      ttsModel: 's2.1-pro-free',
    },
    cache: {
      dir: 'audio-cache',
      maxEntries: 50,
      maxBytes: 64 * 1024 * 1024,
      maxEntryBytes: 4 * 1024 * 1024,
    },
    capture: { mode: parsed.CAPTURE_MODE, micDefault: parsed.MIC_DEFAULT },
    briefings: parsed.BRIEFINGS,
    quietHours: parsed.QUIET_HOURS,
    muteOnCall: parsed.MUTE_ON_CALL === 'on',
    logLevel: parsed.LOG_LEVEL,
  };
}
