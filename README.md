<!-- Badges: add after first npm publish + first CI run -->
<!-- [![npm](https://img.shields.io/npm/v/claude-code-rename.svg)](https://www.npmjs.com/package/claude-code-rename) -->
<!-- [![CI](https://github.com/<owner>/claude-code-rename/actions/workflows/ci.yml/badge.svg)](https://github.com/<owner>/claude-code-rename/actions/workflows/ci.yml) -->

```text
$ claude
> /resume
(no sessions found)
```

If that's what you're looking at after renaming or moving your project folder, this fixes it.

```
npx claude-code-rename
```

That command scans `~/.claude/projects/`, finds the orphaned project whose original path no longer exists on disk, and asks where you moved it. Dry-run by default. Nothing is written until you pass `--apply`.

<!-- Demo: replace with asciinema embed after first recording -->
<!-- [![asciicast](https://asciinema.org/a/<ID>.svg)](https://asciinema.org/a/<ID>) -->

## Will this corrupt my transcripts?

No. Four guarantees, in order of how much they matter:

- **Dry-run is the default.** `claude-code-rename` previews every file and every substitution before any write. You opt in with `--apply`.
- **Every write is atomic.** Each transcript is written to a sibling temp file and then renamed into place. A crash mid-run cannot leave a file half-written.
- **Refuse-to-clobber.** If the destination already has a Claude Code project folder, the tool exits with an error rather than merging.
- **Backup is one flag away.** `--backup` copies the whole project folder to a sibling timestamped directory before any modification.

## Can I undo it?

If you ran with `--backup`, restore the timestamped backup folder. If you didn't, run the tool again with the paths swapped:

```
claude-code-rename --old <new-path> --new <old-path> --apply
```

The substitution is symmetric. The same `--apply` that did the rename can reverse it.

## Recovering sessions after a folder rename

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

Claude Code identifies a project by its current working directory and stores its transcripts under `~/.claude/projects/<encoded-cwd>/`. The encoding replaces every `/`, `\`, `:`, and space with `-`, so `C:\Users\me\my project` becomes `C--Users-me-my-project`.

When you rename the source folder, Claude Code recomputes the encoded name from the new cwd, finds no matching project folder, and starts fresh. The old transcripts still sit under the old encoded name — invisible to `/resume`.

The fix has three parts that must all happen:

1. Rename the encoded project folder itself.
2. Rewrite `originalPath` in `sessions-index.json`.
3. Rewrite every embedded `cwd` value inside every `*.jsonl` transcript, including any under `<session-id>/subagents/`.

`claude-code-rename` does all three. Full technical spec lives in [PROBLEM.md](PROBLEM.md).

## What this tool will not do

- **Move a project across machines or operating systems.** Path conventions differ between Unix and Windows; cross-OS migration is a different tool.
- **Merge two project histories.** If the destination encoded folder already exists, the tool refuses. Delete or move the conflicting folder yourself first.
- **Recover deleted transcripts.** The old project data must still exist on disk under its old encoded name. If you deleted the folder, this tool can't help.
- **Update server-side state at Anthropic.** There isn't any to update. Claude Code keys projects entirely on the local cwd.

## If you moved your project to a different machine

`claude-code-rename` v1 only handles same-machine, same-OS renames. Cross-machine and cross-OS migration is planned for v2. For now, the simplest path is to copy `~/.claude/projects/<encoded-old-cwd>/` from the old machine to the new one, then run `claude-code-rename` on the new machine to fix up the paths.

## Stability

`claude-code-rename` targets Claude Code's current on-disk project layout. If a future CC release changes the schema (e.g. adds escaping for unicode in the encoder, or moves the `cwd` field inside event lines), the tool will detect the mismatch on scan and refuse to run rather than corrupt data. The README's version pin below tells you what release we last verified against.

**Verified against Claude Code: v\<X.Y.Z\>** *(update after each release where you re-test)*

## Contributing

Found a path that didn't encode the way the tool expected? Add it to `test/fixtures/edge-cases.json`, run `npm test`, and open a PR. The encoder gets stronger every time someone contributes a real-world weird path. Good things to contribute:

- Paths with characters this tool doesn't currently encode (parentheses, brackets, unicode, tabs).
- Schema differences observed in a recent Claude Code version.
- Platform-specific path quirks (Windows UNC paths, macOS case-only renames, Linux paths with embedded newlines).

Dev loop:

```
git clone https://github.com/<owner>/claude-code-rename
cd claude-code-rename
npm install
npm test
```

The encoder lives in `src/encode.ts` and is property-tested with `fast-check`. The byte-level JSONL rewriter lives in `src/rewrite.ts`. Both are pure functions; you can change them without touching IO.

## Related

- [Claude Code](https://claude.ai/code) — the tool this exists to support.
- [PROBLEM.md](PROBLEM.md) — the technical spec this implementation is built from.
- [DESIGN.md](DESIGN.md) — the architectural design doc, including premises and reviewed alternatives.

## License

MIT.
