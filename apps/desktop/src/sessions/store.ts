// Sessions store — pure reducer for the daemon-surfaced inventory.
// select() is accept-and-record (mirrors the daemon): unknown ids are kept,
// never fabricated into the list.
export interface ListedSession {
  readonly id: string;
  readonly state: string;
}

export interface SessionsState {
  readonly sessions: readonly ListedSession[];
  readonly activeId: string | null;
}

export type SessionsAction =
  | { readonly kind: 'replace'; readonly sessions: readonly ListedSession[] }
  | { readonly kind: 'select'; readonly id: string };

export const initialSessionsState: SessionsState = { sessions: [], activeId: null };

export function sessionsReducer(state: SessionsState, action: SessionsAction): SessionsState {
  switch (action.kind) {
    case 'replace':
      return { ...state, sessions: [...action.sessions] };
    case 'select':
      return { ...state, activeId: action.id };
  }
}
