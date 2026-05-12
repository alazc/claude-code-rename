import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import fc from "fast-check";

import { encodePath, type HostOS } from "../src/encode.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

type TruthEntry = {
  encoded: string;
  cwd: string;
  source: string;
};

type TruthTable = {
  note?: string;
  capturedAt?: string;
  host?: string;
  ccVersion?: string;
  entries: TruthEntry[];
};

const truthTablePath = join(__dirname, "fixtures", "encode-truth-table.json");
const truthTable = JSON.parse(readFileSync(truthTablePath, "utf8")) as TruthTable;

const FORBIDDEN_CHARS = ["/", "\\", ":", " ", "_"] as const;

const hostOSArb: fc.Arbitrary<HostOS> = fc.constantFrom<HostOS>("windows", "posix");

describe("encodePath", () => {
  describe("truth-table fixture (real CC 2.1.139 data, Windows host)", () => {
    assert.ok(
      truthTable.entries.length > 0,
      "fixture must contain at least one entry",
    );

    for (const entry of truthTable.entries) {
      it(`encodes ${JSON.stringify(entry.cwd)} -> ${entry.encoded}`, () => {
        assert.equal(encodePath(entry.cwd, "windows"), entry.encoded);
      });
    }
  });

  describe("invariants (property-based)", () => {
    it("output never contains /, \\, :, space, or underscore", () => {
      fc.assert(
        fc.property(fc.string(), hostOSArb, (input, os) => {
          const out = encodePath(input, os);
          for (const ch of FORBIDDEN_CHARS) {
            if (out.includes(ch)) {
              return false;
            }
          }
          return true;
        }),
      );
    });

    it("is deterministic: same (path, os) yields same output", () => {
      fc.assert(
        fc.property(fc.string(), hostOSArb, (input, os) => {
          return encodePath(input, os) === encodePath(input, os);
        }),
      );
    });

    it("is OS-independent in v1: windows and posix yield identical output", () => {
      fc.assert(
        fc.property(fc.string(), (input) => {
          return encodePath(input, "windows") === encodePath(input, "posix");
        }),
      );
    });
  });

  describe("Unicode NFC normalization", () => {
    it("collapses NFC and NFD forms of the same string to the same encoding", () => {
      // U+00E9 (precomposed é) vs U+0065 U+0301 (e + combining acute).
      const nfc = "C:\\Users\\café";
      const nfd = "C:\\Users\\café";
      assert.notEqual(nfc, nfd, "sanity: the two inputs must differ pre-normalization");
      assert.equal(encodePath(nfc, "windows"), encodePath(nfd, "windows"));
      assert.equal(encodePath(nfc, "posix"), encodePath(nfd, "posix"));
    });
  });

  describe("known-collision contract (lossy encoding is by design)", () => {
    it("encodes 'C:\\foo bar', 'C:\\foo-bar', and 'C:\\foo_bar' to the same string", () => {
      const expected = "C--foo-bar";
      assert.equal(encodePath("C:\\foo bar", "windows"), expected);
      assert.equal(encodePath("C:\\foo-bar", "windows"), expected);
      assert.equal(encodePath("C:\\foo_bar", "windows"), expected);
    });
  });
});
