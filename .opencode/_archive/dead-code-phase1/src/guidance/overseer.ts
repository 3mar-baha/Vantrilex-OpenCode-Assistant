import { nowIso } from '../common/brands.js';

// Session overseer — docs/17 §17.6. Away-mode agency: advance the active plan
// milestone by milestone with peer judgment; with no plan or at completion, halt
// cleanly and suggest /prompt-master. Stops only at safety boundaries.
export interface PlanMilestone {
  readonly id: string;
  readonly title: string;
  status: 'pending' | 'active' | 'done';
}

export type OverseerDecision =
  | { readonly action: 'advance'; readonly milestone: PlanMilestone }
  | { readonly action: 'halt'; readonly reason: string; readonly suggestion: string };

export class SessionOverseer {
  private failures = 0;

  constructor(private readonly milestones: PlanMilestone[]) {}

  /** Advance one step; returns the decision (halt includes the /prompt-master nudge). */
  step(): OverseerDecision {
    const active = this.milestones.find((m) => m.status === 'active');
    if (active !== undefined) return { action: 'advance', milestone: active };
    const next = this.milestones.find((m) => m.status === 'pending');
    if (next === undefined) {
      return {
        action: 'halt',
        reason: this.milestones.length === 0 ? 'no plan exists' : 'plan complete',
        suggestion: 'invoke /prompt-master to craft the prompt for the next phase',
      };
    }
    next.status = 'active';
    return { action: 'advance', milestone: next };
  }

  completeMilestone(id: string, outcome: 'green' | 'red'): OverseerDecision {
    const milestone = this.milestones.find((m) => m.id === id);
    if (milestone === undefined) {
      return { action: 'halt', reason: `unknown milestone ${id}`, suggestion: 'reconcile plan state before continuing' };
    }
    if (outcome === 'red') {
      this.failures += 1;
      if (this.failures >= 5) {
        milestone.status = 'pending';
        return { action: 'halt', reason: 'circuit breaker: 5 consecutive failures', suggestion: 'request human guidance' };
      }
      return { action: 'advance', milestone };
    }
    this.failures = 0;
    milestone.status = 'done';
    return this.step();
  }

  heartbeatDue(lastHeartbeatAt: string, nowAt: string = nowIso()): boolean {
    return Date.parse(nowAt) - Date.parse(lastHeartbeatAt) >= 5 * 60 * 1000;
  }
}
