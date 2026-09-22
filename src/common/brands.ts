// Shared branded primitives — see docs/05-DATA-MODEL.md §5.1.
export type ISODateString = string;
export type SessionId = string & { readonly __brand: 'SessionId' };
export type EventId = string & { readonly __brand: 'EventId' };
export type ApprovalId = string & { readonly __brand: 'ApprovalId' };
export type VoiceId = 'male-default' | 'female-toggle';

export const VOICE_IDS = {
  'male-default': '5b90451e0cd34b2788841744af7c55c3',
  'female-toggle': '88c0375e46fa4e3b929755fa077ca5ad',
} as const;

export type SessionState =
  | 'creating' | 'running' | 'awaiting-approval'
  | 'idle' | 'complete' | 'error' | 'aborted';

export type SessionOutcome = 'green' | 'red' | 'amber' | 'unknown';

export function nowIso(): ISODateString {
  return new Date().toISOString();
}
