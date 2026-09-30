---
name: Vantrilex Precision Workflow
description: The milestone-precision engineering discipline Vantrilex runs - plan before code, guards red-first and break-verified, re-scope a brief that measurement refutes, and never treat a passing test as evidence a feature ships. Use for any non-trivial change - planning a milestone, writing or repairing a guard test, implementing a spec item, or judging whether green is enough to ship.
---

# Vantrilex Precision Workflow

Vantrilex closed a 48-commit, five-milestone audit-closure run at `e866fee`. This
skill encodes the methodology that produced it and strips out everything that was
only ever true about that repo. The value is in the failure modes: every directive
below exists because the naive alternative either shipped a defect or shipped a
green suite that meant nothing.

Two rules govern the whole document.

- **A test proves a thing exists.** It does not prove the thing runs, is
  reachable from the real entrypoint, or is correct. Those are three claims and
  they need three kinds of evidence.
- **The plan is the artifact.** A milestone that starts in code has already lost
  the argument it was supposed to have.

## The loop

One item, one loop, one commit. The order is the discipline; the unit is the item.

| Stage | What happens | Gate before moving on |
|-------|--------------|-----------------------|
| **PLAN** | Write the item's write-set, its red-first guard, and the milestone's non-goals. No code. | Someone could predict the diff from the plan. Non-goals are written down. |
| **S1 — red** | Write the guard test. Run it. | It is **red**, and the failure message is the reason you predicted. A red for an unexpected reason is a finding, not a nuisance. |
| **S2 — minimal** | Smallest change that turns S1 green. No adjacent cleanup. | Item green **and** the full project gate green. |
| **BREAK** | Disable the fix, confirm red again, re-apply, confirm green. | Red on both sides of the change, and **proof the injection landed**. |
| **RE-DERIVE** | Update prose from the tree, not from memory. | The docs checker exits 0. |
| **COMMIT** | One item, one commit. Message records what measurement refuted. | — |
| **PEER** | Second-model review. Apply the dissent, including against already-committed code. | Dissent is answered in the commit message, not just acknowledged. |
| **CLOSE** | Milestone closes on a full green gate, never on a partial one. | Full gate green. |

Batching is declined every time. A milestone is a dozen commits, not one, and
the temptation to fold three items into one diff is the exact moment the
milestone stops being reviewable.

## Directive 1 — Precision over speed

**Rule.** One item per commit. Full gate before each commit. No batching, ever,
even when the items are adjacent and even when the gate is slow.

**Failure mode prevented.** A batched diff has no identifiable failure mode. When
it goes red you learn that *something* in four changes is wrong, and you bisect by
hand what the gate should have bisected for you.

**Worked example.** Vantrilex: 48 commits over five milestones, every one naming a
single item, interleaved with `docs:` commits that re-derived the affected figures
from the tree. The five milestones ran 12, 12, 14, 10 and 6 items (M1 through M5).

**How you know you followed it.** `git log` for the milestone reads as a list of
individually-named changes, not a handful of bundled feature commits.

## Directive 2 — A guard is real once you have seen it fail

**Rule.** S1 red before S2 green, always. Then break the guard and confirm it goes
red again. Then confirm the injection actually landed.

**Failure mode prevented — three distinct ones, all of which ship green:**

1. **The guard never could have failed.** Written to pass against the unfixed
   code for a reason nobody noticed.
2. **The guard measures the wrong thing.** It asserts on a derived value while the
   invariant lives in the accounting. Deleting the accounting violates the cap
   with a fully green suite.
3. **The break-run measured nothing.** A shell wrapper mangled the `-t` filter, the
   test never ran, and the break-run reported the guard SURVIVED. The pass was a
   pass because zero tests executed.

**Worked examples (Vantrilex).** `b2401be` records "all six dissents applied",
including two guards that were vacuous rather than merely weak: the byte-budget
test "measured the array instead of the accounting" — a missing decrement
violated the cap with a green suite — and the "ONE notice" test "stopped reading
at the first notice, so a duplicate emitter passed a test named for the property
it stopped checking". Both now pin the thing that actually holds the invariant.
`7ccd318` records "injections confirmed landed; two silent no-ops caught and
re-landed mid-write" — two break-runs were green only because the injection never
took effect, and the reported cause was an anchor that did not match the file.

**How you know you followed it.** You can name, for each guard, the one-line change
that turns it red.

**Never trust a break-run that did not print a confirmation line.** If the
injection printed nothing, the injection is what is under test.

## Directive 3 — Measure, never assume; re-scope rather than build

**Rule.** When a spec item rests on a premise, measure the premise before
implementing. If measurement refutes it, **re-scope**: do not drop the item, and
do not build it as written. Write down what was specified, what is true, and what
you are building instead.

**Failure mode prevented.** Building to a refuted premise ships a limit for a
problem that does not exist, and the comment defending it goes stale the first
time someone reads the code.

**Worked example (Vantrilex).** Item B.2 was specified as "the replay buffer is
unbounded". Measured: the buffer was already capped at 256 frames **and** the only
writer had zero production callers, so no OOM path existed. Re-scoped into three
items with the correction recorded in the plan itself
(`docs/IMPLEMENTATION_ROADMAP.md:176`) — bound the outbound inventory, add a byte
budget *marked prophylactic*, and add a gap notice. Not dropped, not built as
written.

**How you know you followed it.** The plan contains a "refuted premises" block, and
it is non-empty or explicitly says no premise was refuted.

## Directive 4 — A passing test is not evidence a feature ships

**Rule.** For every guard, answer three questions separately: does it exist, can
it fire, and is it correct? If the answer to *can it fire* is no, the code says so
**at the call site, in the comment, naming the missing producer** — not in a
report nobody reads.

**Failure mode prevented.** A frame that asserts a feature is live when it is not
is worse than no frame, because it converts a known gap into a false guarantee.

**Worked examples (Vantrilex), all unreachability stated in-tree:**

- The `resume` byte budget — commented as prophylactic, because `broadcast()` has
  zero non-test callers.
- The `resume-gap` notice — `src/ipc/ui-server.ts:563`: "with zero non-test
  `broadcast()` callers, this notice CANNOT fire in a shipped build today: the
  first real caller is the seam it is waiting behind."
- The ingest backpressure watermark — `src/voice/ingest.ts:30`: "REACHABILITY,
  measured rather than assumed: this watermark cannot fire on the live path today",
  with the arithmetic (the transient ceiling is **36,609 B short** of the pause
  threshold) and a burst probe at two chunk sizes that produced zero events.

**How you know you followed it.** Grep the tree for the new guard's name; every
hit that is not the definition is either a real caller or a comment explaining the
absence of one.

## Directive 5 — A test that pins a bug is worse than no test

**Rule.** Read a failing test's *name* and its *assertion* together. If they
disagree, the test is wrong. A test that encodes a defect as correct behaviour
will outlive the defect, and every future reader will treat the defect as
specified. Repair or rewrite it; do not revert the fix to keep it green.

**Failure mode prevented.** The suite becomes a specification of what is, and the
defect becomes load-bearing.

**Worked examples (Vantrilex) — four in one session:**

1. A shipped E2E drove its "unconfirmed lock warns amber" case with a
   **rejecting** shim, which conflated `Ok(false)` with a Rust `Err`; the reject arm
   is the one where the keyring is *deleted*. The conflation is documented in place
   at `apps/desktop/e2e/apikeys.spec.ts:65`.
2. Three `[REDACTION-REFUSED]` tests demonstrated the refusal arm using the very
   escaped-quote defect that was then fixed (`0cd54a0`).
3. A guard whose fourth check watched for an escape artefact survived its own fix
   and began refusing clean input (`"[REDACTED]"auth`); removed, because a guard
   that cries wolf teaches the reader to ignore refusals.
4. A credit E2E demanded a generic notice strip be *empty* when the correct value
   was "empty of the credit sentence" (`43d816f`).

**How you know you followed it.** For any test you are about to keep green against a
fix, you can state the user-visible behaviour it defends in one sentence.

## Directive 6 — Docs are re-derived, never asserted

**Rule.** Numbers and structural claims in prose come from the tree, by script,
every time. The checker holds **no expected values** — it parses the documented
figures out of the markdown and compares them against figures derived from the
tree. So: **fix the document, not the script.** A number that is not derivable
does not belong in a claim-shaped sentence.

**Two rules that keep the checker honest** — copy them, they are not optional:

- **"Unverifiable" is an error, not a warning.** If a checker degrades a missing
  figure into a no-op that still exits 0, you have coverage that reads as present
  while being absent. That is worse than having no checker.
- **Pin the checker's own claim set with a test.** A script can be edited and
  nothing else would notice.

**Worked example (Vantrilex).** `npm run docs:verify` re-derives the test counts,
module-reachability numbers, persona reference counts, absence-of-symbol claims,
and whether every `file.ts:NNN` anchor cited in `AGENTS.md` still resolves. It is
how five falsities in `AGENTS.md` were found. `AGENTS.md` carries the rule as
**Fix the document, not the script** in both the gate section and the change
conventions.

**How you know you followed it.** You never typed a count into a document from
memory, and when the checker went red you edited prose rather than the checker.

## Directive 7 — Peer review on a second model, and apply the dissent

**Rule.** Every item gets a review from a different model than the one that wrote
it. The reviewer's job is to find the reason the item is wrong, not to approve.
Dissent is applied **even when the defect it found is in already-committed code
outside the current write-set** — shipping a known defect because it was not in the
plan is indefensible; record that you exceeded the write-set and why.

**Failure mode prevented.** A reviewer who only confirms is worse than no reviewer,
because it manufactures confidence. And a reviewer's finding that gets deferred as
out-of-scope tends to never be fixed.

**Worked examples (Vantrilex).** `b2401be` records "all six dissents applied" —
and the reviewer, not the author, is what found the two vacuous guards in
Directive 2. Two security fixes (`0b11ba9`, `0cd54a0`) landed *after* the item
that surfaced them was already committed, because the findings were in the shared
redactor and the diagnostic bundle rather than in that item's files; the session
report lists this first among the judgement calls a present owner might have made
differently. `0cd54a0` also records rewriting three tests that had pinned the
just-fixed bug rather than reverting the fix — an author-made call, written down
as such.

**How you know you followed it.** The commit message answers each dissent, including
the ones you disagreed with.

## The plan artifact

The plan is the deliverable that makes the other seven directives checkable. It is
written **before** any code, and it is small enough that a stranger could predict
the diff from it.

```md
MILESTONE: <name>
Scope: one sentence, stating what is TRUE when this is done — a stranger can check it.

| # | Item | Write-set (exclusive files) | Red-first guard (S1) | Gate | Non-goal |
|---|------|-----------------------------|----------------------|------|----------|
| 1  | ...  | ...                         | ...                  | ...  | ...      |

### Non-goals — what this milestone does NOT do, and why
- <thing> — because <reason>.

### Refuted premises
- <item>: specified as <X>. Measured as <Y>. Building <Z> instead. Not dropped, not
  built as written.

### Owner-only, not finishable by an agent
- <item> — because <needs hardware / a paid key / a policy call>.
```

The **non-goals** and **owner-only** blocks are not ceremony. They are what stops
an autonomous run from silently expanding scope, and they are the record of which
judgement calls were made without anyone present to make them.

## Reference: `writing-plans` is UNFETCHED

**Status: unfetched, unread, and deliberately so.** The `obra/superpowers` skill
family and its `writing-plans` skill are **absent from this environment**. No
`npx skills add`, no MCP server, no CLI and no network fetch was performed while
authoring this file, and none is authorised.

**Nothing in this document is quoted or paraphrased from `writing-plans`.** The
three principles it is said to carry are stated here from first principles and from
how the Vantrilex run actually behaved:

1. **Write the plan before touching code** — the plan is a separate artifact with
   its own reviewable quality bar, not a comment above the first function.
2. **Make each step small enough that its failure mode is identifiable** — one
   item, one write-set, one commit. If you cannot name what went wrong, the step
   was too big.
3. **State what you are NOT doing and why** — the non-goals and owner-only blocks
   above.

That the real skill says something *similar* is **unverified and unclaimed**. If
the owner later approves a fetch of `obra/superpowers`, install it and reconcile
this section against the actual `writing-plans` text before treating any alignment
as established. Until then, treat the overlap as coincidence until checked.

## Self-check before calling a milestone done

| Question | If no |
|----------|------|
| Can you name the one-line change that turns each new guard red? | The guard is unproven — go back to S1. |
| Did every break-run print that its injection landed? | Re-run it. A break that measured nothing is not a pass. |
| Does every unreachability claim appear in the code, at the call site? | Move it from the report into the comment. |
| Does every test name agree with its assertion? | Rewrite the test, not the name. |
| Did any premise get refuted, and is that written down? | Record the re-scope now, while you still remember the measurement. |
| Did the full gate run, on the whole project, not the touched package? | Run it. A partial gate is not a gate. |
| Is every document figure derived by a script rather than typed? | Fix the document, not the checker. |
| Was each dissent answered in the commit message? | Answer it, or say why not. |

## Provenance

Encoded from the Vantrilex / Voxaura (`opencode-voice-runtime`) run `b3f793b` →
`e866fee`: 48 commits, 75 files. Milestones: **M1** the audit's shipped-defect
list; **M2** the voice loop; **M3** defensive limits; **M4** the voice-first
surface; **M5** a shareable diagnostic artifact. The narrative record is
`docs/reports/M1-M5-SESSION-REPORT.md`, the plan is
`docs/IMPLEMENTATION_ROADMAP.md`, and the gate/derivation script is
`npm run docs:verify`. Read those for the item-level detail; this skill is the
method, not the history.
