import { z } from 'zod';

// Lifecycle event envelopes — docs/05 §5.3, docs/06 §6.3, docs/25 §25.1.
export const LifecycleEventType = z.enum([
  'session:start',
  'agent:action',
  'subagent:complete',
  'step:complete',
  'session:complete',
  'session:idle',
]);
export type LifecycleEventType = z.infer<typeof LifecycleEventType>;

const BaseEnvelope = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  at: z.string().datetime(),
  payload: z.unknown(),
  cursor: z.string(),
});

export const EventEnvelopeSchema = BaseEnvelope.and(z.object({ type: LifecycleEventType }));
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

export interface AgentActionPayload {
  readonly action: string;
  readonly stepIndex: number;
  readonly routine: boolean;
}

export interface SessionCompletePayload {
  readonly outcome: 'green' | 'red' | 'amber' | 'unknown';
  readonly summaryText: string;
}

/** Parse one SSE data frame; returns null for heartbeats/comments/invalid frames. */
export function parseSseFrame(eventType: string, id: string, data: string): EventEnvelope | null {
  if (eventType.length === 0 || id.length === 0 || data.length === 0) return null;
  const typeResult = LifecycleEventType.safeParse(eventType);
  if (!typeResult.success) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(data) as unknown;
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const body = payload as Record<string, unknown>;
  const result = EventEnvelopeSchema.safeParse({
    id,
    type: typeResult.data,
    sessionId: body['sessionId'],
    at: body['at'],
    payload: body['payload'],
    cursor: body['cursor'] ?? id,
  });
  return result.success ? result.data : null;
}
