/**
 * The task queue's public surface, in one place.
 *
 * This barrel exists for the integration wave, not for the daemon: when
 * `daemon.ts` imports it, it drags `node:fs` in with it (it already does), so
 * the split-versus-barrel question that bit `src/knowledge/` does not arise
 * here. Nothing inside `src/tasks/` imports this file.
 */
export { TaskQueue } from './engine.js';
export {
  DEFAULT_TASK_TIMEOUT_MS,
  MAX_CONCURRENCY,
  MAX_HISTORY,
  MAX_PENDING,
  MAX_TASK_TIMEOUT_MS,
  MIN_TASK_TIMEOUT_MS,
} from './engine.js';
export type { EnqueueResult, QueueStats, TaskEvent, TaskQueueOptions, TaskRecovery } from './engine.js';

export { FileTaskStore, MemoryTaskStore, SNAPSHOT_VERSION, TaskStoreError, nodeFs } from './store.js';
export type { FsPort, StoreRead, TaskSnapshot, TaskStore } from './store.js';

export { canTransition, isTerminal, LEGAL_TRANSITIONS, TERMINAL_STATES, taskId } from './types.js';
export type {
  RecoveryCode,
  TaskExecutor,
  TaskFailure,
  TaskFailureCode,
  TaskId,
  TaskOutcomeCode,
  TaskRecord,
  TaskSpec,
  TaskState,
} from './types.js';

export { buildTaskNotice } from './notices.js';
export type { NoticeContext, NoticeSeverity, TaskNotice } from './notices.js';
