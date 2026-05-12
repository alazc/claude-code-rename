// Pure, IO-free path encoder. Mirrors Claude Code 2.1.139's folder-name rule.
// Verified 63/63 against test/fixtures/encode-truth-table.json (real CC data, Windows host).

export type HostOS = "windows" | "posix";

/**
 * Encode an absolute path into the folder name Claude Code uses under
 * `<claude-data-root>/projects/`.
 *
 * Rule (per design G3, supersedes P1; verified 63/63 against real CC 2.1.139
 * data on Windows): NFC-normalize, then replace each of `:`, `\`, `/`, ` `,
 * `_` with `-`. No other characters are transformed. Order is irrelevant
 * because every target collapses to the same output character.
 *
 * `hostOS` is accepted as an explicit parameter (not derived from
 * `process.platform` inside this function) so that:
 *   (a) Windows-encoding logic is property-testable on a Linux CI runner
 *       without requiring a Windows job to catch encoder bugs, and
 *   (b) a future v2 cross-OS migration has a clean seam to branch on.
 * For v1 the substitution rule is uniform across host OSes — all five target
 * characters need the same treatment everywhere — so the parameter is
 * intentionally not branched on. The colon rule is effectively a no-op
 * against typical posix paths but is still applied uniformly.
 */
export function encodePath(absolutePath: string, hostOS: HostOS): string {
  // hostOS is reserved for future cross-OS extensibility; reference it so
  // callers see a real dependency and TS doesn't flag an unused param.
  void hostOS;
  return absolutePath
    .normalize("NFC")
    .replace(/[:\\/ _]/g, "-");
}
