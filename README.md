# claude-code-rename

**Recover Claude Code sessions (e.g. `/resume`) after renaming, moving, or copying a project folder.** A safe, dry-run-first CLI that rewrites the encoded project folder under `~/.claude/projects/`, fixes embedded `cwd` paths in every transcript, and merges histories when both source and destination already exist.

[![npm](https://img.shields.io/npm/v/claude-code-rename.svg)](https://www.npmjs.com/package/claude-code-rename)
[![CI](https://github.com/alazc/claude-code-rename/actions/workflows/ci.yml/badge.svg)](https://github.com/alazc/claude-code-rename/actions/workflows/ci.yml)
[![npm provenance](https://img.shields.io/badge/provenance-signed-brightgreen)](https://www.npmjs.com/package/claude-code-rename)

```text
$ claude
> /resume
(no sessions found)
```

Or the `--continue` / `-c` flavor of the same problem:

```text
$ claude --continue
(no previous session)
```

If either of those is what you're looking at after renaming or moving your project folder, this recovers your history.

```
npx claude-code-rename
```

That command scans `~/.claude/projects/`, finds the orphaned project whose original path no longer exists on disk, and asks where you moved it. Dry-run by default. Nothing is written until you pass `--apply`.

**Already started a new Claude session in the renamed/copied folder?** That's the other case `claude-code-rename` handles. Claude Code created a fresh project folder for the new path; your old transcripts are still under the old encoded folder. Point the tool at both paths and it **merges** — copies the old transcripts (with paths rewritten) into the new folder alongside whatever's already there, leaves the old folder fully intact, and concatenates the two `sessions-index.json` files so `/resume` sees everything. No deletion, no clobber.

```
npx claude-code-rename --old <original-path> --new <renamed-or-copied-path> --apply --backup
```

### What you actually see

A real run against a copied project folder (`moneyMachine` → `moneyMachine-copy`, both folders on disk, Claude Code already started a fresh session in the copy):

```text
$ npx claude-code-rename --old "C:\Users\me\moneyMachine" \
                        --new "C:\Users\me\moneyMachine-copy" \
                        --apply --backup --yes

[apply preview] OLD: C:\Users\me\moneyMachine
[apply preview] NEW: C:\Users\me\moneyMachine-copy
[apply preview] MERGE mode: destination C--Users-me-moneyMachine-copy already exists.
[apply preview] Source folder C--Users-me-moneyMachine will be kept intact.
[apply preview] Destination has 1 existing file(s); migration will add 2 file(s) from source.
[apply preview] backup: ~0.8 MB, free: 73370.4 MB, ETA ~0.0s @100 MB/s
[apply preview] 2 jsonl file(s):
[apply preview]   ...moneyMachine/65aaaa1a-....jsonl -> ...moneyMachine-copy/65aaaa1a-....jsonl: 357 occurrence(s)
[apply preview]   ...moneyMachine/78f3c2df-....jsonl -> ...moneyMachine-copy/78f3c2df-....jsonl:  87 occurrence(s)
[apply preview] total: 444 occurrence(s) across 2 file(s)

ccr: backed up source to      .ccrenamer-backups/C--Users-me-moneyMachine-20260512-082453/
ccr: backed up destination to .ccrenamer-backups/C--Users-me-moneyMachine-copy-20260512-082453/

Merged 2 file(s) from C--Users-me-moneyMachine into C--Users-me-moneyMachine-copy (444 total substitutions).
Source folder C--Users-me-moneyMachine left intact. Run `claude` in C:\Users\me\moneyMachine to continue using its history independently.
```

That's a single run: 444 path substitutions across two transcripts, both projects backed up first, source folder byte-identical after, destination's pre-existing fresh-start session preserved. The dry-run preview (default, no `--apply`) shows the same thing without writing.

## Will this corrupt my transcripts?

No. Four guarantees, in order of how much they matter:

- **Dry-run is the default.** `claude-code-rename` previews every file and every substitution before any write. You opt in with `--apply`.
- **Every write is atomic.** Each transcript is written to a sibling temp file and then renamed into place. A crash mid-run cannot leave a file half-written.
- **Merge instead of clobber.** If the destination encoded folder already exists (because you started a Claude session there after the rename), `claude-code-rename` copies the source transcripts in alongside the existing ones rather than deleting anything. Source folder is preserved.
- **Backup is one flag away.** `--backup` copies the whole project folder to a sibling timestamped directory before any modification.

## Can I undo it?

**Always**: if you ran with `--backup`, restore the timestamped backups from `~/.claude/projects/.ccrenamer-backups/`. Each `--apply` run creates one (rename mode) or two (merge mode, one per folder) timestamped copies. Use them as the authoritative pre-apply state.

**Rename mode (no backup)**: the substitution is symmetric — re-run with paths swapped to reverse it:

```
claude-code-rename --old <new-path> --new <old-path> --apply
```

**Merge mode (no backup)**: not reliably reversible. Merge is additive on the destination; re-running with paths swapped would *also* be merge mode and would copy the (already-merged) destination jsonls back into the source folder, corrupting it. Use `--backup` for merge applies if you might want to roll back.

## Recovering or transferring sessions

Two flows. The first is interactive and the one you probably want:

```
npx claude-code-rename
```

The tool prints any orphaned project folders it finds. If there's exactly one and its original path is unambiguously missing, it offers to repair directly. You type the new path. It shows a dry-run preview. You confirm with `--apply`.

The second flow is non-interactive, for scripts or for users who already know both paths:

```
npx claude-code-rename --old /Users/me/old-name --new /Users/me/new-name
npx claude-code-rename --old /Users/me/old-name --new /Users/me/new-name --apply
```

## Power users: install once, use the short alias

```
npm i -g claude-code-rename
ccr
```

After global install, `ccr` is the short form. It runs the same script. `npx ccr` does NOT work — `npx` resolves package names, not bin aliases — so always use the full name with `npx`.

```
ccr                                    # scan + interactive repair
ccr --old <a> --new <b>                # explicit, dry-run
ccr --old <a> --new <b> --apply        # commit
ccr --backup --old <a> --new <b> --apply  # belt and suspenders
ccr --scan                             # list orphans, never write
ccr --help
```

## How Claude Code stores projects on disk

Claude Code identifies a project by its current working directory and stores its transcripts under `~/.claude/projects/<encoded-cwd>/`. The encoding replaces every `/`, `\`, `:`, space, and `_` with `-`, so `C:\Users\me\my_project folder` becomes `C--Users-me-my-project-folder`. (The underscore rule is empirically verified against CC 2.1.139 and was missed in the original spec.)

When you rename the source folder, Claude Code recomputes the encoded name from the new cwd, finds no matching project folder, and starts fresh. The old transcripts still sit under the old encoded name — your previous sessions are invisible to `/resume`.

Three pieces of state encode the old cwd and must all be updated:

1. The encoded project folder name itself.
2. The `originalPath` field in `sessions-index.json` (when present — most CC 2.1.x projects don't ship one anymore).
3. Every embedded `cwd` value inside every `*.jsonl` transcript, including any under `<session-id>/subagents/`. Real transcripts also bake the cwd into tool inputs (`Read.file_path`, `Glob.path`, bash commands), tool outputs (`stdout`), and message text — these are rewritten too, by design.

`claude-code-rename` handles all three in either mode: **rename mode** updates them in place and renames the folder; **merge mode** writes the rewritten content into the destination folder while leaving the source untouched.

## Two modes: rename vs merge

The tool picks one of two modes automatically based on whether the new encoded folder already exists under `~/.claude/projects/`.

**RENAME mode** (destination encoded folder does NOT exist) — the classic "I renamed my project and my sessions vanished from `/resume`" case. Rewrites transcripts in place, then renames the folder.

**MERGE mode** (destination encoded folder already exists) — you've already started a Claude session in the new path, so CC made a fresh project folder there. Both histories should coexist. Concretely:

- Source transcripts are **copied** (not moved) into the destination folder with their `cwd` and embedded paths rewritten to point at the new path.
- Destination's pre-existing transcripts are **preserved untouched**.
- `sessions-index.json` files are **concatenated** — destination's existing entries first, then the migrated source entries with paths rewritten.
- **Source folder is byte-identical after `--apply`** — no transcripts modified, no manifest residue, no timestamps disturbed. Running `claude` in the original path still works as before, with its history intact.
- After merge, both projects continue **independently** from a shared past. New sessions in either path don't propagate to the other.

You don't pick the mode — it's determined by what's on disk. The dry-run preview shows which mode will run before any change, including per-file source→destination mappings for merge mode.

### When merge mode is the right tool

- You copied your project folder (e.g., `moneyMachine` → `moneyMachine-copy`) to fork it, ran `claude` in the copy, and now want the copy to see the original's history too.
- You renamed the folder and ran `claude` in the new location before realizing `/resume` was empty — CC created a fresh project, and you want to merge the old one in.
- You're consolidating duplicate work from two related project paths into one canonical destination.

## What this tool will not do

- **Move a project across machines or operating systems.** Path conventions differ between Unix and Windows; cross-OS migration is a different tool.
- **Merge with a UUID collision.** If a source transcript has the same UUID-named filename as one already in the destination, the tool refuses with exit 4 rather than overwriting. Astronomically unlikely for UUID-v4 names, but failing loudly is the right move. Rename or remove the conflicting destination file yourself first.
- **Recover deleted transcripts.** The old project data must still exist on disk under its old encoded name. If you deleted the folder, this tool can't help.
- **Update server-side state at Anthropic.** There isn't any to update. Claude Code keys projects entirely on the local cwd.

## If you moved your project to a different machine

`claude-code-rename` v1 only handles same-machine, same-OS renames. Cross-machine and cross-OS migration is planned for v2. For now, the simplest path is to copy `~/.claude/projects/<encoded-old-cwd>/` from the old machine to the new one, then run `claude-code-rename` on the new machine to fix up the paths.

## Stability

`claude-code-rename` targets Claude Code's current on-disk project layout. If a future CC release changes the schema (e.g. adds escaping for unicode in the encoder, or moves the `cwd` field inside event lines), the tool will detect the mismatch on scan and refuse to run rather than corrupt data. The README's version pin below tells you what release we last verified against.

**Verified against Claude Code: v2.1.139** *(update after each release where you re-test)*

Empirical verification against this CC version:
- 63 encoder entries captured from a real `~/.claude/projects/` and committed as `test/fixtures/encode-truth-table.json`. The encoder rule `:`, `\`, `/`, ` `, `_` → `-` passes all 63.
- End-to-end migration of a real 0.8 MB transcript pair (444 path substitutions) with byte-identical source preservation. See the "Two modes" section above.

## Contributing

Found a path that didn't encode the way the tool expected? Add it to `test/fixtures/edge-cases.json`, run `npm test`, and open a PR. The encoder gets stronger every time someone contributes a real-world weird path. Good things to contribute:

- Paths with characters this tool doesn't currently encode (parentheses, brackets, unicode, tabs).
- Schema differences observed in a recent Claude Code version.
- Platform-specific path quirks (Windows UNC paths, macOS case-only renames, Linux paths with embedded newlines).

Dev loop:

```
git clone https://github.com/alazc/claude-code-rename
cd claude-code-rename
npm install
npm test
```

The encoder lives in `src/encode.ts` and is property-tested with `fast-check`. The byte-level JSONL rewriter lives in `src/rewrite.ts`. Both are pure functions; you can change them without touching IO.

## Related

- [Claude Code](https://claude.ai/code) — the tool this exists to support.

## Releasing

Publishing is automated. CI runs the full matrix (Ubuntu/macOS/Windows × Node 20/22) on every PR and push to `main`; pushing a `v*` tag triggers `release.yml`, which builds, tests, publishes to npm with provenance, and creates the GitHub Release.

Maintainer steps:

1. Bump `version` in `package.json`.
2. `git tag v<version>` and `git push --tags`.
3. CI does the rest.

An `NPM_TOKEN` ([npm automation token](https://docs.npmjs.com/creating-and-viewing-access-tokens)) must be set as a repo secret.

## License

MIT
