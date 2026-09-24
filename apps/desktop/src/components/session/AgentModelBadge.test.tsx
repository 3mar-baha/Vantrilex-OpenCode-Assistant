import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AgentModelBadge } from './AgentModelBadge.js';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(node: React.ReactNode): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(node);
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
});

describe('AgentModelBadge', () => {
  test('surfaces agent/model with accessible switch actions', () => {
    const onSwitchAgent = vi.fn();
    const onSwitchModel = vi.fn();
    mount(
      <AgentModelBadge
        agent="build"
        model="opus"
        onSwitchAgent={onSwitchAgent}
        onSwitchModel={onSwitchModel}
      />,
    );
    expect(document.body.querySelector('[data-testid="badge-agent"]')?.textContent).toContain('build');
    expect(document.body.querySelector('[data-testid="badge-model"]')?.textContent).toContain('opus');
    act(() => {
      (document.body.querySelector('[data-testid="badge-switch-agent"]') as HTMLElement).click();
    });
    expect(onSwitchAgent).toHaveBeenCalledTimes(1);
    act(() => {
      (document.body.querySelector('[data-testid="badge-switch-model"]') as HTMLElement).click();
    });
    expect(onSwitchModel).toHaveBeenCalledTimes(1);
  });

  test('unassigned state renders without fabrication', () => {
    mount(
      <AgentModelBadge agent={null} model={null} onSwitchAgent={() => undefined} onSwitchModel={() => undefined} />,
    );
    expect(document.body.querySelector('[data-testid="badge-agent"]')?.textContent).toContain('unassigned');
  });
});
