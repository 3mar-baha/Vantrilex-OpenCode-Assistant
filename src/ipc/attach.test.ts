import { describe, expect, test } from 'vitest';
import type { InventoryClient } from '../orchestrator/inventory.js';
import type { InventoryFrame } from './protocol.js';
import { attachInventory } from './attach.js';

// Phase 2b TDD — inventory events fan out as WS snapshots. Hermetic: stub
// server records publishes; stub client feeds the inventory.
function stubServer(): {
  server: { publishInventory: (sessions: ReadonlyArray<{ sessionId: string; state: string }>) => InventoryFrame };
  published: InventoryFrame[];
} {
  const published: InventoryFrame[] = [];
  return {
    published,
    server: {
      publishInventory: (sessions: ReadonlyArray<{ sessionId: string; state: string }>) => {
        const frame = {
          type: 'inventory',
          seq: published.length + 1,
          sessions: [...sessions],
        } as InventoryFrame;
        published.push(frame);
        return frame;
      },
    },
  };
}

describe('attachInventory', () => {
  test('added/removed events each publish the current snapshot', async () => {
    const lists = [
      [{ sessionId: 'a', state: 'running' }],
      [
        { sessionId: 'a', state: 'running' },
        { sessionId: 'b', state: 'idle' },
      ],
    ];
    let calls = 0;
    const client: InventoryClient = {
      listSessions: async () => {
        calls += 1;
        return lists[Math.min(calls - 1, lists.length - 1)]!.map((s) => ({ ...s }));
      },
    };
    const { server, published } = stubServer();
    const inventory = attachInventory(server, client);
    try {
      await inventory.pollOnce();
      await inventory.pollOnce();
      expect(published.length).toBeGreaterThanOrEqual(2);
      const latest = published[published.length - 1]!;
      expect(latest.sessions.map((s) => s.sessionId).sort()).toEqual(['a', 'b']);
    } finally {
      inventory.dispose();
    }
  });

  test('inventory error publishes the empty (unready) shape, never throws', async () => {
    const client: InventoryClient = {
      listSessions: async () => {
        throw new Error('serve down');
      },
    };
    const { server, published } = stubServer();
    const inventory = attachInventory(server, client);
    try {
      await expect(inventory.pollOnce()).resolves.toBeUndefined();
      expect(published).toHaveLength(1);
      expect(published[0]!.sessions).toEqual([]);
    } finally {
      inventory.dispose();
    }
  });
});
