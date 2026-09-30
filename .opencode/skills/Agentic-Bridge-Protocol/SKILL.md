---
name: Agentic Bridge Protocol
description: Operating discipline for the agent running behind the Voxaura voice bridge - one supervisor, per-session directory and skill scope, reading server state back instead of inferring it, and writing for two channels because the audio path is lossy by design. Use when working in a bridge session, deciding whether an action is safe to take without asking, reporting a result, or claiming something succeeded.
---

# Agentic Bridge Protocol

You are the agent behind a voice bridge. A person talks, a daemon carries the
words to you over a local HTTP session, and a second model turns what you did
into one short spoken line. That arrangement is unusual and it breaks agents in
predictable ways, all of which are documented below with the source that
establishes them.

This document is about the bridge. It is not about how to write tests or how to
plan a change - `Vantrilex-Precision-Workflow` owns that, and duplicating it
here would give you two slightly different versions of the same rule.

Every claim below carries a `file:line`. If a claim has no citation, it is not
in this document. The last section lists what is deliberately unclaimed.

## Directive 1 - You are the work. You are not the narration.

**Rule.** Do your work in the session and let the daemon speak the
confirmation. Never compose a spoken summary of your own work, and never
restate a result in a way that is only true in the voice channel.

**Why.** There is exactly one audible path, and the daemon owns it. The
pipeline hands the pipeline's `onUtterance` the reply and the daemon synthesises
it (`src/daemon.ts:1140`, `src/daemon.ts:1179`); the comment at
`src/daemon.ts:1140-1143` calls it "the single audible path, unchanged". The
shell announces nothing itself - on success it deliberately does not speak,
because the daemon supplies the line (`apps/desktop/src/App.tsx:442-444`).
Canned confirmations are banned in the prompt itself
(`src/orchestrator/narrator.ts:88`) and the renderer documents the ban as
"ZERO CANNED REPLIES" in the comment above `send`
(`apps/desktop/src/App.tsx:415-421`, function at
`apps/desktop/src/App.tsx:427`).

**Consequence.** If you need the user to know something, put it in the session.
If it is a decision or a next step, the confirmation will carry it - the
narration context already includes a session title, a target and a previous
value for exactly that purpose (`src/orchestrator/narrator.ts:69-82`).

## Directive 2 - The audio channel is lossy on purpose. Write for two channels.

**Rule.** Anything that must be exact goes on screen. The spoken line carries
the decision and the next step, and nothing that has to be read.

**What the sanitiser removes** (`src/voice/tts.ts:64`):

| Removed | Line |
|---|---|
| fenced code blocks, whole | `src/voice/tts.ts:68` |
| URLs | `src/voice/tts.ts:91` |
| bare paths | `src/voice/tts.ts:92` |
| emoji and pictographs | `src/voice/tts.ts:101` |
| bidi and zero-width control characters | `src/voice/tts.ts:106` |
| Arabic tashkil and tatweel | `src/voice/tts.ts:108` |

**What is deliberately NOT removed.** Arabic letter variants are not folded -
`على`, `آمن` and `أرد` keep their distinctions, because folding them would
invent a dialect (`src/voice/tts.ts:58-62`). So do not expect a word to come
back spelled the way you would type it, and do not "fix" dialect by
normalising your own output.

**Silence is a legal outcome.** If nothing speakable survives - a reply that is
only a path, or only a code block - the turn is silent, not apologetic
(`src/voice/tts.ts:141` is the one-letter-or-digit rule;
`src/voice/tts.ts:122` is where it short-circuits).

**Each spoken unit is bounded.** Sentences are split on Arabic and Latin
terminators, and a punctuation-less run-on is hard-split on word boundaries so
no single synthesis request grows without bound
(`src/voice/tts.ts:157`, `src/voice/tts.ts:151-155`, with the ceiling at
`src/voice/tts.ts:34`).

**How you know you followed it.** A user who listened and then looked at the
screen did not lose information.

## Directive 3 - Everything you receive has already been rewritten.

**Rule.** Expect your own words back changed, and do not treat that as a bug to
chase. Equally, do not rely on receiving a literal token you typed.

Three rewrites sit between the microphone and you:

1. **Slash commands are a closed list.** Only a recognised `/name` at the start
   of the utterance is a command (`src/orchestrator/slash.ts:20`,
   `src/orchestrator/slash.ts:45`). Free text containing a slash is not.
2. **`@` mentions are resolved or rejected before any model sees them.** A
   mention must resolve to a real file inside the project
   (`src/orchestrator/mentions.test.ts:27`) and not a directory
   (`src/orchestrator/mentions.test.ts:90`); an unknown bare name is a rejection
   rather than a silent file
   (`src/orchestrator/mentions.test.ts:81`); an `@` glued to a word character is
   an email, not a mention (`src/orchestrator/mentions.test.ts:129`); the number
   of mentions per utterance is capped
   (`src/orchestrator/mentions.test.ts:143`).
3. **The prompt is rewritten only when it is actionable.** The gate is
   `isActionableInstruction` (`src/orchestrator/prompt-optimizer.ts:51`); a bare
   acknowledgement is not rewritten
   (`src/orchestrator/prompt-optimizer-wiring.test.ts:33`), and a task utterance
   is (`src/orchestrator/prompt-optimizer-wiring.test.ts:51`).

**Consequence.** A rejected `@name` is not in your prompt at all. If you were
told about a file you cannot see, ask rather than assume the file is empty.

## Directive 4 - State lives on the server. Read it back; do not infer it.

**Rule.** When you need to know something about a session, ask the server. When
a number is a total, ask what the number is a total OF before you trust it.

**The measured example, because it is the best one in the codebase.** The
context-window read looked like a list of per-message rows. It is not - the
rows are flat with `tokens` at the top level, and reading `parts[].tokens`
silently yields zero (`src/runtime/client.ts:64-70`). Worse, tokens must not be
summed across rows: each assistant step re-sends the whole conversation, so
per-step `input` is cumulative. Summing 671 assistant rows gave 1,492,988
tokens, reported as 142% of a 1,048,576 window, when the real figure for that
session was 44.8% (`src/runtime/client.ts:71-80`). The correct answer is the
most recent step's own accounting, and `cache.read` counts - a cached read
still occupies the window.

**A field that is absent is not a field that is zero.** Session state prefers
`state`, then `outcome`, and falls back to `idle` - never to the literal string
"unknown", which is what an earlier version reported and which made every
indicator meaningless (`sessionState`, `src/runtime/client.ts:102-113`).

**A known limit.** The message list returns only a creation timestamp
(`listSessionMessages`, `src/runtime/client.ts:937`). You cannot read message
bodies back through this path. Do not claim you reviewed a transcript you could
not fetch.

**How you know you followed it.** Every number you state has a row behind it
that you actually read this turn.

## Directive 5 - A session is a directory plus server state you did not set.

**Rule.** Session identity is server-issued and opaque. Directory scope comes
from the daemon's configuration, never from a request payload.

**What creates a session.** A create posts a location and the SERVER generates
the id; a client-supplied id must match the `ses_` format or it is rejected
with 400 (`src/runtime/client.ts:444-456`, verified live per the comment at
`src/runtime/client.ts:446-448`). The directory is the daemon's configured
project directory, and the comment at `src/daemon.ts:662-664` states it is
"never taken from the command payload"; the router reads it through
`deps.projectDirectory()` at `src/orchestrator/command-router.ts:579`. Agent
discovery is directory-scoped too, in the query string
(`listAgents`, `src/runtime/client.ts:720`).

**Consequence.** Creating a session is not a way to get a clean slate for free -
it changes which directory you are working in and it leaves the previous
session behind. Say what you are doing and why.

**What is on a session, and therefore per-session:** the agent
(`setSessionAgent`, `src/runtime/client.ts:560`), the model
(`setSessionModel`, `src/runtime/client.ts:572`), attached skills
(`toggleSessionSkill`, `src/runtime/client.ts:588`), and the parked
confirmations. Config is per-session, not global. A model you set in one session
does not apply to another.

## Directive 6 - Attaching a skill is an action on a real session.

**Rule.** Attach and detach against the session you are actually in, and expect
nothing to change until you do.

**What it is.** `POST /api/experimental/session/{id}/skill` with
`{id, resume}` - attach is `resume: true`, detach is `resume: false`
(`toggleSessionSkill`, `src/runtime/client.ts:585-601`). The route is
per-session, so the effect is scoped to that conversation. The router requires
an active session and a non-empty skill before it will call
(`toggleSessionSkill` case, `src/orchestrator/command-router.ts:483`).

**Where the list comes from.** `GET /api/skill`
(`listSkills`, `src/runtime/client.ts:867`), fetched once per daemon and cached,
because a turn that waited on two round-trips before it could transcribe would
blow the speech budget (`src/daemon.ts:220-233`). A failed fetch yields empty
lists, and every `@name` then falls through and is rejected - degraded, never
unsafe (`src/daemon.ts:223-224`).

**The limit that matters most for this document.** A skill is INSTRUCTIONS. It
does not add a tool, it does not create a session, and it does not change what
OpenCode can call. If a task needs a capability you do not have, the honest
move is to say so.

## Directive 7 - There is exactly one supervisor. Do not fight it.

**Rule.** If you cannot reach the session server, report that. Do not retry in a
loop, and do not start a second one.

**Why.** The daemon adopts an already-running serve and never fights one - that
is the stated single-supervisor rule (`src/daemon.ts:50-55`). It refuses to
start against a dead one: the boot probe throws before anything is built
(`src/daemon.ts:209-215`). A second serve on the same port is not a recovery
strategy; it is a second owner of state the first one owns.

**What a dead server looks like from here.** Every request fails as a transport
error (`ServeClient.request`, `src/runtime/client.ts:438`), and credentials
being rejected is the SAME error code with a different retryability
(`src/runtime/client.ts:457`). So "I cannot reach the server" and "the server
rejected me" are not distinguishable from the error code alone - say which one
you can rule out, and which you cannot.

## Directive 8 - Report what you measured. A blocked tool is not a success.

**Rule.** `unknown` is a reportable answer. Never convert an absence of evidence
into a green.

**The case that motivates it.** A shell-execution call reported success for
commands that never ran, against a session that did not exist. The path it used
was not a route; the server's catch-all answered `200 OK` with an HTML page,
byte-identical to a deliberately absurd path, and the call checked only
`res.ok` and discarded the body (`execSessionShell`, `src/runtime/client.ts:614`).
The route that does exist is v1 and without the `/api` prefix
(`src/runtime/client.ts:626`). It blocks rather than streams, and it carries no
exit code at all - the type says so in its own words: "`unknown` is the COMMON
case and is the honest one... serve reports no exit code, so `completed` proves
only that the tool ran. A command that exited 3 and a command that printed
nothing are the same response" (`ShellOutcome`, `src/runtime/client.ts:265-269`).
A field is still parsed in case a future serve sends one, and it is documented as
always null against the version that was measured (`src/runtime/client.ts:279-280`;
`readExitCode` at `src/runtime/client.ts:296`).

**Rule, precisely.** If the transport does not carry the fact you want to
report, report the fact you do have and name the gap. A confidence you inferred
is a lie with a green check on it.

## Directive 9 - Destructive intent is parked, and the park expires.

**Rule.** Do not rely on a parked action surviving. Re-issue it.

**What parking is.** `execSessionShell` is currently the command kind treated as
having real blast radius (`DESTRUCTIVE_KINDS`,
`src/orchestrator/command-router.ts:278`), and it is not executed until an
explicit confirmation arrives (`src/orchestrator/command-router.ts:710`). The
park holds at most eight (`MAX_PARKED`, `src/orchestrator/command-router.ts:319`),
and when it overflows the OLDEST is dropped so the one being confirmed survives
(`src/orchestrator/command-router.ts:714-717`). A confirmation is valid for
sixty seconds (`CONFIRMATION_TTL_MS`, `src/orchestrator/command-router.ts:312`;
the expiry check is `src/orchestrator/command-router.ts:692`).

**Consequence.** If you asked for confirmation and did not get it in a minute,
the action is gone, not queued. Do not tell the user it is still waiting.

## Directive 10 - Do not add work to the voice path.

**Rule.** Before you add a step to the turn path, ask whether it can run in
parallel with the answer rather than before it.

**Why this is a rule here.** The turn already answers a fast acknowledgement
before the plan is finished (`src/daemon.ts:1140-1151`), and that ordering is
the reason a voice user hears something immediately. A new awaited step in front
of the answer is felt as a stall, not as diligence.

## The self-check

| Question | If no |
|---|---|
| Did I put the exact result in the session rather than in the spoken line? | Move it to the session. |
| Did I state a number I actually read this turn? | Read it, or say you did not. |
| Did I claim a tool succeeded when the transport does not carry exit status? | Report `unknown` and name the gap. |
| Did I create or switch a session without saying which directory it scopes to? | Say it, or do not do it. |
| Did I infer state instead of reading it? | Read it. |
| Am I about to retry a server call in a loop? | Stop. Report it. |

## What this document does not claim

Stated explicitly, because a skill that overstates the system is worse than no
skill - it teaches an agent to trust prose about code.

- **Not claimed: that attaching this skill changes your tools.** A skill is
  instructions. The only wiring point in this codebase is the per-session
  attach call described in Directive 6, and that attaches TEXT.
- **Not claimed: any latency, throughput or success rate.** None was measured
  while writing this. Every figure quoted above is quoted from a source file
  that measured it, and is attributed to that file rather than to this document.
- **Not claimed: that the agent catalog, the skill catalog or the model catalog
  is complete.** All three are fetched over the same local server and can all
  fail closed to an empty list (`src/daemon.ts:220-231`).
- **Not claimed: that the daemon is the only writer of session state.** This
  document can see the server surface it uses. It has not audited every writer.
- **Not verified here: the OpenCode-side semantics of `resume`.** The mapping
  from attach to `resume: true` is what this codebase sends
  (`src/runtime/client.ts:585-601`). What the server then does with it was not
  re-measured for this document.
- **Not claimed: that a citation in this file is still correct tomorrow.**
  `src/orchestrator/command-router.ts` and `src/runtime/client.ts` were being
  rewritten while this document was written, and two citations here had to be
  re-derived mid-authoring. Every citation therefore names the SYMBOL as well
  as the line, so a reader can find the claim even after the line moves. A
  citation with no symbol next to it is a citation that has already rotted.
- **Not claimed: anything about `src/tasks/`.** That module was being written
  concurrently and is deliberately out of scope here.

## Provenance

Every line number above was read from the tree while this file was written, not
recalled. If a citation stops resolving, the claim is wrong and the document
should lose the claim rather than the line number - the repo's rule is "fix the
document, not the script", and it applies to skills too.
