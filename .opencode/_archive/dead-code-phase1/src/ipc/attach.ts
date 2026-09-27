import { SessionInventory, type InventoryClient, type InventoryEvent } from '../orchestrator/inventory.js';
import type { InventoryFrame } from './protocol.js';

// Phase 2b composer — fan SessionInventory diffs out as WS snapshots.
// Every diff event republishes the current snapshot; errors publish the empty
// (unready) shape. The composer owns the inventory so the wiring cannot drift.
export interface InventoryPublisher {
  publishInventory(sessions: ReadonlyArray<{ sessionId: string; state: string }>): InventoryFrame;
}

export function attachInventory(
  server: InventoryPublisher,
  client: InventoryClient,
  options: { intervalMs?: number } = {},
): SessionInventory {
  const onEvent = (event: InventoryEvent): void => {
    if (event.kind === 'error') {
      server.publishInventory([]);
      return;
    }
    const current = inventory.snapshot().map((s) => ({ sessionId: s.sessionId, state: s.state }));
    server.publishInventory(current);
  };
  const inventory = new SessionInventory(
    client,
    options.intervalMs === undefined ? { onEvent } : { intervalMs: options.intervalMs, onEvent },
  );
  return inventory;
}
