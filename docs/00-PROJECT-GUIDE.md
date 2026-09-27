# Voxaura / opencode-voice-runtime — Complete Project Guide

![Voxaura application icon](../assets/icon.svg)

*One document describing the whole system in plain language. Technical claims
below reflect the implemented code as verified live in September 2026; the
older numbered spec files (`docs/01`–`docs/28`) are frozen design documents
and differ from reality in places — see §12.*

## 1. What this is (30 seconds)

**Voxaura** is a desktop companion app for developers who work with AI coding
agents. You talk to it (in Arabic, with two voice personas), and it operates
**OpenCode v2** — an AI agent runtime — on your behalf: running coding
sessions, switching models, executing commands, and speaking results back.

**Package name:** `opencode-voice-runtime` · **Version:** 0.6.2 · **License:** MIT

Think of it as three layers:

| Layer | What it is | Technology |
|---|---|---|
| **Shell** | The window you see: buttons, session chips, settings | Tauri v2 + React 18 (`apps/desktop/`) |
| **Daemon** | The brain of the operation: background Node.js service | TypeScript on Node ≥ 22 (`src/`) |
| **Engine** | The AI agent runtime doing the actual work | OpenCode v2 `serve` 2.0.12 (untouched upstream) |

Golden rule: **we never modify OpenCode itself.** The daemon only talks to it
through official APIs. This keeps us immune to upstream updates.

## 2. How the pieces connect

```text
┌──────────────┐   WebSocket    ┌──────────────────┐   HTTP        ┌────────────────┐
│ Voxaura shell│◄── WS-4097 ──►│  Node daemon     │◄── /api ─────►│ opencode serve │
│ (display +   │  hello/ack/   │  (orchestrator,  │  Basic auth   │ (29 sessions,  │
│  buttons)    │  inventory)   │  queue, ledger)  │  port 4096    │  shared DB)    │
└──────────────┘               └────────┬─────────┘               └────────────────┘
                                        │ skills · vault · RAG · voice
                               ┌────────▼─────────┐
                               │ Dots3 → Nemotron │  AI role chain
                               │     → Inkling    │  (intake → boss → worker)
                               └──────────────────┘
```

- **Shell ↔ daemon:** a versioned WebSocket protocol called WS-4097
  (`voice-ui.v1`, path `/v1/ui`). Token login, auto-resume with `?lastSeq=`.
- **Daemon ↔ engine:** plain HTTP (`/api/session`, `/api/event`) with
  `opencode:<password>` Basic auth. Controls answer `204 No Content`.
- **One supervisor:** exactly one daemon may own the engine. Stray processes
  are shut down automatically — two writers would corrupt the database.

## 3. A voice request, end to end

1. **You speak.** The mic captures audio; Groq Whisper transcribes it
   (`whisper-large-v3-turbo`, Arabic-aware).
2. **The brain understands.** Nemotron (via OpenRouter) reads the transcript
   and returns strict JSON: `{intent, control, reply}` — what you want, any
   control action, and what to say back.
3. **Danger check (FR-12).** Words like *delete / destroy / deploy / rm -rf*
   always trigger an explicit confirmation first. No exceptions.
4. **Dispatch.** The orchestrator queues the task, sends it to the right
   OpenCode session (each prompt gets a `msg_…` receipt), and retries on
   `busy` with backoff. Duplicates are dropped by event id.
5. **You hear back.** Fish Audio speaks the reply (Kareem or Nour voice);
   frequent phrases are served from a 50-clip cache. Everything is written to
   an audit ledger.

Measured live: serve answers in ~125 ms, voice reply first-chunk in
~650–2000 ms depending on network, bridge hello in ~16 ms.

## 4. Sessions, agents, models (the OpenCode concepts)

- **Session** (`ses_…`): one conversation with the AI. 29 live on the shared DB.
- **Agent** (`build`, `architect`, `code-reviewer`, …): a role preset — 17 are
  auto-discovered per project, including all 12 repo-defined specialists.
- **Model** (`provider/model`, e.g. `openrouter/nvidia/nemotron-…:free`): the
  LLM answering. Switchable per session with one POST; the desktop shows a
  live dropdown fed by the daemon.

## 5. Every AI model in the system

| Job | Provider | Exact model | Status |
|---|---|---|---|
| Conversational intake | OpenRouter | `dots-studio/dots-3-note-preview:free` | **Live** |
| Master coordinator & brain | OpenRouter | `thinkingmachines/inkling:free` | **Live** |
| Sub-agent execution driver | OpenRouter | `thinkingmachines/inkling:free` | **Live** |
| Session default | OpenRouter | Nemotron (same slug) | **Live** |
| Speech-to-text | Groq | `whisper-large-v3-turbo` | **Live** |
| Text-to-speech | Fish Audio | `s2.1-pro-free` | **Live** |
| Voices | Fish Audio refs | Kareem `5b90451e…`, Nour `88c0375e…` | **Live** |

No API keys exist in code — ever. Keys come from environment variables or the
encrypted vault (below), and the program refuses to run brain features when a
key is missing instead of guessing.

## 6. Security model (the parts that protect you)

- **Encrypted vault** (`vault/keyring.dat`): AES-256-GCM, per-pool nonces,
  checksums verified before decrypting, machine-bound key file, memory wiped
  after each use. Corruption refuses loudly instead of half-opening.
- **Zero-secret discipline:** keys are never printed, logged, tested, or
  committed. The `doctor` command reports "1 key present", never the key.
  Verified by forensic scan: 350 files, zero leaks.
- **FR-12 confirmation:** any destructive act requires your explicit yes.
- **Fail-closed errors:** unknown session → stop; busy → retry later; bad
  credentials → stop everything. The system never improvises past an error.
- **Backups:** the shared database is backed up before any mutation.

Closed audit items (ledger: `docs/10-CHECKPOINT.md` → Security remediation):

| Item | State |
|---|---|
| H1 unconfirmed destructive exec | closed — FR-12 parks shell acts until explicit `confirm` (proven E2E) |
| H2 no production daemon | closed — `src/daemon.ts` composition root + `serve` CLI |
| H3 keys could not persist | closed — `saveApiKeys` → encrypted vault pools |
| H4 token baked into bundle | closed — per-install IPC token (0600), runtime-fetched |
| M2 broad `core:default` | accepted with rationale, then closed — enumerated least-privilege caps |
| M3 thin CSP | closed — hardened directives incl. `object-src 'none'` |
| M4 unbounded inbound frame | closed — 1 MiB cap before allocation |
| M6 persona no-op / stale pill | closed — truthful state + 45 s staleness watchdog |
| Job Object teardown | closed — `KILL_ON_JOB_CLOSE`, zero orphans on force-kill |

## 7. Memory: the Obsidian vault

The daemon remembers across restarts using plain Markdown notes
(`vault/projects/voxaura/`): overview, architecture, live state,
append-only decisions log, session history, and skills used — plus a master
index (`vault/indexes/MOC-master.md`). One fact per note, linked not copied.
On a fresh install the notes scaffold themselves automatically; existing notes
are never overwritten. Secrets are banned from notes by rule.

## 8. How quality is proven

| Gate | Command | Current score |
|---|---|---|
| Unit + type + lint | `npm run test:vantrilex` | **309 pass** (220 root + 89 desktop), 0 warnings |
| Shell E2E | `npm run test:e2e` (Playwright) | **15/15** |
| Pre-flight | `node dist/cli.js doctor` | environment + serve health |
| Live console | `node scripts/live_console_test.ts` | real serve, TTS, STT, VAD |
| Packaging | `node scripts/packaging-preflight.mjs` | 14/15 (only MSVC linker missing) |

Known live findings (Sept 2026 field test): transport fully healthy (serve
200 in 125 ms; TTS/STT succeed every run); the Groq direct-brain path was
retired to OpenRouter after repeated empty/non-JSON completions; the stored
OpenRouter credential returns 401 and must be rotated by the operator.

## 9. Operating it (only commands that exist)

```bash
npm install && npm run build
node dist/cli.js doctor            # health: env names, serve reachability
node dist/cli.js vault bootstrap   # move key pools into the encrypted vault
node dist/cli.js live              # full voice round-trip + latency report
npm run test:vantrilex             # all gates
cd apps/desktop && npm run dev     # desktop shell (needs your screen)
```

Environment: `OPENCODE_SERVER_PASSWORD`, `GROQ_API_KEYS`, `FISH_AUDIO_KEYS`,
`OPENROUTER_API_KEY`, `VOXAURA_VAULT_DIR` (optional vault location).

**Platform scope (locked):** Windows is the only supported target. The NSIS
installer (`Voxaura_0.5.0_x64-setup.exe`) bundles node.exe plus the pruned
runtime sidecar; the Job Object teardown, tray/hotkey supervisor, and all E2E
proof run on Windows. macOS and Linux builds are **officially deferred** until
the Windows target reaches complete long-term stability — no bundle-ID rename,
no AppImage work until then.

## 10. Key files map

| Path | What lives there |
|---|---|
| `src/ipc/protocol.ts` | Frozen WS-4097 frames (never break these) |
| `src/runtime/client.ts` | Typed serve client (auth, sessions, prompts, controls) |
| `src/orchestrator/` | Queue, backpressure, inventory, command router |
| `src/voice/` | STT, brain, TTS, vault, keyring |
| `src/memory/vault.ts` | Obsidian self-bootstrap logic |
| `apps/desktop/src/` | Shell UI, WS bridge, E2E suite |
| `opencode.json` | Model default, provider slugs, MCP servers |
| `.opencode/agents/` + `skills/` | 12 agents, 16 skills (incl. Inkling + bridges) |
| `docs/10-CHECKPOINT.md` | Gate ledger — the project's lab notebook |
| `vault/` | Encrypted keys (ignored) + memory notes (tracked) |
| `assets/` | Whiteboard SVG suite + app icons |
| `README.md` / `README.ar.md` | English whitepaper / full Arabic manual |

## 11. Glossary

**Daemon** — the background Node service doing the work. **Serve** — the
OpenCode engine. **Session** — one AI conversation. **Agent** — a role preset.
**WS-4097** — our WebSocket dialect. **FR-12** — ask-before-destroy rule.
**Ledger** — append-only audit log. **Harness** — the live test script.
**TTS/STT** — text-to-speech / speech-to-text. **TTFB** — time to first audio
byte (budget 800 ms).

## 12. A note on the older spec docs

`docs/01`–`docs/28` were written as a frozen design suite before much of the
system existed. Where they conflict with this guide (extra CLI commands,
Bearer auth, mobile relay, DPAPI vault, Groq-only brain), **this guide and
the code win**. Treat the numbered specs as history, not instructions.
