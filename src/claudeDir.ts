import os from 'node:os';
import path from 'node:path';

export type ResolveOptions = { dataDirOverride?: string };

/**
 * Resolve the Claude Code data root in priority order:
 *   1. opts.dataDirOverride (the --data-dir CLI flag)
 *   2. process.env.CLAUDE_CONFIG_DIR
 *   3. Platform default: path.join(os.homedir(), '.claude')
 *      (Verified on Windows: CC uses ~/.claude, not %APPDATA% or %LOCALAPPDATA%.)
 *
 * Returns an absolute, normalized path. Does NOT verify the directory exists.
 */
export function resolveClaudeDir(opts?: ResolveOptions): string {
  const override = opts?.dataDirOverride;
  if (override !== undefined && override !== '') {
    return toAbsolute(override);
  }

  const envVar = process.env.CLAUDE_CONFIG_DIR;
  if (envVar !== undefined && envVar !== '') {
    return toAbsolute(envVar);
  }

  return path.normalize(path.join(os.homedir(), '.claude'));
}

/**
 * Resolve the projects subdirectory of the Claude Code data root.
 */
export function resolveProjectsDir(opts?: ResolveOptions): string {
  return path.join(resolveClaudeDir(opts), 'projects');
}

/**
 * Expand a leading `~` to the home directory, then resolve to an absolute,
 * normalized path. Does no symlink resolution.
 */
function toAbsolute(p: string): string {
  let expanded = p;
  if (expanded === '~') {
    expanded = os.homedir();
  } else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  }
  return path.resolve(expanded);
}
