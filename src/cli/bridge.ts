import type { SessionId } from '../common/brands.js';
import { OrchestratorError } from '../common/errors.js';
import type { ServeClient, SessionShellResult } from '../runtime/client.js';
import { openServeTarget, postProbe, promptBody, requirePassword, probeRoute, readSpec, type RouteProbe } from './serve.js';
import * as out from './report.js';

// HEADLESS BRIDGE — the serve surface, one subcommand per route family.
//
// EVERY CALL BELOW GOES THROUGH `ServeClient` OR ITS OWN REQUEST PATH. There is
// no `fetch` in this file, and that is not style: serve answers `200 OK` with a
// 2 884-byte `text/html` SPA fallback for any unknown path
// (`runtime/client.ts:321-343`), so a harness that calls `fetch` and checks
// `res.ok` reports success against routes the server has no handler for. That is
// the exact defect that made `execSessionShell` claim a command had run when it
// had never reached a route, and it is the reason this runner exists as product
// code rather than as a scratch script.
//
// THE `mcp` / `lsp` CAVEAT, CARRIED IN THE OUTPUT. Those two have NO `/api`
// prefix (measured 2026-09-30: `GET /mcp` returns the real map, `GET /api/mcp`
// returns the fallback). `ServeClient` has no method for either, so they are read
// through the client's own request path and reported with the content type of
// every candidate. A route is reported as available only when serve returned JSON
// for that exact path; `res.ok` is never the evidence.

function printRoute(probe: RouteProbe, label: string): void {
  out.field(label, `${probe.path}`);
  out.field('  http', String(probe.status));
  out.field('  content-type', probe.contentType === '' ? '(none declared)' : probe.contentType);
  out.field('  bytes', String(probe.bytes));
  out.field('  verdict', probe.exists === 'yes' ? 'route answered with JSON' : probe.exists === 'no' ? 'SPA FALLBACK — no route at this path' : 'indeterminate');
  if (probe.error !== null) out.field('  note', probe.error);
}

/** `sessions` — the list, through `ServeClient.listSessions()`. */
export async function sessionsCommand(): Promise<number> {
  out.heading('sessions — src/runtime/client.ts ServeClient.listSessions()');
  const target = await openServeTarget();
  out.field('serve', target.baseUrl);
  out.field('serve healthy', String(target.healthy));
  requirePassword(target);
  if (!target.healthy) {
    out.fail('serve unreachable — the list below would be an empty array, which is indistinguishable from "no sessions"');
    return 1;
  }
  let rows: Awaited<ReturnType<ServeClient['listSessions']>>;
  try {
    rows = await target.client.listSessions();
  } catch (err) {
    out.fail(`listSessions threw: ${err instanceof Error ? err.message : 'unknown'}`);
    return 1;
  }
  // The route's own content type, so `0 sessions` is distinguishable from
  // `the route did not answer`. Without this, an SPA fallback would print as an
  // empty project.
  const route = await probeRoute(target.client, '/api/session');
  out.field('route check', `${route.path} → ${route.kind} (${route.contentType}) exists=${route.exists}`);
  out.field('count', String(rows.length));
  if (rows.length === 0) {
    out.note('zero rows is a measurement only if the route answered with JSON — see route check');
  }
  for (const row of rows) {
    const tokens = row.tokens;
    out.note(
      [
        row.sessionId,
        `state=${row.state}`,
        row.title !== undefined ? `title="${out.clip(row.title, 40)}"` : '',
        row.agent !== undefined ? `agent=${row.agent}` : '',
        tokens !== undefined ? `tokens in=${tokens.input} out=${tokens.output} cache.read=${tokens.cacheRead}` : 'tokens=n/a',
      ]
        .filter((s) => s.length > 0)
        .join('  '),
    );
  }
  return 0;
}

/**
 * `mcp` — MCP server status, per directory.
 *
 * SCOPE, STATED BECAUSE THE PLAN REFUTED THE OBVIOUS ONE: MCP is DIRECTORY-scoped,
 * not session-scoped. There is no per-session MCP read, so this takes a
 * `--directory` and defaults to the process cwd rather than inventing a session
 * scope that does not exist.
 */
export async function mcpCommand(directory: string): Promise<number> {
  out.heading('mcp — directory-scoped, no /api prefix (measured 2026-09-30)');
  out.source('src/runtime/client.ts', 'request path (no method exists for /mcp)');
  const target = await openServeTarget();
  requirePassword(target);
  out.field('directory', directory);
  if (!target.healthy) {
    out.fail('serve unreachable');
    return 1;
  }
  // Both paths, always. The comparison IS the finding: `/mcp` real, `/api/mcp`
  // fallback. Printing only the working one would leave the reader unable to
  // check it.
  const real = await probeRoute(target.client, `/mcp?directory=${encodeURIComponent(directory)}`);
  const prefixed = await probeRoute(target.client, `/api/mcp?directory=${encodeURIComponent(directory)}`);
  printRoute(real, 'real path');
  printRoute(prefixed, 'with /api prefix');
  if (real.exists === 'yes') {
    out.heading('MCP servers');
    const map = real.json;
    if (map !== null && typeof map === 'object' && !Array.isArray(map)) {
      const entries = Object.entries(map as Record<string, unknown>);
      out.field('servers', String(entries.length));
      for (const [name, status] of entries) out.note(`${name}: ${typeof status === 'string' ? status : JSON.stringify(status)}`);
    } else {
      out.note('answer was JSON but not a map of servers; printed above verbatim');
    }
  }
  return real.exists === 'yes' ? 0 : 1;
}

/** `lsp` — LSP diagnostics, per directory. Array-shaped, unlike `mcp`. */
export async function lspCommand(directory: string): Promise<number> {
  out.heading('lsp — directory-scoped, no /api prefix (measured 2026-09-30)');
  out.source('src/runtime/client.ts', 'request path (no method exists for /lsp)');
  const target = await openServeTarget();
  requirePassword(target);
  out.field('directory', directory);
  if (!target.healthy) {
    out.fail('serve unreachable');
    return 1;
  }
  const real = await probeRoute(target.client, `/lsp?directory=${encodeURIComponent(directory)}`);
  const prefixed = await probeRoute(target.client, `/api/lsp?directory=${encodeURIComponent(directory)}`);
  printRoute(real, 'real path');
  printRoute(prefixed, 'with /api prefix');
  if (real.exists === 'yes') {
    const rows = Array.isArray(real.json) ? real.json : [];
    out.heading('diagnostics');
    out.field('entries', String(rows.length));
    for (const row of rows) out.note(JSON.stringify(row).slice(0, 300));
  }
  return real.exists === 'yes' ? 0 : 1;
}

/** `skills` — through `ServeClient.listSkills()`, with the route checked. */
export async function skillsCommand(): Promise<number> {
  out.heading('skills — src/runtime/client.ts ServeClient.listSkills()');
  const target = await openServeTarget();
  requirePassword(target);
  if (!target.healthy) {
    out.fail('serve unreachable');
    return 1;
  }
  // `listSkills()` swallows a non-ok into `[]` (`client.ts:997`), so an empty
  // array here is ambiguous on its own. The route check is what resolves it.
  const route = await probeRoute(target.client, '/api/skill');
  const rows = await target.client.listSkills();
  out.field('route check', `${route.path} → ${route.kind} (${route.contentType}) exists=${route.exists}`);
  out.field('count', String(rows.length));
  for (const row of rows) {
    out.note(`${row.name}${row.slash ? '  (slash-invocable)' : ''}${row.description !== null ? `  — ${out.clip(row.description, 80)}` : ''}`);
  }
  // ALSO report the no-prefix variant, because the plan recorded that `/skill`
  // exists too and a single path is not evidence of which one the client used.
  const bare = await probeRoute(target.client, '/skill');
  out.field('bare /skill', `${bare.kind} (${bare.contentType}) exists=${bare.exists}`);
  return 0;
}

/** `create-session` — through `ServeClient.createSession()`. */
export async function createSessionCommand(directory: string, model?: string): Promise<number> {
  out.heading('create-session — src/runtime/client.ts ServeClient.createSession()');
  const target = await openServeTarget();
  requirePassword(target);
  out.field('serve', target.baseUrl);
  out.field('directory', directory);
  if (!target.healthy) {
    out.fail('serve unreachable — no session was created');
    return 1;
  }
  let created: { sessionId: SessionId; state: string };
  try {
    created = await target.client.createSession(directory, model);
  } catch (err) {
    const code = err instanceof OrchestratorError ? err.code : 'internal';
    out.fail(`createSession threw: ${code} — ${err instanceof Error ? err.message : 'unknown'}`);
    return 1;
  }
  out.field('sessionId', created.sessionId);
  out.field('state', created.state);
  out.heading('read back from serve — not from the create response');
  // The id above came from the create response. Everything below is a SECOND
  // read, because "the server accepted my id" and "the server has that session"
  // are different claims and only the second one is worth having.
  const route = await probeRoute(target.client, `/api/session/${created.sessionId}`);
  out.field('route check', `${route.path} → ${route.kind} (${route.contentType}) exists=${route.exists}`);
  try {
    const status = await target.client.getSession(created.sessionId);
    out.field('getSession.state', status.state);
    out.field('getSession.outcome', status.outcome);
    out.field('getSession.updatedAt', status.updatedAt);
  } catch (err) {
    out.warnLine(`getSession failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }
  out.note('no prompt was sent — creating a session does not start work in it');
  return 0;
}

/** `prompt` — through `ServeClient.promptSession()`. 409 is a busy answer. */
export async function promptCommand(sessionId: string, text: string, envelope: 'flat' | 'nested'): Promise<number> {
  out.heading('prompt — src/runtime/client.ts ServeClient.promptSession()');
  const target = await openServeTarget({ promptEnvelope: envelope });
  requirePassword(target);
  out.field('session', sessionId);
  out.field('text', out.clip(text, 200));
  // Printed on every run: a 400 from one envelope is not evidence about the other,
  // and this command exists to settle which one the running serve accepts.
  out.field('prompt envelope', `${target.promptEnvelope} (ServeClient default is flat; 1.18.x is documented to want nested)`);
  if (!target.healthy) {
    out.fail('serve unreachable — nothing was sent');
    return 1;
  }
  const at = Date.now();
  try {
    const res = await target.client.promptSession(sessionId as SessionId, text, { origin: 'cli', actor: 'headless-prompt' });
    out.field('delivered', 'yes');
    out.field('serve state', res.state);
    out.field('receipt', res.receipt);
    out.field('round trip', `${Date.now() - at} ms`);
    return 0;
  } catch (err) {
    const code = err instanceof OrchestratorError ? err.code : 'internal';
    out.field('delivered', 'no');
    out.field('code', code);
    out.field('message', err instanceof Error ? err.message : 'unknown');
    if (code === 'SESSION_BUSY') {
      // MEASURED FACT, not an excuse: `/api/session/{id}/prompt` answers 409 while
      // a turn is in flight. `promptSession` maps that to a RETRYABLE
      // SESSION_BUSY (`client.ts:564`), which is a statement about the session,
      // not about the prompt. The brief is explicit that this is not a failure of
      // the runner, so it exits 0 with the reason on screen.
      out.note('409 is backpressure: the session is mid-turn. The prompt was NOT queued by this call — retry when the turn settles.');
      return 0;
    }
    // The refusal itself. `ServeClient` discards serve's body on a non-2xx, so
    // the diagnosis is re-read through the SAME request path — same auth, same
    // SPA rule, and the SAME body shape that just failed — rather than through a
    // second HTTP client. The prompt is not being re-sent for effect: the first
    // attempt was rejected, and a rejected prompt was not applied.
    const body = promptBody(text, envelope, { origin: 'cli', actor: 'headless-prompt-diagnostic' });
    try {
      const raw = await postProbe(target.client, `/api/session/${sessionId}/prompt`, body);
      out.heading('what serve said (read through ServeClient\'s own request path, same body)');
      out.field('bytes sent', JSON.stringify(body));
      out.field('http', String(raw.status));
      out.field('content-type', raw.contentType === '' ? '(none declared)' : raw.contentType);
      out.field('spa fallback', String(raw.spaFallback));
      out.field('body', raw.body.length > 0 ? raw.body : '(empty)');
      if (raw.status !== rawFirstStatusHint(err)) {
        // Recorded rather than reconciled: a diagnostic that answers differently
        // from the attempt it is diagnosing is itself a finding, and hiding it
        // behind a single printed status would be the worst version of this.
        out.warnLine('the re-read answered differently from the attempt above — serve\'s error is not deterministic here');
      }
    } catch (probeErr) {
      out.warnLine(`the diagnostic re-read failed too: ${probeErr instanceof Error ? probeErr.message : 'unknown'}`);
    }
    return 1;
  }
}

/** The HTTP status the thrown message carries, or `null` when there is not one. */
function rawFirstStatusHint(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const message = (err as { message?: unknown }).message;
  if (typeof message !== 'string') return null;
  const found = /HTTP (\d{3})/.exec(message);
  if (found === null || found[1] === undefined) return null;
  return Number.parseInt(found[1], 10);
}

/** `spec` — the real OpenAPI document, for every route claim in a report. */
export async function specCommand(): Promise<number> {
  out.heading('spec — where the route list actually lives');
  const target = await openServeTarget();
  requirePassword(target);
  if (!target.healthy) {
    out.fail('serve unreachable');
    return 1;
  }
  const real = await readSpec(target.client);
  const wrong = await probeRoute(target.client, '/openapi.json');
  out.field('GET /doc', `${real.paths} declared paths, ${real.bytes} bytes${real.error !== null ? ` — ${real.error}` : ''}`);
  out.field('GET /openapi.json', `${wrong.kind} (${wrong.contentType}, ${wrong.bytes} bytes) exists=${wrong.exists}`);
  out.note('the second line is the trap: an unknown path answers 200 with the SPA page');
  return 0;
}

/** `shell` — through `ServeClient.execSessionShell()`, on the v1 route. */
export async function shellCommand(sessionId: string, command: string, agent: string): Promise<number> {
  out.heading('shell — src/runtime/client.ts ServeClient.execSessionShell()');
  out.field('session', sessionId);
  out.field('command', command);
  out.field('agent', agent);
  const target = await openServeTarget();
  requirePassword(target);
  if (!target.healthy) {
    out.fail('serve unreachable — the command was not run');
    return 1;
  }
  const at = Date.now();
  let result: SessionShellResult;
  try {
    result = await target.client.execSessionShell(sessionId as SessionId, command, agent);
  } catch (err) {
    const code = err instanceof OrchestratorError ? err.code : 'internal';
    out.field('ran', 'no — the request failed before a tool result came back');
    out.field('code', code);
    out.field('message', err instanceof Error ? err.message : 'unknown');
    return 1;
  }
  out.field('ran', 'yes — serve returned a tool part');
  out.field('status', result.status);
  out.field('outcome', result.outcome);
  out.field('exit code', result.exitCode === null ? 'not reported by serve' : String(result.exitCode));
  out.field('output bytes', String(result.outputBytes));
  out.field('round trip', `${Date.now() - at} ms`);
  if (result.output.length > 0) {
    out.heading('output');
    console.log(result.output);
  } else {
    out.note('(no output — and per the measured contract that is NOT a success signal either)');
  }
  out.heading('how to read `outcome`');
  out.note(`'ok' only when serve flags the tool as error-free WITH an exit code. Measured 2026-09-30:`);
  out.note(`  exit 3            → status=completed, output="", exitCode=null → outcome=unknown`);
  out.note(`  a silent success  → status=completed, output="", exitCode=null → outcome=unknown`);
  out.note('so ' + result.outcome + ' here means the tool ran and the contract held, nothing more.');
  if (result.outcome === 'unknown') {
    out.warnLine('a failed command and a command that printed nothing are byte-identical in this API — do not read this as success');
  }
  return 0;
}
