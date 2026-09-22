import pino from 'pino';
import type { OrchestratorConfig } from './config.js';

// Secret-redacting logger — docs/12-SECURITY.md I-2. Redaction runs on every
// written value; the ledger writer additionally throws on pattern match (fail-closed).
const SECRET_PATTERNS: RegExp[] = [
  /sk-fish-[A-Za-z0-9]+/g,
  /gsk_[A-Za-z0-9]+/g,
  /Bearer\s+[^\s"']+/gi,
  /password\s*[:=]\s*[^\s"'}]+/gi,
];

export function redactSecrets(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

export function containsSecret(input: string): boolean {
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(input);
  });
}

export function createLogger(level: OrchestratorConfig['logLevel'] = 'info') {
  return pino({
    level,
    hooks: {
      logMethod(inputArgs, method, levelNumber) {
        const redacted = inputArgs.map((arg) =>
          typeof arg === 'string' ? redactSecrets(arg) : arg,
        );
        method.apply(this, [redacted, levelNumber] as unknown as Parameters<typeof method>);
      },
    },
  });
}
