---
name: prompt-synthesis
description: Build structured, idempotent skill/tool prompts for in-session execution. Use when converting a handoff into an OpenCode prompt or skill invocation.
---

# Prompt Synthesis

A synthesized prompt has five slots, always in this order, always English:

1. **Goal** — one sentence, verb first.
2. **Scope** — files, sessions, tools allowed; what is out of scope.
3. **Acceptance** — the receipt, file, or gate output that proves completion.
4. **Failure plan** — what to do on 404 / 409 / denial (stop and report, retry
   bounds, never escalate permissions).
5. **Budget** — max turns or retries; three identical failures end the attempt.

Example:

```text
Goal: Add idempotency-key coverage for the skill toggle control.
Scope: src/runtime/client.ts + client.test.ts only. No other sessions.
Acceptance: vitest run on client.test.ts green, exit 0.
Failure plan: on 409 requeue once; on 404 stop and report NEEDS_REVIEW.
Budget: 3 attempts.
```

Rules:

- State file paths with line numbers when known; never rely on ambient state.
- Quote tool output verbatim inside code spans; translate nothing in code.
- One skill invocation per reasoning step; observe before chaining.
