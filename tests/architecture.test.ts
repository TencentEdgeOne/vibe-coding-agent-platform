import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [target] : [];
  }));
  return nested.flat();
}

test('frontend never imports the agent runtime', async () => {
  for (const file of await sourceFiles('app')) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(
      source,
      /(?:from\s+|import\s*)['"][^'"]*agents\//,
      `${file} crosses the app → agents boundary; move the contract to shared/`,
    );
  }
});

test('edge functions never import the agent runtime', async () => {
  for (const file of await sourceFiles('edge-functions')) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(
      source,
      /(?:from\s+|import\s*)['"][^'"]*agents\//,
      `${file} crosses the edge-functions → agents boundary; move the contract to shared/`,
    );
  }
});

test('shared modules remain runtime agnostic', async () => {
  for (const file of await sourceFiles('shared')) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(
      source,
      /(?:from\s+|import\s*)['"](?:react|next|@anthropic-ai|\.\.\/app|\.\.\/agents)/,
      `${file} contains a framework or runtime dependency`,
    );
  }
});

const AGENT_ROUTE_FILES = new Set([
  'agents/session.ts',
  'agents/preview.ts',
  'agents/stop.ts',
  'agents/file.ts',
  'agents/download.ts',
]);

test('agent routes stay at agents/ and implementation lives in agents/_lib/', async () => {
  const topLevel = await readdir('agents', { withFileTypes: true });
  for (const entry of topLevel) {
    if (entry.name === '_lib') {
      assert.ok(entry.isDirectory(), 'agents/_lib must be the private implementation directory');
      continue;
    }
    assert.ok(
      entry.isFile() && AGENT_ROUTE_FILES.has(path.join('agents', entry.name)),
      `${entry.name} is not a known agent route; move internals under agents/_lib/`,
    );
  }

  for (const file of await sourceFiles(path.join('agents', '_lib'))) {
    assert.ok(
      !path.basename(file).startsWith('_'),
      `${file} is already private via agents/_lib/; drop the underscore prefix`,
    );
  }
});
