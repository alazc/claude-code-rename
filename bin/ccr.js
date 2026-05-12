#!/usr/bin/env node
// Shim that forwards argv to the compiled CLI entry. Resolved relative to this
// file (not cwd) so the bin works regardless of how npm/npx invokes it.
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliUrl = pathToFileURL(path.resolve(here, '..', 'dist', 'cli.js')).href;
const { main } = await import(cliUrl);
process.exit(await main(process.argv.slice(2)));
