import type { SanitizedErrorClass, TelemetryInput } from '../../telemetry/index.js';

// The LAYA producer for the diagnostics bus — `src/telemetry/writer.ts`.
//
// Finding (verified against writer.ts, not against a document): `SubsystemSchema`
// at `src/telemetry/writer.ts:36` has accepted `'LAYA'` since the schema was
// written, and nothing in `src/` ever produced one. The union member was an
// intention, not an observation. This module is that producer.
//
// Deliberate constraints, all inherited from writer.ts:
//
//  * There is NO transcript or utterance field in the schema (writer.ts:6-7 is
//    the anti-injection invariant). So this file never receives, stores or logs
//    the text a head scored. It receives a decision object and emits only
//    numbers and closed-union members. A telemetry row must never be able to
//    carry adversarial voice input into an agent's context.
//  * `errorCode` is OPTIONAL and this module refuses to invent one. The closed
//    union (writer.ts:38-61) has no LAYA member, and writer.ts:45-48 says in as
//    many words that reusing BRAIN_FAILED/STT_FAILED for a third subsystem
//    "would have put a lie in the data, which is the one thing this file must
//    not do". So a model that fails to load is reported as `CONFIG_INVALID`
//    (honest: the path is absent or unreadable) and everything else is reported
//    as `DEGRADED` with no code at all. `sanitizedErrorClass` is the union that
//    has honest LAYA members, and `OnnxError` (writer.ts:14) had no producer
//    before this file.
//  * Recording must never be able to break the voice loop. `emit` swallows
//    everything and returns, exactly like daemon.ts:293-299.

/**
 * The daemon's own `record` shape (daemon.ts:293: `Omit<TelemetryInput,
 * 'sessionId' | 'eventId'>`). Structural, so daemon.ts can pass its `record`
 * directly with no adapter and this module never touches the writer itself.
 */
export type LayaTelemetrySink = (input: Omit<TelemetryInput, 'sessionId' | 'eventId'>) => number | void;

export type LayaTelemetryRow = Omit<TelemetryInput, 'sessionId' | 'eventId'>;

/** Everything this module is allowed to know about a decision. No text, ever. */
export interface LayaTelemetryFacts {
  /** The engine is advisory, so its absence is DEGRADED, never ERROR. */
  readonly unavailable?: boolean;
  /** True when the model ran and every declared head scored. */
  readonly ok?: boolean;
  readonly latencyMs: number;
  readonly sanitizedErrorClass?: SanitizedErrorClass;
  /**
   * Heads that came back missing. A graph with no `logit_*` output scores 0.0
   * everywhere (laya-engine.ts:97-99), which downstream reads as "confidently
   * not destructive" — a silent contract drift, so DEGRADED, not OK.
   */
  readonly missingHeads?: readonly string[];
}

/** Build the row. Pure, so the mapping is testable with no daemon and no disk. */
export function layaTelemetryRow(facts: LayaTelemetryFacts): LayaTelemetryRow {
  if (facts.unavailable === true) {
    return {
      subsystem: 'LAYA',
      status: 'DEGRADED',
      latencyMs: facts.latencyMs,
      // A model the daemon was told to load and could not is a config fault.
      // BRAIN_FAILED here would be a lie about which subsystem broke.
      errorCode: 'CONFIG_INVALID',
      sanitizedErrorClass: facts.sanitizedErrorClass ?? 'OnnxError',
    };
  }
  const missing = facts.missingHeads ?? [];
  const status = facts.ok === true && missing.length === 0 ? 'OK' : 'DEGRADED';
  const row: {
    -readonly [K in keyof LayaTelemetryRow]: LayaTelemetryRow[K];
  } = { subsystem: 'LAYA', status, latencyMs: facts.latencyMs };
  if (missing.length > 0) {
    row.sanitizedErrorClass = 'ContractDrift';
  }
  if (facts.sanitizedErrorClass !== undefined) {
    row.sanitizedErrorClass = facts.sanitizedErrorClass;
  }
  return row;
}

/**
 * Emit one LAYA row. Swallows every throw: a diagnostics bus that can crash the
 * product is worse than no bus (daemon.ts:288-290).
 *
 * A null sink is the genuinely-unwired case (`loadLayaAdvisory({ sink: null })`),
 * so "no producer" is a decision rather than a crash.
 */
export function emitLayaTelemetry(sink: LayaTelemetrySink | null, facts: LayaTelemetryFacts): void {
  if (sink === null) return;
  try {
    sink(layaTelemetryRow(facts));
  } catch {
    // Deliberately swallowed. See the header.
  }
}
