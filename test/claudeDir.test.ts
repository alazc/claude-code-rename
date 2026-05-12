import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { resolveClaudeDir, resolveProjectsDir } from '../src/claudeDir.js';

const ENV_KEY = 'CLAUDE_CONFIG_DIR';

function withEnv<T>(value: string | undefined, fn: () => T): T {
  const saved = process.env[ENV_KEY];
  try {
    if (value === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = value;
    }
    return fn();
  } finally {
    if (saved === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = saved;
    }
  }
}

test('dataDirOverride wins over env var and default', () => {
  withEnv('/env/var/path', () => {
    const override = path.resolve('/some/override/dir');
    const result = resolveClaudeDir({ dataDirOverride: override });
    assert.equal(result, override);
  });
});

test('dataDirOverride wins even when env var is unset', () => {
  withEnv(undefined, () => {
    const override = path.resolve('/another/override');
    const result = resolveClaudeDir({ dataDirOverride: override });
    assert.equal(result, override);
  });
});

test('CLAUDE_CONFIG_DIR env var wins when no override is supplied', () => {
  withEnv(path.resolve('/env/claude/dir'), () => {
    const result = resolveClaudeDir();
    assert.equal(result, path.resolve('/env/claude/dir'));
  });
});

test('default falls to ~/.claude when neither override nor env is set', () => {
  withEnv(undefined, () => {
    const result = resolveClaudeDir();
    const expected = path.normalize(path.join(os.homedir(), '.claude'));
    assert.equal(result, expected);
  });
});

test('default falls to ~/.claude when override is omitted from opts object', () => {
  withEnv(undefined, () => {
    const result = resolveClaudeDir({});
    const expected = path.normalize(path.join(os.homedir(), '.claude'));
    assert.equal(result, expected);
  });
});

test('override with leading ~ is expanded to the home directory', () => {
  withEnv(undefined, () => {
    const result = resolveClaudeDir({ dataDirOverride: '~' });
    assert.equal(result, path.resolve(os.homedir()));
  });
});

test('override with ~/subdir is expanded to the home directory', () => {
  withEnv(undefined, () => {
    const result = resolveClaudeDir({ dataDirOverride: '~/custom-claude' });
    const expected = path.resolve(path.join(os.homedir(), 'custom-claude'));
    assert.equal(result, expected);
  });
});

test('relative override is resolved to an absolute path', () => {
  withEnv(undefined, () => {
    const result = resolveClaudeDir({ dataDirOverride: 'relative/path' });
    assert.equal(path.isAbsolute(result), true);
    assert.equal(result, path.resolve('relative/path'));
  });
});

test('env var with empty string is treated as unset (falls to default)', () => {
  withEnv('', () => {
    const result = resolveClaudeDir();
    const expected = path.normalize(path.join(os.homedir(), '.claude'));
    assert.equal(result, expected);
  });
});

test('override with empty string is treated as unset (falls to env var)', () => {
  withEnv(path.resolve('/env/path'), () => {
    const result = resolveClaudeDir({ dataDirOverride: '' });
    assert.equal(result, path.resolve('/env/path'));
  });
});

test('resolveProjectsDir appends "projects" to resolveClaudeDir (default)', () => {
  withEnv(undefined, () => {
    const root = resolveClaudeDir();
    const projects = resolveProjectsDir();
    assert.equal(projects, path.join(root, 'projects'));
  });
});

test('resolveProjectsDir appends "projects" with override', () => {
  withEnv(undefined, () => {
    const override = path.resolve('/some/where');
    const projects = resolveProjectsDir({ dataDirOverride: override });
    assert.equal(projects, path.join(override, 'projects'));
  });
});

test('resolveProjectsDir appends "projects" with env var', () => {
  const envPath = path.resolve('/env/dir');
  withEnv(envPath, () => {
    const projects = resolveProjectsDir();
    assert.equal(projects, path.join(envPath, 'projects'));
  });
});

test('returned path is always absolute', () => {
  withEnv(undefined, () => {
    assert.equal(path.isAbsolute(resolveClaudeDir()), true);
    assert.equal(path.isAbsolute(resolveClaudeDir({ dataDirOverride: 'rel' })), true);
  });
  withEnv('also-relative', () => {
    assert.equal(path.isAbsolute(resolveClaudeDir()), true);
  });
});
