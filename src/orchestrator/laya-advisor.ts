import type { LayaDecision } from '../runtime/laya/laya-engine.js';
import type { SpeechAdvisor } from './orchestrator.js';

/** Minimal engine surface the advisor needs — keeps the adapter testable and
 * decoupled from onnxruntime-node (LayaEngine satisfies it structurally). */
export interface AdvisorEngine {
  decide(text: string): Promise<LayaDecision>;
}

/**
 * Bridges the local Laya System-1 engine (docs/09 ADR-008) to the orchestrator's
 * advisory gate. Advisory-only: `shouldSpeak` can silence a T1 briefing, and
 * `isDestructive` is a signal for the FR-12 confirmation path — it never acts on
 * its own. Any engine failure propagates; the orchestrator defaults to speaking.
 */
export class LayaSpeechAdvisor implements SpeechAdvisor {
  constructor(
    private readonly engine: AdvisorEngine,
    private readonly shouldSpeakThreshold = 0.5,
    private readonly destructiveThreshold = 0.5,
  ) {}

  async shouldSpeak(text: string): Promise<boolean> {
    const decision = await this.engine.decide(text);
    return decision.scores.should_speak >= this.shouldSpeakThreshold;
  }

  async isDestructive(text: string): Promise<boolean> {
    const decision = await this.engine.decide(text);
    return decision.scores.is_destructive >= this.destructiveThreshold;
  }

  /** Raw destructive score for the orchestrator's FR-12 band policy. */
  async destructiveScore(text: string): Promise<number> {
    const decision = await this.engine.decide(text);
    return decision.scores.is_destructive;
  }
}