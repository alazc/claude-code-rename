// Pure, IO-free rewriters for Claude Code transcripts and sessions-index.json.
//
// Two responsibilities:
//   - rewriteJsonl:        substitute OLD_PATH → NEW_PATH inside a JSONL transcript,
//                          matching the JSON-encoded body form that appears mid-line.
//   - rewriteSessionsIndex: parse-then-serialize rewriter for sessions-index.json,
//                          which has THREE path-bearing fields per design G2:
//                            * top-level `originalPath`            (cwd substitution)
//                            * each `entries[i].projectPath`       (cwd substitution)
//                            * each `entries[i].fullPath`          (encoded-folder substitution)
//
// Substitution algorithm (used by both): single left-to-right scan with cursor
// advancement past inserted NEW after each match. NOT String.prototype.replaceAll.
// This guarantees idempotency and prevents OLD-as-prefix-of-NEW pathologies.

/**
 * The on-disk JSONL form of a path: `JSON.stringify(p).slice(1, -1)`.
 *
 * Path values appear *inside* JSON strings (e.g. `"cwd":"C:\\Users\\me\\old"`),
 * so we want the inner escaped body — not the surrounding quotes. On Windows,
 * a raw JS string `C:\Users\me\old` becomes the four-byte-per-separator form
 * `C:\\Users\\me\\old` in the on-disk JSONL bytes.
 */
function jsonBody(s: string): string {
  return JSON.stringify(s).slice(1, -1);
}

/**
 * Cursor-advancing substitution. Replace every non-overlapping occurrence of
 * `needle` in `haystack` with `replacement`, advancing the scan cursor past
 * each insertion so the inserted text is never re-scanned.
 *
 * Returns both the rewritten string and the substitution count.
 */
function substituteWithCursor(
  haystack: string,
  needle: string,
  replacement: string,
): { result: string; occurrences: number } {
  if (needle.length === 0) {
    // Pathological input — refuse to loop forever; treat as no-op.
    return { result: haystack, occurrences: 0 };
  }
  let cursor = 0;
  let occurrences = 0;
  let out = haystack;
  for (;;) {
    const idx = out.indexOf(needle, cursor);
    if (idx === -1) break;
    out = out.slice(0, idx) + replacement + out.slice(idx + needle.length);
    cursor = idx + replacement.length;
    occurrences += 1;
  }
  return { result: out, occurrences };
}

/**
 * Thrown by `rewriteSessionsIndex` when the index's `originalPath` is missing
 * or matches neither the user-supplied OLD nor NEW path. Indicates the user
 * pointed ccr at the wrong project, or the index is corrupt.
 */
export class OriginalPathMismatchError extends Error {
  readonly observedPath: string;
  readonly expectedOldPath: string;
  readonly expectedNewPath: string;
  constructor(opts: {
    observedPath: string;
    expectedOldPath: string;
    expectedNewPath: string;
  }) {
    super(
      `sessions-index.json originalPath mismatch: observed "${opts.observedPath}", ` +
        `expected "${opts.expectedOldPath}" (OLD) or "${opts.expectedNewPath}" (NEW)`,
    );
    this.name = "OriginalPathMismatchError";
    this.observedPath = opts.observedPath;
    this.expectedOldPath = opts.expectedOldPath;
    this.expectedNewPath = opts.expectedNewPath;
  }
}

/**
 * Substitute every occurrence of OLD_PATH (in JSON-encoded body form) with
 * NEW_PATH (in JSON-encoded body form) inside a JSONL transcript. Callers
 * pass raw absolute paths; this function does the JSON-escape internally.
 */
export function rewriteJsonl(
  content: string,
  oldPath: string,
  newPath: string,
): { newContent: string; occurrences: number } {
  const oldBody = jsonBody(oldPath);
  const newBody = jsonBody(newPath);
  const { result, occurrences } = substituteWithCursor(content, oldBody, newBody);
  return { newContent: result, occurrences };
}

interface SessionsIndexEntry {
  projectPath?: unknown;
  fullPath?: unknown;
  [k: string]: unknown;
}

interface SessionsIndex {
  originalPath?: unknown;
  entries?: unknown;
  [k: string]: unknown;
}

/**
 * Structured warning for an entry-level path mismatch surfaced by
 * `rewriteSessionsIndex`. Returned (not thrown, not logged) so the caller —
 * typically the CLI — owns presentation and user messaging.
 */
export type SessionsIndexWarning = {
  entryIndex: number;
  field: 'projectPath';
  observed: string;
};

/**
 * Parse-then-serialize rewriter for sessions-index.json. See the module
 * header for the three-field rewrite contract (G2).
 *
 * Defensive checks (per amendment C3, three-way switch on `originalPath`):
 *   - missing → throw OriginalPathMismatchError
 *   - equals oldPath → rewrite to newPath
 *   - equals newPath → no-op (resume case from amendment A1)
 *   - otherwise → throw OriginalPathMismatchError
 *
 * Per-entry projectPath mismatches are surfaced as structured warnings in the
 * returned `warnings` array (not thrown, not logged) so the caller owns
 * presentation. Per-entry fullPath rewrites apply OLD_ENCODED → NEW_ENCODED
 * unconditionally; absence is silent.
 *
 * Re-serialized via `JSON.stringify(obj, null, 2)`. V8 preserves key order in
 * practice; whitespace formatting may differ from the input.
 */
export function rewriteSessionsIndex(
  content: string,
  oldPath: string,
  newPath: string,
  oldEncoded: string,
  newEncoded: string,
): { content: string; warnings: SessionsIndexWarning[] } {
  const parsed = JSON.parse(content) as SessionsIndex;
  const warnings: SessionsIndexWarning[] = [];

  const observed = parsed.originalPath;
  if (typeof observed !== "string") {
    throw new OriginalPathMismatchError({
      observedPath: "<missing>",
      expectedOldPath: oldPath,
      expectedNewPath: newPath,
    });
  }
  if (observed === oldPath) {
    parsed.originalPath = newPath;
  } else if (observed === newPath) {
    // Resume case: no-op on the top-level field.
  } else {
    throw new OriginalPathMismatchError({
      observedPath: observed,
      expectedOldPath: oldPath,
      expectedNewPath: newPath,
    });
  }

  const rawEntries = parsed.entries;
  const entries: SessionsIndexEntry[] = Array.isArray(rawEntries)
    ? (rawEntries as SessionsIndexEntry[])
    : [];

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry === undefined || entry === null || typeof entry !== "object") continue;

    const projectPath = entry.projectPath;
    if (typeof projectPath === "string") {
      if (projectPath === oldPath) {
        entry.projectPath = newPath;
      } else if (projectPath === newPath) {
        // Resume case: leave as-is.
      } else {
        // Recoverable: surface a structured warning to the caller; do not throw.
        warnings.push({
          entryIndex: i,
          field: 'projectPath',
          observed: projectPath,
        });
      }
    }

    const fullPath = entry.fullPath;
    if (typeof fullPath === "string") {
      const { result } = substituteWithCursor(fullPath, oldEncoded, newEncoded);
      entry.fullPath = result;
    }
  }

  if (Array.isArray(rawEntries)) {
    parsed.entries = entries;
  }

  return { content: JSON.stringify(parsed, null, 2), warnings };
}
