# Changelog

All notable changes to `claude-code-rename` will be documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-05-12

Initial public release. Recovers Claude Code `/resume` after a project folder
rename or move. Verified against Claude Code 2.1.139 on Windows; cross-platform
matrix in CI covers ubuntu-latest, macos-latest, windows-latest × Node 20, 22.

### Added

- **Path encoder** (`src/encode.ts`) — pure, NFC-normalize then replace `:`, `\`,
  `/`, space, `_` with `-`. Property-tested via `fast-check` + 63-entry truth
  table captured from a real `~/.claude/projects/` directory.
- **JSONL rewriter** (`src/rewrite.ts`) — cursor-advancing substitution
  guarantees idempotency and prevents OLD-as-prefix-of-NEW pathologies. Handles
  the JSON-escaped on-disk form (`C:\\Users\\me\\old`) so Windows paths
  round-trip correctly.
- **Sessions-index rewriter** — three path-bearing fields (`originalPath`,
  `entries[].projectPath`, `entries[].fullPath`) via parse-then-serialize.
  Returns structured warnings (no `console.warn`) so callers own the log sink.
- **Orphan scanner** (`src/scan.ts`) — `sessions-index.json` fast path with
  fall-back to first cwd-bearing line of any `*.jsonl` (top-level or under
  `<uuid>/subagents/`). CC stopped writing `sessions-index.json` in early 2026
  (~87% of projects lack it), so the jsonl-cwd fallback is the common path.
- **Filesystem primitives** (`src/fs.ts`) — atomic write with sibling-tmp +
  rename, recursive backup to `.ccrenamer-backups/`, recursive jsonl walker
  that follows symlinks with cycle detection, case-only rename for
  case-insensitive filesystems, deterministic test-fail seam for crash-resume
  tests.
- **CLI** (`src/cli.ts`) — `node:util.parseArgs`, dry-run by default, atomic
  apply with `.ccrenamer-progress.json` checkpoint manifest for crash-resume,
  TTY confirmation prompts, `--yes` for non-interactive mode, exit-code split
  (0 ok / 1 user error / 3 internal / 4 fs precondition).
- **Two apply modes**:
  - **RENAME** (destination encoded folder doesn't exist) — rewrite in place,
    then rename folder. Manifest in source folder.
  - **MERGE** (destination encoded folder already exists) — copy source jsonls
    into destination with rewrites, concatenate sessions-index entries, leave
    source folder fully intact (byte-identical, no manifest residue). Manifest
    in destination folder.
- **Gates** — encoder-sanity preflight (refuses if jsonl cwd doesn't encode to
  folder name), OLD literal verification (refuses if OLD path isn't found in
  any source jsonl), CC-running probe via exclusive-open (Windows reliable,
  POSIX best-effort), OLD⊂NEW confirmation gate via `--yes` on non-TTY,
  free-space check before backup (refuses if free < required × 1.2), UUID
  collision check in merge mode.
- **Crash-resume** — manifest records `intendedFiles` at scan time so resume
  validates completeness. Resume relaxes the encoder-sanity and OLD-literal
  gates because rewritten files no longer carry OLD. Test/e2e suite covers
  4 fault-injection scenarios + stale-manifest refusal.
- **CI** — GitHub Actions matrix `[ubuntu-latest, macos-latest, windows-latest]
  × [node 20, 22]`. Build + `--version`/`--help` smoke step catches dist-path
  drift.
- **Release** — publishes to npm with `--provenance` on `v*` tag push.

### Known v1 limitations

- POSIX flock fallback in CC-running probe is best-effort; concurrent CC
  writers may slip through. Manifest catches half-written state on next run.
- Cross-OS / cross-machine migration is out of scope; v2.
- `--backup-format=tar.gz` deferred to v1.1; v1 uses plain recursive copy.
- Merging when source and destination already share a UUID-named transcript
  is refused (exit 4); manual resolution required.

[0.1.0]: https://github.com/alazc/claude-code-rename/releases/tag/v0.1.0
