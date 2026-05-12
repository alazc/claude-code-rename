import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  OriginalPathMismatchError,
  rewriteJsonl,
  rewriteSessionsIndex,
} from "../src/rewrite.js";

// JSON-encoded body of a string — the form that appears mid-line in JSONL.
function jsonBody(s: string): string {
  return JSON.stringify(s).slice(1, -1);
}

describe("rewriteJsonl", () => {
  it("is idempotent: applying the rewrite twice equals once (property)", () => {
    // Idempotency holds whenever NEW does not contain OLD as a substring.
    // The cursor-advancement algorithm guarantees inserted NEW is never
    // re-scanned within one call; on a second call, OLD appearing fresh
    // inside NEW would legitimately match again — that's a user-error case
    // gated by the CLI pre-flight, not a property of `rewriteJsonl`.
    fc.assert(
      fc.property(
        fc.string(),
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        (content, oldPath, newPath) => {
          const oldBody = JSON.stringify(oldPath).slice(1, -1);
          const newBody = JSON.stringify(newPath).slice(1, -1);
          fc.pre(!newBody.includes(oldBody));
          const once = rewriteJsonl(content, oldPath, newPath).newContent;
          const twice = rewriteJsonl(once, oldPath, newPath).newContent;
          return once === twice;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("is a no-op when OLD does not appear in content", () => {
    const content = '{"event":"x","note":"nothing to see"}\n';
    const oldPath = "C:\\Users\\me\\absent";
    const newPath = "C:\\Users\\me\\new";
    // Sanity: the JSON-body form of OLD must not appear in our content.
    assert.equal(content.includes(jsonBody(oldPath)), false);

    const out = rewriteJsonl(content, oldPath, newPath);
    assert.equal(out.newContent, content);
    assert.equal(out.occurrences, 0);
  });

  it("counts every non-overlapping occurrence of OLD's JSON-body form", () => {
    const oldPath = "C:\\Users\\me\\old";
    const newPath = "C:\\Users\\me\\new";
    const oldBody = jsonBody(oldPath);
    const N = 7;
    const content = Array.from({ length: N }, (_, i) => `line${i}:${oldBody}\n`).join("");
    const out = rewriteJsonl(content, oldPath, newPath);
    assert.equal(out.occurrences, N);
    assert.equal(out.newContent.includes(oldBody), false);
    assert.equal(out.newContent.split(jsonBody(newPath)).length - 1, N);
  });

  it("matches the doubled-backslash on-disk form for Windows paths", () => {
    const oldPath = "C:\\Users\\me\\old";
    const newPath = "C:\\Users\\me\\new";
    // The on-disk JSONL bytes have doubled backslashes (escaped inside JSON strings).
    const onDisk = "C:\\\\Users\\\\me\\\\old";
    const content = `prefix ${onDisk} suffix`;
    // Sanity: `onDisk` is exactly jsonBody(oldPath).
    assert.equal(onDisk, jsonBody(oldPath));

    const out = rewriteJsonl(content, oldPath, newPath);
    assert.equal(out.occurrences, 1);
    assert.equal(out.newContent, `prefix ${jsonBody(newPath)} suffix`);
  });

  it("safely handles OLD-as-prefix-of-NEW (cursor advancement)", () => {
    const oldPath = "/foo";
    const newPath = "/foo/bar";
    const content = "...{/foo}...";
    const once = rewriteJsonl(content, oldPath, newPath);
    assert.equal(once.occurrences, 1);
    assert.equal(once.newContent, "...{/foo/bar}...");

    // Idempotent: a second pass must not find /foo inside /foo/bar.
    const twice = rewriteJsonl(once.newContent, oldPath, newPath);
    assert.equal(twice.newContent, once.newContent);
    assert.equal(twice.occurrences, 0);
  });

  it("rewrites a realistic JSONL line and round-trips through JSON.parse", () => {
    const oldPath = "C:\\Users\\me\\old";
    const newPath = "C:\\Users\\me\\new";
    const line = JSON.stringify({ event: "x", cwd: oldPath });

    const out = rewriteJsonl(line, oldPath, newPath);
    assert.equal(out.occurrences, 1);

    const parsed = JSON.parse(out.newContent) as { event: string; cwd: string };
    assert.equal(parsed.cwd, newPath);
    assert.equal(parsed.event, "x");
  });
});

describe("rewriteSessionsIndex", () => {
  const oldPath = "C:\\Users\\me\\old";
  const newPath = "C:\\Users\\me\\new";
  const oldEncoded = "C--Users-me-old";
  const newEncoded = "C--Users-me-new";

  function buildIndex(overrides: Record<string, unknown> = {}): string {
    const base = {
      version: 1,
      originalPath: oldPath,
      entries: [
        {
          sessionId: "s1",
          fullPath: `C:\\Users\\me\\.claude\\projects\\${oldEncoded}\\s1.jsonl`,
          projectPath: oldPath,
          messageCount: 4,
        },
        {
          sessionId: "s2",
          fullPath: `C:\\Users\\me\\.claude\\projects\\${oldEncoded}\\s2.jsonl`,
          projectPath: oldPath,
          messageCount: 9,
        },
      ],
      ...overrides,
    };
    return JSON.stringify(base, null, 2);
  }

  it("rewrites all three path-bearing fields on the happy path", () => {
    const out = rewriteSessionsIndex(buildIndex(), oldPath, newPath, oldEncoded, newEncoded);
    const parsed = JSON.parse(out) as {
      originalPath: string;
      entries: Array<{ projectPath: string; fullPath: string }>;
    };
    assert.equal(parsed.originalPath, newPath);
    assert.equal(parsed.entries.length, 2);
    for (const e of parsed.entries) {
      assert.equal(e.projectPath, newPath);
      assert.ok(e.fullPath.includes(newEncoded), `fullPath should contain newEncoded: ${e.fullPath}`);
      assert.equal(e.fullPath.includes(oldEncoded), false, `fullPath must not still contain oldEncoded: ${e.fullPath}`);
      // Non-encoded segments preserved.
      assert.ok(e.fullPath.startsWith("C:\\Users\\me\\.claude\\projects\\"));
    }
  });

  it("is a deep-equal no-op when originalPath already equals newPath (resume case)", () => {
    const resumed = JSON.stringify(
      {
        version: 1,
        originalPath: newPath,
        entries: [
          {
            sessionId: "s1",
            fullPath: `C:\\Users\\me\\.claude\\projects\\${newEncoded}\\s1.jsonl`,
            projectPath: newPath,
            messageCount: 4,
          },
        ],
      },
      null,
      2,
    );
    const out = rewriteSessionsIndex(resumed, oldPath, newPath, oldEncoded, newEncoded);
    assert.deepEqual(JSON.parse(out), JSON.parse(resumed));
  });

  it("throws OriginalPathMismatchError when originalPath is some third value", () => {
    const weird = buildIndex({ originalPath: "C:\\Users\\me\\completely-different" });
    assert.throws(
      () => rewriteSessionsIndex(weird, oldPath, newPath, oldEncoded, newEncoded),
      (err: unknown) => {
        if (!(err instanceof OriginalPathMismatchError)) return false;
        assert.equal(err.observedPath, "C:\\Users\\me\\completely-different");
        assert.equal(err.expectedOldPath, oldPath);
        assert.equal(err.expectedNewPath, newPath);
        return true;
      },
    );
  });

  it("throws OriginalPathMismatchError when originalPath is missing entirely", () => {
    const noOriginal = JSON.stringify(
      {
        version: 1,
        entries: [],
      },
      null,
      2,
    );
    assert.throws(
      () => rewriteSessionsIndex(noOriginal, oldPath, newPath, oldEncoded, newEncoded),
      (err: unknown) => {
        if (!(err instanceof OriginalPathMismatchError)) return false;
        assert.equal(err.observedPath, "<missing>");
        assert.equal(err.expectedOldPath, oldPath);
        assert.equal(err.expectedNewPath, newPath);
        return true;
      },
    );
  });

  it("warns (does not throw) when an entry's projectPath mismatches", () => {
    const mismatched = JSON.stringify(
      {
        version: 1,
        originalPath: oldPath,
        entries: [
          {
            sessionId: "s1",
            fullPath: `C:\\Users\\me\\.claude\\projects\\${oldEncoded}\\s1.jsonl`,
            projectPath: "C:\\Users\\me\\some-stale-other-path",
            messageCount: 4,
          },
        ],
      },
      null,
      2,
    );

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };
    try {
      const out = rewriteSessionsIndex(mismatched, oldPath, newPath, oldEncoded, newEncoded);
      const parsed = JSON.parse(out) as {
        originalPath: string;
        entries: Array<{ projectPath: string; fullPath: string }>;
      };
      // Top-level still rewritten.
      assert.equal(parsed.originalPath, newPath);
      // Entry projectPath untouched (mismatched, so preserved as-is).
      assert.equal(parsed.entries[0]?.projectPath, "C:\\Users\\me\\some-stale-other-path");
      // fullPath still rewritten unconditionally.
      assert.ok(parsed.entries[0]?.fullPath.includes(newEncoded));
      // Greppable warning emitted.
      assert.equal(warnings.length, 1);
      assert.ok(
        warnings[0]?.startsWith("[ccr] sessions-index entry 0: projectPath mismatch"),
        `unexpected warning: ${warnings[0]}`,
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  it("safely rewrites fullPath when OLD_ENCODED is a prefix of NEW_ENCODED", () => {
    const prefixOld = "C--Users-me-old";
    const prefixNew = "C--Users-me-old-new";
    const idx = JSON.stringify(
      {
        version: 1,
        originalPath: oldPath,
        entries: [
          {
            sessionId: "s1",
            fullPath: `C:\\Users\\me\\.claude\\projects\\${prefixOld}\\s1.jsonl`,
            projectPath: oldPath,
            messageCount: 4,
          },
        ],
      },
      null,
      2,
    );

    const out = rewriteSessionsIndex(idx, oldPath, newPath, prefixOld, prefixNew);
    const parsed = JSON.parse(out) as {
      entries: Array<{ fullPath: string }>;
    };
    const fp = parsed.entries[0]?.fullPath ?? "";
    // Cursor advancement must produce exactly one occurrence of NEW_ENCODED.
    const occurrences = fp.split(prefixNew).length - 1;
    assert.equal(occurrences, 1, `expected exactly one occurrence of NEW_ENCODED, got ${occurrences} in ${fp}`);
    assert.equal(fp, `C:\\Users\\me\\.claude\\projects\\${prefixNew}\\s1.jsonl`);
  });

  it("succeeds with no entries array — only top-level rewrite happens", () => {
    const minimal = JSON.stringify(
      {
        version: 1,
        originalPath: oldPath,
      },
      null,
      2,
    );
    const out = rewriteSessionsIndex(minimal, oldPath, newPath, oldEncoded, newEncoded);
    const parsed = JSON.parse(out) as { originalPath: string; entries?: unknown };
    assert.equal(parsed.originalPath, newPath);
    // Either absent, or coerced to []; both are acceptable per the spec.
    if (parsed.entries !== undefined) {
      assert.ok(Array.isArray(parsed.entries));
      assert.equal((parsed.entries as unknown[]).length, 0);
    }
  });
});
