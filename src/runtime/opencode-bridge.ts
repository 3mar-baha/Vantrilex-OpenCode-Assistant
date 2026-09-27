import type { ServeClient } from './client.js';
import type { SessionId } from '../common/brands.js';
import { fuzzyPick } from './fuzzy-match.js';

// Phase 5 — the OpenCode 360° omnipotent control layer.
//
// One façade over `ServeClient` giving the daemon (and the voice loop) full
// introspection and control: session telemetry, model/agent switching that
// understands what was SPOKEN, environment inspection, and native execution of
// the slash commands the assistant is allowed to run on the user's behalf.
//
// Design rules:
//   * WINDOW FILL vs LIFETIME SPEND. `SessionInfo.tokens` is cumulative spend;
//     `/api/session/{id}/context` is what is occupying the window now. A
//     compaction resets the second and not the first, so a gauge built on the
//     row climbs forever. `getSessionDetails` reports both, distinctly.
//   * NEVER GUESS a model or agent. Unresolvable or ambiguous input throws
//     rather than switching a heavy task to the wrong thing.
//   * NEVER FORWARD a slash blind. Only commands implemented here are run.

export interface SessionTokensView {
  /** Lifetime spend for the session, from the session row. */
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cache: { readonly read: number; readonly write: number };
  /** True current context occupancy, from the context endpoint. */
  readonly windowFill: number;
  /** The largest single step the window has held. */
  readonly windowMax: number | null;
  /** 0..100, or null when the window is unknown. Never guessed. */
  readonly percent: number | null;
  /** Peak occupancy seen, from the same source as `windowFill`. */
  readonly peak: number;
  /** Steps carrying token accounting. */
  readonly messageCount: number;
}

export interface SessionDetails {
  readonly id: string;
  readonly title: string;
  readonly model: string | null;
  readonly agent: string | null;
  /** Reasoning effort when serve reports one. */
  readonly effort: string | null;
  readonly tokens: SessionTokensView;
  readonly createdAt: number | null;
  readonly lastMessageAt: number | null;
}

export interface AgentInfoView {
  readonly id: string;
  readonly name: string;
}

export interface CommandInfoView {
  readonly name: string;
}

export interface EnvironmentStatus {
  readonly agents: readonly AgentInfoView[];
  readonly commands: readonly CommandInfoView[];
  /** Installed skills, from `/api/skill`. */
  readonly skills: readonly string[];
  /** The subset invocable as a slash command. */
  readonly slashSkills: readonly string[];
  /** Model catalog, including each model's context window. */
  readonly models: ReadonlyArray<{ readonly id: string; readonly name: string; readonly contextWindow: number | null }>;
  /** Plugins are not exposed over the serve API; kept for shape stability. */
  readonly plugins: readonly string[];
  /** Present for shape stability; serve exposes no health endpoint per server. */
  readonly mcpServers: readonly { readonly name: string; readonly status: 'unknown' }[];
}

/** Slash commands the assistant may run internally. Nothing else is forwarded. */
const INTERNAL_COMMANDS = new Set(['compact', 'undo', 'clear', 'model', 'interrupt', 'revert']);

export class OpenCodeBridge {
  /**
   * `directory` is the project root serve is scoped to. The 2.0.x contract
   * returns no agents for an unscoped call, so it is required rather than
   * optional — a silently empty agent list would make every agent command
   * look like "not found".
   */
  constructor(
    private readonly client: ServeClient,
    private readonly directory: string,
  ) {}

  async listAgents(): Promise<AgentInfoView[]> {
    return this.client.listAgents(this.directory);
  }

  async listCommands(): Promise<CommandInfoView[]> {
    return this.client.listCommands();
  }

  /**
   * Full introspection for one session, or `null` when it does not exist.
   *
   * Never throws for a missing session: the caller shows "no active session",
   * which is a normal state, not an error.
   */
  async getSessionDetails(sessionId: SessionId, windowMax?: number): Promise<SessionDetails | null> {
    let row: (Awaited<ReturnType<ServeClient['listSessions']>>)[number] | null = null;
    try {
      const rows = await this.client.listSessions();
      row = rows.find((r) => r.sessionId === sessionId) ?? null;
    } catch {
      return null;
    }
    if (row === null) return null;

    // Window fill comes from the context endpoint. A failure here must not lose
    // the rest of the telemetry, so it degrades to "unknown", not "throw".
    let usage: Awaited<ReturnType<ServeClient['contextUsage']>> | null = null;
    try {
      usage = await this.client.contextUsage(sessionId, windowMax);
    } catch {
      usage = null;
    }
    const windowFill = usage?.used ?? 0;
    const messageCount = usage?.messageCount ?? 0;
    const peak = usage?.peak ?? 0;

    // Use the limit `contextUsage` resolved. It already falls back to the model
    // catalog when the caller passed nothing — recomputing it here from the
    // argument alone silently discarded that and left the gauge showing
    // "unknown" forever. Caught by running against the live serve.
    const limit = usage?.limit ?? null;
    const percent =
      limit === null ? null : Math.max(0, Math.min(100, (windowFill / limit) * 100));

    const lastMessageAt = await this.lastMessageAt(sessionId);

    return {
      id: row.sessionId,
      title: row.title ?? row.sessionId,
      model: row.model ?? null,
      agent: row.agent ?? null,
      effort: null,
      tokens: {
        input: row.tokens?.input ?? 0,
        output: row.tokens?.output ?? 0,
        reasoning: row.tokens?.reasoning ?? 0,
        cache: { read: row.tokens?.cacheRead ?? 0, write: row.tokens?.cacheWrite ?? 0 },
        windowFill,
        windowMax: limit,
        percent: percent === null ? null : Math.round(percent * 10) / 10,
        peak,
        messageCount,
      },
      createdAt: row.createdAt ?? null,
      lastMessageAt,
    };
  }

  private async lastMessageAt(sessionId: SessionId): Promise<number | null> {
    const messages = await this.client.listSessionMessages(sessionId);
    let latest: number | null = null;
    for (const m of messages) if (latest === null || m.createdAt > latest) latest = m.createdAt;
    return latest;
  }

  /**
   * Switch model from a SPOKEN identifier. Resolves against the live catalog
   * and refuses when it cannot resolve to exactly one model.
   */
  async setSessionModel(sessionId: SessionId, spoken: string, catalog: readonly string[]): Promise<{ id: string }> {
    const id = fuzzyPick(spoken, catalog);
    if (id === null) throw new Error(`model not resolvable: ${spoken.slice(0, 40)}`);
    await this.client.setSessionModel(sessionId, { id, providerID: 'opencode' });
    return { id };
  }

  /** Switch agent from a spoken or typed identifier. Same never-guess rule. */
  async setSessionAgent(sessionId: SessionId, spoken: string): Promise<{ id: string }> {
    const agents = await this.listAgents();
    const id = fuzzyPick(spoken, agents.map((a) => a.id));
    if (id === null) throw new Error(`agent not resolvable: ${spoken.slice(0, 40)}`);
    await this.client.setSessionAgent(sessionId, id);
    return { id };
  }

  /**
   * Run one of the assistant's internal slash commands. Only the implemented
   * set is routable; anything else is refused rather than sent to the model.
   */
  async runInternalCommand(name: string, sessionId: SessionId): Promise<{ ok: true }> {
    const cmd = name.replace(/^\//, '').trim().toLowerCase();
    if (!INTERNAL_COMMANDS.has(cmd)) throw new Error(`unsupported internal command: ${cmd.slice(0, 32)}`);
    switch (cmd) {
      case 'compact':
        return this.client.compactSession(sessionId);
      case 'undo':
      case 'revert':
        return this.client.revertSession(sessionId, 'stage');
      case 'clear':
        return this.client.revertSession(sessionId, 'clear');
      case 'model':
        return { ok: true };
      case 'interrupt':
        return this.client.interruptSession(sessionId);
      default:
        // Unreachable given the INTERNAL_COMMANDS guard, but a switch that can
        // fall through is how an unrouted command would silently no-op.
        throw new Error(`unsupported internal command: ${cmd.slice(0, 32)}`);
    }
  }

  /** Everything the assistant can see about its own environment, in one call. */
  async getEnvironmentStatus(): Promise<EnvironmentStatus> {
    // Skills and models ARE exposed over the serve API (`/api/skill`,
    // `/api/model`) — an earlier revision reported them empty on the belief
    // that the config was not reachable. That belief was wrong and would have
    // made `@skill` mentions and the context limit permanently unavailable.
    const [agents, commands, skills, models] = await Promise.all([
      this.listAgents().catch(() => [] as AgentInfoView[]),
      this.listCommands().catch(() => [] as CommandInfoView[]),
      this.client.listSkills().catch(() => [] as Array<{ name: string; description: string | null; slash: boolean }>),
      this.client.listModels().catch(() => [] as Array<{ id: string; name: string; contextWindow: number | null }>),
    ]);
    return {
      agents,
      commands,
      skills: skills.map((s) => s.name),
      slashSkills: skills.filter((s) => s.slash).map((s) => s.name),
      models,
      plugins: [],
      // No MCP health endpoint exists on serve, so this stays empty rather than
      // inventing a status. "We did not look" must be distinguishable from
      // "there are none".
      mcpServers: [],
    };
  }
}
