# W3 — Dossier S2: supervisor secret generation (`main.rs`)

**Lane B, Wave 1.** Write set: `apps/desktop/src-tauri/src/main.rs`,
`apps/desktop/src-tauri/Cargo.toml` (+ `Cargo.lock`, cargo-managed),
this report. No commit, no push.

## 0. Tooling — proven, not assumed

**I CAN execute commands.** The prior worker's "no process-spawning capability"
report does not apply to this session: `shell` works (PowerShell 5.1.26100.9444),
`cargo 1.98.1` / `rustc 1.98.1` are installed, and MSVC loads from
`C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\VsDevCmd.bat`
(path verified present). Every claim below is backed by an execution transcript.
**Nothing in this report is UNVERIFIED.**

## 1. The defect, restated from source

Pre-change `main.rs:460-476` and `:501-517` generated both secrets with:

```rust
let mut seed = SystemTime::now().duration_since(UNIX_EPOCH)
    .map(|d| d.as_nanos() as u64).unwrap_or(0x9E3779B97F4A7C15)
    ^ std::process::id() as u64;
for chunk in bytes.chunks_mut(8) {      // 4 iterations for 32 bytes
    seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17;
    for (i, b) in chunk.iter_mut().enumerate() { *b = ((seed >> (i*8)) & 0xff) as u8; }
}
```

Two facts I established by *measurement*, not by reading:

1. **The state is 64 bits, not 256.** All 32 output bytes come from **four**
   xorshift steps, and each 8-byte chunk is one state word. This is not a
   theoretical weakness — I built an exact inverse of the transform
   (`xorshift64_unstep`, `main.rs:1696`) and recovered the seed from live
   output in every trial (see §4). The secret leaked its own seed.
2. **Both seed inputs are observable.** The wall clock is readable by anything
   on the machine; a Windows PID is enumerable over 1..=65535.

So the practical keyspace was the launch-window nanoseconds, not 2^256. The
daemon's own `randomBytes(32)` (`src/daemon.ts:746`) was indeed the stronger
of the two; the supervisor was the weak link, as the dossier stated.

The `(0600)` comments were false: zero `chmod`/`set_permissions` calls existed
in the file. I confirmed that by grep, not by trusting the dossier.

## 2. Entropy source: `getrandom` 0.3

Added `getrandom = "0.3"` to `Cargo.toml`.

**Why `getrandom` over `rand`:** the need is "N bytes from the OS CSPRNG".
`rand` would add a PRNG (`rand_chacha`), `rand_core`, `zerocopy`, `ppv-lite86`
— a large dependency surface for a capability already available directly. On
Windows `getrandom` resolves to the kernel CSPRNG (`RtlGenRandom`/
`BCryptGenRandom`), not to a userspace generator.

**Why 0.3 specifically:** it was **already in this workspace's `Cargo.lock`**
transitively via tauri. Promoting it to a direct dependency therefore added
**zero new packages**. Verified — the entire lock diff is one line:

```
     dependencies = [
+        "getrandom 0.3.4",
         "serde",
```

It returns `Result` and I propagate it (`main.rs:469`) rather than falling back
to anything weaker: a secret must never be produced by a degraded path.

## 3. The Windows permission question — the actual answer

**`fs::set_permissions(path, 0o600)` is the wrong answer on Windows, and it
fails silently.** Rust's own docs state the function "currently corresponds to
the chmod function on Unix and the **SetFileAttributes** function on Windows"
(docs.rs, `std::fs::set_permissions`, §Platform-specific behavior). On Windows
that toggles *only* `FILE_ATTRIBUTE_READONLY`. A `0o600` call there compiles,
returns `Ok(())`, and changes **no access control whatsoever**. It is a no-op
that reads like a passing permission check — the same failure shape as the
comments that claimed `0600` while calling no ACL code at all. Copying the Unix
idiom would have produced a *second* false claim, and a test that passes.

Windows carries "only me" in a **discretionary ACL**, not a mode bit. My
implementation (`restrict_to_owner`, `main.rs:537`) uses
`SetEntriesInAclW` + `SetNamedSecurityInfoW`, with three properties that make
it a real `0600` rather than decoration:

1. **`oldacl = NULL`** — the DACL is built only from the trustees I name, not
   merged into whatever the parent directory contributed.
2. **`PROTECTED_DACL_SECURITY_INFORMATION`** — sets `SE_DACL_PROTECTED`, which
   *blocks inheritance from the parent*. This is the part Unix gives for free
   with `0600` and that the naive Windows port silently lacks: without it the
   guarantee is only as strong as `%USERPROFILE%`'s ACL, which this process does
   not control. Confirmed against MS docs on ACE inheritance.
3. **`GENERIC_ALL`** — the kernel maps generic rights to concrete file rights,
   so this is a full-control grant (the Windows analogue of owner `rw`).

**Trustees: the file's owner SID + the well-known LocalSystem SID.** LocalSystem
is included so system-level maintenance (backup, servicing) is not locked out;
it does not weaken the boundary this exists to draw, which is "no other
interactive user".

**Design change from the obvious approach.** I first read the user SID from the
process token (`OpenProcessToken` + `GetTokenInformation(TokenUser)`), which is
the textbook route. It does not work on this machine — see §6. I switched to
reading the **owner SID out of the file's own security descriptor**
(`GetFileSecurityW(OWNER_SECURITY_INFORMATION)`), which is one API call, needs
no token access rights, and cannot drift from the file's actual owner. The test
at `main.rs:2191` independently asserts via the token that the two identities
are equal, so this is verified rather than assumed.

**Fail-closed.** If the ACL cannot be applied, `write_protected_secret`
(`main.rs:494`) **deletes the file** and returns `Err`. Leaving it would be
worse than failing: the `read_to_string` fast path would adopt the weak file as
permanent and never retry the lockdown. This is safe for startup because
`setup()` and `ensure_all_services` already log and continue, and `ipc_token`
fails closed — the shell renders its disconnected state, matching the existing
`voice-disabled-no-keys` pattern. Covered by `main.rs:1971`.

### On W3-S2-SERVE-PASS-LIFETIME (required assessment)

**`serve.pass` must keep its current long-lived, per-install lifetime and must
NOT share a rotation policy with `ipc.token`.** Reasons, from source:

- It is consumed by `opencode serve`, which is a **separate, independently
  long-lived process** that this supervisor merely nudges into existence
  (`main.rs:8`, and the `ensure_opencode`/`ensure_daemon` split). Rotating it
  on every shell launch would desynchronise a credential that serve has already
  consumed, breaking cold start.
- The current precedence — explicit env wins, else reuse the on-disk value
  (`main.rs:736-755`) — is what makes that agreement possible at all.
- `ipc.token` is a *different* class of secret: it is read fresh from the file
  per WS-4097 connection via the `ipc_token` command (`main.rs:747`), so it is
  a candidate for per-launch rotation. I did **not** implement that: it is a
  behaviour change with real blast radius (every live webview re-reads it), and
  it is out of scope for the entropy/permission defect. **Recorded as follow-up
  L-S2-1, not done.** What matters for *this* defect is that both files are now
  CSPRNG-seeded and owner-locked regardless of lifetime.

I am flagging the shared weakness honestly: because both are per-install and
long-lived, a local attacker who reads either file keeps access until the file
is deleted. The fix here removes *guessability* and *other-user readability*; it
does not add revocation. That is a deliberate, bounded scope.

## 4. The guard, and the break-the-guard transcript

**The most important finding of this task is about the test, not the fix.**

My first version of the primary guard swept candidate seeds from a **hardcoded
timestamp constant**. When I broke the guard, that behavioral test **PASSED** —
it was **vacuous**. Only the structural test caught the regression. I discarded
that guard rather than ship it, because a guard never observed to catch its
target is not a guard.

The replacement is an **attack, not a guess** (`main.rs:1756`):

- `recover_seed_if_xorshift` (`main.rs:1721`) takes a live secret, reads the
  first 8 bytes as the post-step-1 state word, and inverts one step to recover
  the seed — the output leaks its own seed.
- The clock window is bracketed by **real clock reads taken immediately around
  each generation**, so there are no hardcoded constants and it cannot drift.
- For each recovered seed it asks whether `seed ^ pid` lands in that window for
  **any** `pid` in 1..=65535.
- **The inverse is self-tested** (`main.rs:1758`) before use. This caught a real
  bug: I initially un-did the three GF(2) stages in *forward* order, and the
  self-test failed immediately. A guard with a wrong inverse would have been
  silently useless.
- **A positive control** (`the_attack_does_break_the_historical_generator`,
  `main.rs:1649`) runs the transcribed historical generator and asserts the
  attack recovers the exact seed. The attack is proven to work before it is
  trusted to fail.

Defence in depth: behavioral attack + structural code-fingerprint scan
(`main.rs:1814`) + format/uniqueness properties (`main.rs:1908`) + a DACL
readback test against **real kernel state** (`main.rs:1997`).

### Transcript

```
GREEN (initial)
  test result: ok. 36 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
  UNPIPED_LASTEXITCODE=0

BREAK — weak generator reinstated verbatim into generate_secret()
  (xorshift64* seeded with nanos ^ pid, plus its original comment)
  test result: FAILED. 34 passed; 2 failed
    s2_secret_tests::generated_secrets_are_not_reproducible_from_the_old_seed
    s2_secret_tests::the_weak_generator_has_not_been_reinstated
  UNPIPED_LASTEXITCODE=101

  behavioral failure detail (abridged):
    a generated secret is reproducible from the historical xorshift64* seed
    (nanos ^ pid): [(0, 1790606348160950112, 1), (1, ...), (15, ...)]
    The weak generator is back.
    -- 16 of 16 samples recovered.
    -- Recovered seeds ~1.7906e18 == the real 2026 nanosecond clock, which is
       direct evidence the attack recovered the ACTUAL seed, not a coincidence.

  structural failure detail:
    the xorshift state update is back in production code (^= seed);
    the S2 fix was reverted

RESTORE
  test result: ok. 36 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
  UNPIPED_LASTEXITCODE=0
```

Note: the 5 other S2 tests correctly stayed **green** while the generator was
broken — the DACL tests do not depend on the entropy source, which is the
correct separation of concerns.

**Stability:** 3 consecutive runs, `36 passed` each time — no flakiness.
`cargo check --no-default-features` → `CHECK_OK`, exit 0. No compiler warnings.

## 5. Test count

**27 → 36** (+9). Never dropped. Baseline was re-measured, not assumed.

## 6. Bugs I hit and fixed (recorded because they are the reusable lessons)

1. **`LocalFree` on a kernel HANDLE.** I closed the `OpenProcessToken` handle
   with `LocalFree`. That both corrupts the process heap and leaves the token
   dangling — it produced `STATUS_HEAP_CORRUPTION` that killed the whole test
   binary and cascaded into four unrelated "failures". Must be `CloseHandle`.
2. **`GetLastError()` after a cleanup call.** I read the error after
   `LocalFree`, so the real diagnosis was replaced by whatever cleanup left
   behind. Now the code is captured *before* any cleanup.
3. **A test returning a pointer into a dropped `Vec`** (use-after-free →
   heap corruption). Now `Box::leak`ed, with a comment saying why.
4. **`lpnlengthneeded` may not be NULL.** Documented `[out, optional]`, but
   passing NULL makes **both** `GetFileSecurityW` and `GetTokenInformation` fail
   with `ERROR_NOT_ENOUGH_MEMORY (998)` on this OS even when the size query
   succeeded and the buffer is 1 KiB. I only found this by cross-checking the
   same call from PowerShell (which passed a real out-param and returned
   `ok=True`) against my Rust (which passed NULL and got 998). **The lesson:
   when a syscall fails in one language and succeeds in another, the OS is not
   the variable — the binding is.**
5. **Security-descriptor field offsets.** My test read the DACL offset from
   bytes 4–8, which is the **owner** offset. Correct: owner `[4..8]`, group
   `[8..12]`, SACL `[12..16]`, DACL `[16..20]`.
6. **A guard whose scope excluded its own target.** Splitting the source at the
   first `#[cfg(test)]` scopes to `Supervisor::child_count` at line 395, which
   sits *above* the secret machinery — every assertion passed vacuously. Split
   at the first test *module* instead, and assert the target is in scope.
7. **`{nibble:x}` read as decimal.** "hex digit 10" meant index **16**: the
   histogram was sized `[0usize; 256]` (a byte histogram) while only 16 nibble
   buckets are written. I misread my own failure message for several iterations
   before dumping real data. **Print the data; do not reason about the message.**
8. **`Copy-Item` preserves mtime**, so cargo's fingerprint skipped the rebuild
   and I "tested" a stale binary — reporting a failure that was not real, and
   briefly believing a correct restore was broken. Force the timestamp before
   re-running after any external file restore. This is the same family of trap
   as the `AGENTS.md` warning about pipelines lying about exit codes: **the
   thing you measured was not the thing you thought.**

## 7. What is still open

- **L-S2-1** — rotate `ipc.token` per launch. Deliberately not done (§3).
- The DACL applies to the two secret files. `supervisor.log` and the child logs
  are **not** ACL'd; they are documented as carrying no credential, so that is a
  judgement call rather than an oversight. If a future change logs anything
  sensitive, that changes.
- `restrict_to_owner` is `#[cfg(windows)]`; the `#[cfg(not(windows))]` twin
  (`:694`) does a real `chmod 0600`. Untested on Unix — this is a
  Windows-first repo and I had no Unix host.
- Catalog items assigned to me (`security-reviewer` persona, the two skills, the
  two plugins, the two hooks, `filesystem`/`memory` MCP) are advisory
  capabilities, not code surfaces. I applied the security-review lens; the tmux
  hooks are inert on Windows as the task stated.

## 8. Constraint compliance

- Only `main.rs`, `Cargo.toml` (+ cargo-managed `Cargo.lock`), and this report
  were modified. `git status --porcelain apps/desktop/src-tauri/` shows exactly
  those three.
- Other modified files in the repo (`README*`, `docs/*`, `package.json`,
  `src/**/*.test.ts`, `vitest.config.ts`) are **other workers'**, not mine.
- `cargo test` and `cargo check` only. **No** `npm run test:e2e`, no npm script
  binding ports (E2E lock respected), no `npm install`.
- `Cargo.lock` was not hand-edited; cargo regenerated it (one added line).
- **Not committed, not pushed.**
