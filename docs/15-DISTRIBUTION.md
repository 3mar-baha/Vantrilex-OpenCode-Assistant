# 15 — Distribution: Standalone Packaging, npm Global, Binary Bundling & Native Deps

> **Canonical status:** Voice/distribution batch. Deploy truth companion to `13`.
> Launcher: `26` · Roadmap placement: M4/M5 (`08`).

## 15.1 — Distribution Channels (normative)

| Channel | Artifact | Audience |
|---------|----------|----------|
| Primary: npm global | `opencode-voice-runtime` package, `bin/opencode-voice` | Node 22 operators (`13` §13.2 install flow) |
| Secondary: standalone binary | `pkg`/`caxa`-bundled executable per OS (win-x64 first) | Machines without Node toolchain |
| Tertiary: source tarball | `npm pack` output + `CHANGELOG.md` | Auditors, air-gapped installs |

All three ship the same `docs/` snapshot and the same `doctor` pre-flight gate.

## 15.2 — npm Package Layout (normative)

```json
{
  "name": "opencode-voice-runtime",
  "version": "1.0.0",
  "bin": { "opencode-voice": "./bin/opencode-voice.js" },
  "files": ["dist/", "bin/", "docs/", "AGENTS.md", ".opencode/skills/"],
  "engines": { "node": ">=22.0.0" }
}
```

- `prepublishOnly`: `tsc -p tsconfig.json` + full Gate-4 chain (`16` §16.6.2) — a red
  gate aborts the publish, never warns-and-continues.
- `files` allowlist is exhaustive: vault blobs, `.env`, audio cache, and `diag.zip`
  output can never match it (defense in depth for I-1, `12` §12.3).
- `AGENTS.md` + `.opencode/skills/` ship inside the package so guidance injection
  (`17`) works identically from a global install and from source.

## 15.3 — Binary Bundling (normative)

1. Bundle target: `dist/cli.js` → single executable per `(os, arch)`:
   `win-x64` (first-class), `darwin-arm64`, `linux-x64`.
2. Native bindings (DPAPI `safeStorage`, audio I/O) are platform-linked at bundle
   time — cross-compiled bundles are forbidden from shipping another platform's
   native module. The bundler asserts `process.platform` module resolution per target.
3. First run of the binary performs the same `doctor` gate as npm installs; vault and
   config live in the OS-appropriate data dir (`%APPDATA%` / `~/Library` / `~/.local/share`).

## 15.4 — Native Dependency Handling

| Dependency | Strategy |
|------------|----------|
| Electron `safeStorage` (DPAPI) | Optional peer: used when present; else `node-data-protection` fallback (`12` §12.2); absence degrades to refuse-vault-features, never plaintext |
| Audio I/O (mic/speaker) | Abstracted behind `AudioIn`/`AudioOut` (`03` §3.3.2); missing devices → text fallback (E-5), install never fails for lack of hardware |
| `opencode` binary | External prerequisite, version-pinned at install (`13` §13.1); drift handled by contract probe, not by bundling OpenCode itself (immunity boundary, `04` §4.5) |

## 15.5 — Release Checklist (per channel)

- [ ] Version bumped per semver + deprecation notices emitted (`08` §8.4).
- [ ] Gate-4 chain green with evidence pasted in release notes.
- [ ] `npm pack --dry-run` file list reviewed (no secrets, no cache).
- [ ] Binary smoke test per target: install → `vault set` (sandbox) → `doctor` →
      supervised boot → one mock briefing → clean shutdown.
- [ ] Checkpoint ledger (`10`) records release commit hash.

---

*End of `15-DISTRIBUTION.md`. Next: `17-CATALOG-INGESTION.md`.*
