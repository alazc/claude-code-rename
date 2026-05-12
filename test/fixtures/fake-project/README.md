# fake-project fixture

Synthetic Claude Code project folder used by `test/e2e.test.ts` and
`test/e2e/crash-resume.test.ts`. All content is fabricated — no real
user paths, prompts, or transcripts.

Synthetic paths used throughout:

- Original cwd: `C:\fake\project\path`
- Encoded folder name: `C--fake-project-path`

Files:

- `sessions-index.json` — exercises the 13% "with-index" branch (gate G1).
  Top-level `originalPath` + three `entries[]` with the full G2 schema.
- `00000000-0000-0000-0000-000000000001.jsonl` — top-level transcript A.
  Line 1 is a `last-prompt` meta line without `cwd` (gate G5).
- `00000000-0000-0000-0000-000000000002.jsonl` — top-level transcript B.
  Embeds the cwd inside `message.content[].text`, `Read.input.file_path`,
  `toolUseResult.file.content`, and `Glob.input.path` (gate G6).
- `00000000-0000-0000-0000-000000000003/subagents/agent-deadbeef.jsonl` —
  subagent transcript (gate G4 layout).

Tests copy this folder to a temp dir and rename it to `C--fake-project-path`
before exercising the e2e flow.
