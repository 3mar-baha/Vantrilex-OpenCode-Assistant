---
name: mission-handoff
description: English-only handoff envelopes between Dots3, Nemotron, and Inkling over WS-4097 session governance. Use when delegating tasks, reporting results, or fanning synthesis back in.
---

# Mission Handoff

Every inter-agent transfer uses a fixed envelope. Results travel downstream;
reasoning traces stay behind unless requested.

## Delegation (Nemotron → Inkling)

```text
[HANDOFF from=Nemotron to=Inkling task=<id>]
objective: <one sentence>
payload: <structured skill prompt / tool args>
acceptance: <receipt | ack | file | test result>
constraints: <FR-12, session boundaries, English only>
```

Rules:

- One task id per handoff; `depends_on` lists gate parallel waves.
- Acceptance must be checkable by receipt, ack, file, or gate output.
- Never delegate destructive acts without FR-12 confirmation recorded first.

## Report (Inkling → Nemotron)

```text
[REPORT task=<id> confidence=<HIGH|MEDIUM|LOW> flags=<none|NEEDS_REVIEW|PARTIAL>]
result: <structured, concise>
receipts: <msg_… / ack ids / commit SHAs / exit codes>
```

- HIGH only with executed verification. LOW always sets NEEDS_REVIEW.
- Conflicting findings are reported side by side, never merged silently.
- PARTIAL names the exact boundary hit and what remains.

## Intake (Dots3 → Nemotron)

Arabic conversation becomes one English mission:
`{objective, constraints, acceptance}`. The mission is restated back in the
report lane so acceptance criteria survive translation.
