import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../common/config.js';
import { OrchestratorError } from '../common/errors.js';
import { ServeClient } from '../runtime/client.js';
import { OpenCodeBridge } from '../runtime/opencode-bridge.js';
import { probeHealth } from '../launcher/index.js';

// HEADLESS TRANSPORT — one serve egress, assembled from the product's own parts.
//
// THE TRAP THIS FILE EXISTS TO AVOID. Serve answers `200 OK` with a 2 884-byte
// `text/html` SPA fallback for ANY unknown path (`runtime/client.ts:321-343`).
// So a raw `fetch('http://127.0.0.1:4096/api/session')` that checks `res.ok` is
// indistinguishable from a real route, and a scratch harness that does exactly
// that measures OpenCode rather than Voxaura. Every call below goes through
// `ServeClient`, which is the only place auth and the fallback rule live.
//
// AUTH IS NOT REIMPLEMENTED. `ServeClient` builds the envelope (Basic
// `opencode:<password>`, JSON content-type, idempotency key, 30 s abort) in its own
// private `request`. This file does not add a second HTTP client and does not
// duplicate the header; it asks for the product's password the way the daemon
// does and hands it to `ServeClient`.

export interface ServeTarget {
  readonly client: ServeClient;
  readonly bridge: OpenCodeBridge;
  readonly baseUrl: string;
  readonly port: number;
  readonly directory: string;
  /** Where the serve password came from, so a reader can see it was not invented. */
  readonly passwordSource: 'env:OPENCODE_SERVER_PASSWORD' | 'file:serve.pass' | 'none';
  readonly healthy: boolean;
}

const RUNTIME_DIR_NAME = '.opencode-voice-runtime';

/**
 * The serve password, from the same two places the product reads it.
 *
 * `OPENCODE_SERVER_PASSWORD` first, then the supervisor's `serve.pass` in the
 * runtime directory — the order `diag/bundle.ts:864` uses, and the file
 * `main.rs` writes with an owner-only DACL. An operator running the CLI by hand
 * from a repo checkout has the file and not the env var, and the alternative was a
 * runner that only works from the installed app's environment.
 *
 * NEVER LOGGED. Only the SOURCE name is ever returned.
 */
export function resolveServePassword(
  env: NodeJS.ProcessEnv = process.env,
  runtimeDir: string = env['VOICE_RUNTIME_DIR'] ?? join(homedir(), RUNTIME_DIR_NAME),
): { readonly password: string; readonly source: ServeTarget['passwordSource'] } {
  const fromEnv = env['OPENCODE_SERVER_PASSWORD'] ?? '';
  if (fromEnv.length > 0) return { password: fromEnv, source: 'env:OPENCODE_SERVER_PASSWORD' };
  try {
    const fromFile = readFileSync(join(runtimeDir, 'serve.pass'), 'utf8').trim();
    if (fromFile.length > 0) return { password: fromFile, source: 'file:serve.pass' };
  } catch {
    // No supervisor-provisioned password: an operator-supplied `opencode serve`
    // on a custom password is reachable with the env var instead.
  }
  return { password: '', source: 'none' };
}

/**
 * Build the serve surface. Does not require the daemon on 4097, does not require
 * vault keys, and does not require a healthy serve — it reports health instead of
 * throwing, because "serve is down" is a finding a verification run exists to
 * print, not an error that should stop the report from being written.
 *
 * NO `promptEnvelope` option (W26). It used to be plumbed through here into a
 * `ServeClient` option that nothing read, and then printed as `prompt envelope`
 * — a report asserting a body-shape capability the request path did not have.
 * The prompt egress picks its ROUTE by status code inside `promptWithKey`
 * (v2, then v1 `prompt_async` on a 5xx); there is no shape left to select. The
 * reasoning for not reinstating it is on the `ServeClient` constructor.
 */
export async function openServeTarget(options: { readonly directory?: string } = {}): Promise<ServeTarget> {
  const cfg = loadConfig();
  const { password, source } = resolveServePassword();
  const client = new ServeClient(`http://${cfg.serve.hostname}:${cfg.serve.port}`, password);
  const directory = options.directory ?? process.cwd();
  return {
    client,
    bridge: new OpenCodeBridge(client, directory),
    baseUrl: `http://${cfg.serve.hostname}:${cfg.serve.port}`,
    port: cfg.serve.port,
    directory,
    passwordSource: source,
    healthy: password.length > 0 ? await probeHealth(cfg.serve.port, password) : false,
  };
}

/** Fail closed with the product's own error code when there is no credential. */
export function requirePassword(target: ServeTarget): string {
  if (target.passwordSource === 'none') {
    throw new OrchestratorError(
      'CONFIG_INVALID',
      false,
      'no serve password: set OPENCODE_SERVER_PASSWORD or provision serve.pass in the runtime directory',
    );
  }
  return target.passwordSource;
}

/**
 * The SPA-fallback rule, for the routes `ServeClient` has no method for.
 *
 * `spaFallbackContentType` is not exported from `runtime/client.ts:344`, so this
 * is the same three-line rule re-stated rather than imported. It is stated rather
 * than hidden because the alternative — treating a `200` as a route — is the exact
 * defect that let `execSessionShell` report success for a command that never ran.
 * `serve-fallback-rule.test.ts` pins this predicate and the product's own method
 * against the same three measured response shapes, so the two cannot drift.
 */
export function spaFallbackContentType(res: { headers: { get(name: string): string | null } }): string | null {
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType === '' || contentType.includes('json')) return null;
  return contentType;
}

export type RouteKind = 'json' | 'text' | 'empty' | 'error';

export interface RouteProbe {
  readonly path: string;
  readonly status: number;
  readonly contentType: string;
  readonly bytes: number;
  readonly kind: RouteKind;
  /** True when the body is the SPA catch-all rather than a route's payload. */
  readonly spaFallback: boolean;
  /** Present only for `kind: 'json'`. */
  readonly json: unknown;
  readonly error: string | null;
  /** `GET /mcp` exists and `GET /api/mcp` is the fallback — the report says which. */
  readonly exists: 'yes' | 'no' | 'unknown';
}

/**
 * ServeClient's OWN request path, reached rather than reimplemented.
 *
 * `ServeClient.request` (`runtime/client.ts:483`) is `private`, and `client.ts`
 * is outside this change's write-set, so no method can be added to the class. The
 * three routes this runner needs that the class cannot express are read-only GETs
 * on paths with NO `/api` prefix (`/mcp`, `/lsp`, `/doc`), and the brief's rule is
 * explicit: compose the product's request path rather than add a second HTTP
 * client. So this binds the existing method off the instance.
 *
 * WHAT IS AND IS NOT REUSED. Reused, and the reason this is safe: the envelope
 * (`Content-Type: application/json`), the Basic auth header, the 30 s abort, and
 * the `SERVE_UNREACHABLE` mapping on a transport throw — all of it, because it is
 * the same function object, not a copy. NOT reused: the method is still called
 * `request` and typed as private, so a future rename in `client.ts` breaks this
 * seam. `headless-transport.test.ts` asserts the seam is present and that the
 * probe carries the auth header, so a rename fails the suite instead of silently
 * turning a GET into an unauthenticated one.
 */
type RequestPath = (path: string, init: RequestInit, idempotencyKey?: string) => Promise<Response>;

/** The bound request method, or a thrown error naming the exact break. */
export function requestPathOf(client: ServeClient): RequestPath {
  const holder = client as unknown as { request?: RequestPath };
  if (typeof holder.request !== 'function') {
    throw new OrchestratorError(
      'CONTRACT_DRIFT',
      false,
      'ServeClient no longer exposes a request path (renamed or inlined) — this runner reads /mcp, /lsp and /doc through it and will not fall back to a second HTTP client',
    );
  }
  return holder.request.bind(client) as RequestPath;
}

/**
 * Ask serve about one path and report WHAT CAME BACK, never whether it "worked".
 *
 * `exists` is derived from the content type, not the status: `yes` for a JSON
 * body, `no` for a declared non-JSON 2xx (the fallback), `unknown` for a
 * non-2xx or an unparseable body. A `404` and a `400` are both `unknown` here
 * deliberately — the plan's own trap #2: a session-scoped route with a bad id
 * returns `400`, which is a refusal, not an absence, and reporting it as "no such
 * route" would be the mirror of the same lie.
 */
export async function probeRoute(client: ServeClient, path: string): Promise<RouteProbe> {
  let res: Response;
  try {
    res = await requestPathOf(client)(path, { method: 'GET' });
  } catch (err) {
    return {
      path,
      status: 0,
      contentType: '',
      bytes: 0,
      kind: 'error',
      spaFallback: false,
      json: null,
      error: err instanceof Error ? err.message : 'unknown',
      exists: 'unknown',
    };
  }
  const contentType = res.headers.get('content-type') ?? '';
  const fallback = spaFallbackContentType(res);
  const raw = await res.text().catch(() => '');
  const is2xx = res.status >= 200 && res.status < 300;
  if (!is2xx) {
    return {
      path,
      status: res.status,
      contentType,
      bytes: Buffer.byteLength(raw, 'utf8'),
      kind: 'error',
      spaFallback: false,
      json: null,
      error: `HTTP ${res.status} (a refusal, not an absence)`,
      exists: 'unknown',
    };
  }
  if (fallback !== null) {
    return {
      path,
      status: res.status,
      contentType,
      bytes: Buffer.byteLength(raw, 'utf8'),
      kind: 'text',
      spaFallback: true,
      json: null,
      error: null,
      exists: 'no',
    };
  }
  let json: unknown = null;
  try {
    json = JSON.parse(raw) as unknown;
  } catch (err) {
    return {
      path,
      status: res.status,
      contentType,
      bytes: Buffer.byteLength(raw, 'utf8'),
      kind: 'error',
      spaFallback: false,
      json: null,
      error: `2xx with no JSON body (${err instanceof Error ? err.message : 'unparseable'})`,
      exists: 'unknown',
    };
  }
  return {
    path,
    status: res.status,
    contentType: contentType === '' ? '(none declared)' : contentType,
    bytes: Buffer.byteLength(raw, 'utf8'),
    kind: raw.length === 0 ? 'empty' : 'json',
    spaFallback: false,
    json,
    error: null,
    exists: 'yes',
  };
}

/**
 * The v2 prompt body — the exact payload `promptWithKey` puts on the wire.
 *
 * USED FOR ONE THING: the diagnostic re-read in `promptCommand`, which has to put
 * the SAME bytes up as the request that failed, or its answer describes a
 * different request. That mistake was made twice. The first version hardcoded one
 * shape, so a run under the other printed a 400 about a missing `prompt` key — the
 * wrong shape's error under the right shape's heading.
 *
 * IT USED TO BE WORSE, AND THE FIX IS THE POINT (W26). This function took a
 * `PromptEnvelope` and produced `{text, metadata, delivery}` or
 * `{prompt:{text, metadata, delivery}}` — claiming to mirror "the two shapes
 * ServeClient sends". `ServeClient` sends NEITHER. `promptWithKey` sends
 * `{prompt:{text}, delivery:'steer'}` and falls back to
 * `{messageID, parts:[…]}` on a 5xx; `metadata` is not a member of `PromptInput`
 * at all. So the diagnostic was guaranteed to describe a request that never
 * happened, for every value of the flag.
 *
 * It is not a second HTTP client. The transport, the auth header, the 30 s abort
 * and the `SERVE_UNREACHABLE` mapping are all still `ServeClient`'s; this is a
 * serialiser, and the exact bytes it produces are printed next to the result.
 */
export function promptBody(text: string): unknown {
  return { prompt: { text }, delivery: 'steer' };
}

/**
 * A POST that reports the raw answer instead of throwing.
 *
 * DIAGNOSTIC ONLY, and deliberately not a general-purpose escape hatch.
 * `ServeClient.promptSession` maps every non-404/409/2xx to
 * `SERVE_UNREACHABLE: session.prompt failed with HTTP <n>` and throws the body
 * away — so a caller that wants to know WHY serve said 400 has nowhere to look
 * without opening its own HTTP client, which is the thing this runner refuses to
 * do. This reaches the same request path, keeps the same auth and the same
 * fallback rule, and returns the body.
 *
 * NOT SAFE TO CALL BLINDLY: a POST can apply. The only caller is
 * `promptCommand`, and it calls this only AFTER an attempt that already failed,
 * which by definition was not applied. A successful first attempt never reaches
 * here, so no prompt is ever sent twice.
 */
export async function postProbe(
  client: ServeClient,
  path: string,
  body: unknown,
): Promise<{ readonly status: number; readonly contentType: string; readonly body: string; readonly spaFallback: boolean }> {
  const res = await requestPathOf(client)(path, { method: 'POST', body: JSON.stringify(body) });
  const raw = await res.text().catch(() => '');
  return {
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
    body: raw.length > 1_200 ? `${raw.slice(0, 1_200)}…` : raw,
    spaFallback: spaFallbackContentType(res) !== null,
  };
}

/**
 * Serve's own OpenAPI document.
 *
 * MEASURED 2026-09-30: the real spec is `GET /doc`. `GET /openapi.json` answers
 * the SPA fallback — 200, `text/html`, 2 884 bytes — so reading a version from it
 * is reading a web page. `probeContract()` in `runtime/client.ts:1091` still asks
 * for it; this reports the real one and says which is which, because a route claim
 * that cites the wrong document is a route claim that proves nothing.
 */
export async function readSpec(client: ServeClient): Promise<{ readonly path: string; readonly paths: number; readonly bytes: number; readonly error: string | null }> {
  const probe = await probeRoute(client, '/doc');
  if (probe.kind !== 'json' || typeof probe.json !== 'object' || probe.json === null) {
    return { path: '/doc', paths: 0, bytes: probe.bytes, error: probe.error ?? 'not a JSON document' };
  }
  const doc = probe.json as { paths?: unknown };
  const keys = Object.keys(doc.paths ?? {});
  return { path: '/doc', paths: keys.length, bytes: probe.bytes, error: null };
}
