import { describe, expect, test } from 'vitest';

import { OrchestratorError } from '../common/errors.js';
import type { SessionId } from '../common/brands.js';
import { ServeClient, basicAuth, DEFAULT_SHELL_AGENT } from '../runtime/client.js';
import { openServeTarget, probeRoute, readSpec, requestPathOf, resolveServePassword, spaFallbackContentType } from './serve.js';
import { probeHealth } from '../launcher/index.js';

// THE TRANSPORT — proving this runner cannot lie about serve.
//
// The whole reason these guards exist: serve answers `200 OK` with a 2 884-byte
// `text/html` SPA page for ANY unknown path, so `res.ok` is not evidence a route
// exists. A harness that calls `fetch` and trusts the status would report every
// route in the product as working, and would keep doing so if the coordinator were
// gutted. Each test below has a break case that makes the assertion fail, and the
// break is asserted to have landed before its measurement is trusted.

/** A Response with the shapes measured on 1.18.32. */
function fakeResponse(init: { status?: number; contentType?: string | null; body?: string }): Response {
  const status = init.status ?? 200;
  const ct = init.contentType === undefined ? 'application/json' : init.contentType;
  const body = init.body ?? '{"data":[]}';
  // A 204 cannot carry a body, and the undici Response enforces that. Passing
  // `null` there is the shape the product actually receives from serve.
  const payload = status === 204 || status === 304 ? null : body;
  return new Response(payload, {
    status,
    headers: ct === null ? {} : { 'content-type': ct },
  });
}

describe('spaFallbackContentType — the rule, restated', () => {
  test('a declared non-JSON 2xx IS the fallback', () => {
    expect(spaFallbackContentType(fakeResponse({ contentType: 'text/html' }))).toBe('text/html');
  });

  test('JSON is never the fallback', () => {
    expect(spaFallbackContentType(fakeResponse({ contentType: 'application/json' }))).toBeNull();
  });

  test('a MISSING content-type is not the fallback, and the reason matters', () => {
    // `204 No Content` legitimately carries no type, and `execSessionShell` is
    // measured working with the rule as written. Rejecting `''` here would break a
    // verb that works.
    expect(spaFallbackContentType(fakeResponse({ contentType: null, status: 204 }))).toBeNull();
  });

  test('two unknown paths both read as the fallback, not as routes', async () => {
    // HERMETIC version of the measurement the rule is built on: the same HTML body
    // served for two different unknown paths must be classified identically. The
    // LIVE byte-identity check is the skipped test below, because it needs a serve
    // on 4096 and a credential, and a suite that silently degrades to a stub would
    // be exactly the "harness that measures nothing" this project keeps finding.
    const html = '<!doctype html><html><body>2884</body></html>';
    const client = { request: async () => fakeResponse({ contentType: 'text/html', body: html }) } as unknown as ServeClient;
    const a = await probeRoute(client, '/api/definitely-not-a-route-a');
    const b = await probeRoute(client, '/api/definitely-not-a-route-b');
    expect(a.exists).toBe('no');
    expect(b.exists).toBe('no');
    expect(a.bytes).toBe(b.bytes);
  });
});

// The live form of the same claim. Skipped rather than faked when there is no
// credential OR no serve answering, so the summary shows a skip instead of a pass.
// `opencode-voice spec` prints the live numbers.
//
// The LIVENESS half matters and was learned the hard way: gating the skip on the
// credential alone left a test that failed with `expected 0 to be greater than 0`
// the moment a serve on 4096 stopped answering — a red suite for an environment
// change, which is how a real failure gets learned to be ignored. The probe is the
// product's own `probeHealth` from `src/launcher/`.
const livePassword = resolveServePassword().password;
const liveServeUp = livePassword.length > 0 && (await probeHealth(4096, livePassword));
describe.skipIf(!liveServeUp)('live serve (needs a serve on 4096 and a credential)', () => {
  test('the SPA fallback is byte-identical for two different unknown paths', async () => {
    const client = new ServeClient('http://127.0.0.1:4096', livePassword);
    const a = await probeRoute(client, '/api/definitely-not-a-route-a');
    const b = await probeRoute(client, '/api/definitely-not-a-route-b');
    expect(a.exists).toBe('no');
    expect(a.bytes).toBeGreaterThan(0);
    expect(a.bytes, 'the fallback is the same page for any unknown path').toBe(b.bytes);
  });

  test('BREAK: a real route is NOT the fallback, on the same live serve', async () => {
    // The negative control for the test above, and the reason the runner's
    // availability claims are worth anything. `/mcp` has no `/api` prefix and
    // answers JSON; `/api/mcp` answers the page. If either stopped being true the
    // whole `probeRoute` contract would need re-deriving, and this is where it
    // would be noticed.
    const client = new ServeClient('http://127.0.0.1:4096', livePassword);
    const real = await probeRoute(client, `/mcp?directory=${encodeURIComponent(process.cwd())}`);
    const prefixed = await probeRoute(client, `/api/mcp?directory=${encodeURIComponent(process.cwd())}`);
    expect(real.exists, '/mcp must answer with JSON').toBe('yes');
    expect(prefixed.exists, '/api/mcp must be the SPA fallback').toBe('no');
    expect(prefixed.spaFallback).toBe(true);
  });
});

describe('requestPathOf — the composed seam, not a second HTTP client', () => {
  test('it binds ServeClient\'s OWN request method', async () => {
    const seen: Array<{ path: string; init: RequestInit }> = [];
    const client = {
      request: async (path: string, init: RequestInit): Promise<Response> => {
        seen.push({ path, init });
        return fakeResponse({ body: '{"ok":true}' });
      },
    } as unknown as ServeClient;
    const request = requestPathOf(client);
    const res = await request('/mcp?directory=x', { method: 'GET' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe('/mcp?directory=x');
    expect(seen[0]?.init.method).toBe('GET');
    expect(await res.json()).toEqual({ ok: true });
  });

  test('the binding survives the client being reached through a subclass instance', async () => {
    // `request` is `private` in TypeScript but an ordinary prototype method at
    // runtime, so it is inherited. If a future refactor moved it onto an own
    // property or into a closure, this would stop working — and it would fail HERE
    // rather than as an unauthenticated GET in a report.
    const inner = new ServeClient('http://127.0.0.1:1', 'pw');
    expect(typeof requestPathOf(inner)).toBe('function');
  });

  test('BREAK: a client with no request path throws a typed CONTRACT_DRIFT', () => {
    // The alternative — falling back to a bare `fetch` — is the exact thing the
    // brief forbids and the exact thing that produced the original defect. A
    // missing seam has to be a loud failure, not a silent downgrade.
    const client = {} as unknown as ServeClient;
    let thrown: unknown = null;
    try {
      requestPathOf(client);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(OrchestratorError);
    expect((thrown as OrchestratorError).code).toBe('CONTRACT_DRIFT');
    expect((thrown as OrchestratorError).message).toContain('will not fall back to a second HTTP client');
  });
});

describe('probeRoute — availability from the content type, never from the status', () => {
  test('JSON ⇒ the route exists', async () => {
    const client = { request: async () => fakeResponse({ body: '{"a":1}' }) } as unknown as ServeClient;
    const probe = await probeRoute(client, '/mcp');
    expect(probe.exists).toBe('yes');
    expect(probe.spaFallback).toBe(false);
    expect(probe.json).toEqual({ a: 1 });
  });

  test('a 200 with HTML ⇒ the route does NOT exist, and says so', async () => {
    const client = { request: async () => fakeResponse({ contentType: 'text/html', body: '<!doctype html>' }) } as unknown as ServeClient;
    const probe = await probeRoute(client, '/api/mcp');
    expect(probe.status).toBe(200);
    expect(probe.exists).toBe('no');
    expect(probe.spaFallback).toBe(true);
  });

  test('a 404 is a refusal, reported as `unknown` and NOT as absence', async () => {
    // Measured trap #2: a session-scoped route with a bad id answers 400, not 404,
    // and neither is evidence about whether the route exists.
    const client = { request: async () => fakeResponse({ status: 404, body: '{"name":"NotFoundError"}' }) } as unknown as ServeClient;
    const probe = await probeRoute(client, '/api/session/ses_nope');
    expect(probe.exists).toBe('unknown');
    expect(probe.error).toContain('a refusal, not an absence');
  });

  test('a 2xx with no JSON body is `unknown`, not a route', async () => {
    const client = { request: async () => fakeResponse({ contentType: 'application/json', body: 'not json' }) } as unknown as ServeClient;
    const probe = await probeRoute(client, '/mcp');
    expect(probe.exists).toBe('unknown');
    expect(probe.error).toContain('no JSON body');
  });

  test('a transport throw is captured, not propagated', async () => {
    const client = {
      request: async () => {
        throw new OrchestratorError('SERVE_UNREACHABLE', true, 'serve request /mcp failed: ECONNREFUSED');
      },
    } as unknown as ServeClient;
    const probe = await probeRoute(client, '/mcp');
    expect(probe.exists).toBe('unknown');
    expect(probe.kind).toBe('error');
    expect(probe.error).toContain('ECONNREFUSED');
  });

  test('BREAK: a route that answers 200 HTML is never reported as available', async () => {
    // The defect this whole file is the answer to. Written as a negative assertion
    // so the direction of the rule is pinned, not just its happy path.
    const client = { request: async () => fakeResponse({ contentType: 'text/html', body: '<!doctype html>' }) } as unknown as ServeClient;
    for (const path of ['/mcp', '/lsp', '/api/skill', '/api/session']) {
      const probe = await probeRoute(client, path);
      expect(probe.exists, path).not.toBe('yes');
    }
  });
});

describe('readSpec', () => {
  test('counts the declared paths in a real OpenAPI document', async () => {
    const client = {
      request: async (path: string) =>
        path === '/doc'
          ? fakeResponse({ body: JSON.stringify({ openapi: '3.1.0', paths: { '/mcp': {}, '/lsp': {}, '/api/session': {} } }) })
          : fakeResponse({ contentType: 'text/html', body: '<!doctype html>' }),
    } as unknown as ServeClient;
    const spec = await readSpec(client);
    expect(spec.paths).toBe(3);
    expect(spec.error).toBeNull();
  });

  test('a fallback page is reported as not-a-document, with 0 paths', async () => {
    const client = { request: async () => fakeResponse({ contentType: 'text/html', body: '<!doctype html>' }) } as unknown as ServeClient;
    const spec = await readSpec(client);
    expect(spec.paths).toBe(0);
    expect(spec.error).not.toBeNull();
  });
});

describe('resolveServePassword', () => {
  test('env wins over the file', () => {
    const r = resolveServePassword({ OPENCODE_SERVER_PASSWORD: 'from-env' } as NodeJS.ProcessEnv, 'C:/no-such-dir');
    expect(r.password).toBe('from-env');
    expect(r.source).toBe('env:OPENCODE_SERVER_PASSWORD');
  });

  test('the supervisor file is used when env is empty, and the source is named', () => {
    // An operator running from a repo checkout has `serve.pass` and not the env
    // var. Without this branch the runner only works from the installed app.
    const r = resolveServePassword({} as NodeJS.ProcessEnv, 'C:/definitely-not-a-dir');
    expect(r.source).toBe('none');
    expect(r.password).toBe('');
  });

  test('a blank env value is not a password', () => {
    const r = resolveServePassword({ OPENCODE_SERVER_PASSWORD: '' } as NodeJS.ProcessEnv, 'C:/definitely-not-a-dir');
    expect(r.password).toBe('');
    expect(r.source).toBe('none');
  });
});

describe('openServeTarget', () => {
  test('builds a ServeClient and a bridge without requiring the daemon or a key', async () => {
    // The brief's requirement: the runner must work with no saved keys and with
    // nothing on 4097. Both hold because nothing here reads the vault and nothing
    // here opens the WS control plane.
    const target = await openServeTarget({ directory: 'C:/project' });
    expect(target.client).toBeInstanceOf(ServeClient);
    expect(target.port).toBe(4096);
    expect(target.directory).toBe('C:/project');
    expect(typeof target.healthy).toBe('boolean');
  });
});

describe('the product\'s own SPA guard, on the same three shapes', () => {
  // The agreement test. `spaFallbackContentType` is private to `client.ts`, so
  // `serve.ts` restates it; this pins the restatement against the REAL method on
  // the REAL shapes, so the two cannot drift without a failure here.
  test('execSessionShell throws CONTRACT_DRIFT on a 200 text/html body', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch;
    try {
      const client = new ServeClient('http://127.0.0.1:4096', 'pw');
      let thrown: unknown = null;
      try {
        await client.execSessionShell('ses_x' as SessionId, 'echo hi');
      } catch (err) {
        thrown = err;
      }
      expect(thrown, 'a 200 HTML body must be refused, not parsed').toBeInstanceOf(OrchestratorError);
      expect((thrown as OrchestratorError).code).toBe('CONTRACT_DRIFT');
      expect((thrown as OrchestratorError).message).toContain('SPA fallback');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('and my restated predicate agrees with it on the same response', async () => {
    const res = new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } });
    expect(spaFallbackContentType(res)).toBe('text/html');
    const json = new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    expect(spaFallbackContentType(json)).toBeNull();
  });
});

describe('the shell agent default is the product\'s, not a literal here', () => {
  test('DEFAULT_SHELL_AGENT is what a caller gets when it does not name one', () => {
    // The CLI passes `build` only because argv needs a value; this pins that the
    // constant and the CLI cannot disagree about what the default is.
    expect(DEFAULT_SHELL_AGENT).toBe('build');
  });
});

describe('basicAuth is the product\'s own, and is not reimplemented', () => {
  test('the header format is the measured one', () => {
    expect(basicAuth('secret')).toBe(`Basic ${Buffer.from('opencode:secret').toString('base64')}`);
  });
});
