# fake-project fixture

Synthetic Claude Code project folder for `test/e2e.test.ts` and
`test/e2e/crash-resume.test.ts`. All content is fabricated.

Synthetic paths:
- Original cwd: `C:\fake\project\path`
- Encoded folder: `C--fake-project-path`

Files:
- `sessions-index.json` — 13% "with-index" branch (G1); G2 schema with 3 entries.
- `00000000-...-001.jsonl` — top-level transcript A. Line 1 is `last-prompt`
  without cwd (G5); other lines embed cwd in `toolUseResult.stdout` and text.
- `00000000-...-002.jsonl` — top-level transcript B. Embeds cwd in
  `message.content[].text`, `Read.input.file_path`, `toolUseResult.file.content`,
  `Glob.input.path` (G6).
- `00000000-...-003/subagents/agent-deadbeef.jsonl` — subagent transcript (G4).

Tests copy this folder to temp and rename it to `C--fake-project-path`.
