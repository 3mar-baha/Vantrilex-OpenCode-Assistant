# `.opencode/hooks/` — imported lifecycle assets (provenance + status)

## Provenance

These files were harvested from the Vantrilex catalog registry
(`vantrilex-registry/hooks/`) during GATE 1 (`/arm`). They originate from
`worldflowai/everything-claude-code`:

| File | Source | Original purpose |
|---|---|---|
| `claude-code-hooks.json` | `hooks/hooks.json` | Claude Code hook definitions (PreToolUse/PostToolUse/SessionStart) |
| `session-start.sh` | `hooks/memory-persistence/session-start.sh` | Load previous context on session start |
| `pre-compact.sh` | `hooks/memory-persistence/pre-compact.sh` | Persist state before context compaction |

## Status: NOT AUTO-LOADED — reference only

**OpenCode v2 has no `.opencode/hooks/` loader.** These files use the Claude
Code hook schema (`https://json.schemastore.org/claude-code-settings.json`) and
will be ignored by OpenCode if left here as-is. They are retained as reference
material and as the behavioural specification to port.

The OpenCode v2 equivalent of a lifecycle hook is a **plugin** registered under
`.opencode/plugins/<name>/index.ts` using the plugin API
(`import { Plugin } from "@opencode-ai/plugin"` for the installed `1.18.31`
runtime). Relevant mechanisms:

- `ctx.session.hook("prompt", …)` — intercept user prompts before admission.
- `ctx.session.hook("context", …)` — modify system instructions / messages /
  tools / request options immediately before model dispatch.
- `ctx.tool.transform(…)` — wrap or override tool execution (e.g. run a
  typecheck after `edit`/`write`).
- `ctx.event.subscribe(…)` — observe the server event stream.

## Porting map (what each guard becomes)

| Imported guard | OpenCode v2 port |
|---|---|
| TypeScript check after editing `.ts`/`.tsx` | Tool transform wrapping `edit`/`write`, or a post-session `tsc --noEmit` status check |
| Auto-format JS/TS with Prettier after edits | Same wrap point; call the configured formatter after a successful write |
| Warn on `console.log` in modified files | `ctx.tool.transform` post-write scan, or a `context` hook that injects a reminder |
| Block creation of random `.md` files | `ctx.tool.transform` on `write`, reject paths outside `docs/` |
| Pre-compact state save | `ctx.session.hook("compaction", …)` — write state before the summary |
| Session-start context load | `setup(ctx)` on plugin load |

## Decision

Porting is deferred to a later step (it requires writing and testing a real
plugin against `@opencode-ai/plugin@1.18.31`). This directory is provenance, not
active enforcement. Do not claim these hooks are running.