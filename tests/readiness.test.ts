import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createMemoryBlobStore } from '../agents/_lib/session/store.ts';
import {
  ensureDependencies,
  ensurePreview,
  ensureSandbox,
  ensureWorkspace,
} from '../agents/_lib/project/readiness.ts';
import { createProjectState } from '../agents/_lib/project/state.ts';
import type { AgentContext, BlobStoreLike } from '../agents/_lib/runtime/context.ts';

/**
 * A sandbox whose project directory already has files and whose dev server is
 * already answering, so a preview costs one host lookup and nothing else. Every
 * call it serves is counted, because the point of the layer is how few there
 * are when several callers ask at once.
 */
function fakeReadySandbox(options: { packageJson?: boolean } = {}) {
  const calls = {
    extendTimeout: 0,
    makeDir: 0,
    exists: 0,
    restore: 0,
    commands: 0,
    getHost: 0,
  };
  const commands: string[] = [];
  const files = new Set([
    'projects/cid/app',
    'projects/cid/app/index.html',
    ...(options.packageJson === false ? [] : ['projects/cid/app/package.json', 'projects/cid/app/node_modules']),
  ]);
  const blobStore: BlobStoreLike = createMemoryBlobStore();
  const context = {
    blobStore,
    sandbox: {
      envdAccessToken: 'token-current',
      browser: {},
      extendTimeout: async () => {
        calls.extendTimeout += 1;
      },
      getHost: async (port: number) => {
        calls.getHost += 1;
        return `preview-${port}.sandbox.example`;
      },
      restore: async () => {
        calls.restore += 1;
        return { restored: false };
      },
      files: {
        makeDir: async () => {
          calls.makeDir += 1;
        },
        exists: async (target: string) => {
          calls.exists += 1;
          return files.has(target);
        },
      },
      commands: {
        run: async (command: string) => {
          calls.commands += 1;
          commands.push(command);
          // The file-tree `find` and the two curl probes both answer healthily.
          return command.includes('find')
            ? { exitCode: 0, stdout: 'index.html\n', stderr: '' }
            : { exitCode: 0, stdout: 'EXIT:0\n', stderr: '' };
        },
      },
    },
  } as unknown as AgentContext;
  return { context, calls, commands };
}

test('four callers asking for a preview at once produce one dev server launch', async () => {
  const { context, calls } = fakeReadySandbox();

  const state = createProjectState('cid');
  state.created = true;
  const results = await Promise.all([
    ensurePreview(context, 'cid', state),
    ensurePreview(context, 'cid', state),
    ensurePreview(context, 'cid', state),
    ensurePreview(context, 'cid', state),
  ]);

  // Every caller gets the same answer, and only one of them paid for it. This
  // is what replaced the hand-rolled hostPreviewInFlight guard that only the
  // chat turn used to have.
  assert.equal(new Set(results.map((result) => result.url)).size, 1);
  assert.equal(calls.getHost, 1, 'the public host is resolved once for all four callers');
  for (const result of results) {
    assert.match(result.url || '', /^https:\/\/preview-9000\.sandbox\.example\/preview\/\?access_token=token-current$/);
    assert.equal(result.restarted, false);
  }
});

test('a healthy dev server is a token mint, not a restart', async () => {
  const { context, commands } = fakeReadySandbox();

  const state = createProjectState('cid');
  state.created = true;
  state.previewUrl = 'https://preview-9000.sandbox.example/preview/?access_token=token-expired';
  const preview = await ensurePreview(context, 'cid', state);

  // The token the caller stored is gone from the URL, replaced by this
  // request's own, and nothing was launched to make that happen.
  assert.match(preview.url || '', /access_token=token-current$/);
  assert.equal(preview.restarted, false);
  assert.ok(
    !commands.some((command) => command.includes('makers dev')),
    'a live server must not be relaunched to refresh a token',
  );
});

test('a project with no package.json still gets a preview', async () => {
  const { context } = fakeReadySandbox({ packageJson: false });

  // A static site declares no dependencies, so "dependencies are ready" is
  // true for it. This used to read as a failure and blocked the resume path
  // while the same site previewed fine inside a chat turn.
  const state = createProjectState('cid');
  assert.equal(await ensureDependencies(context, state), true);

  state.created = true;
  const preview = await ensurePreview(context, 'cid', state);
  assert.ok(preview.url, 'a static site must still resolve a preview URL');
});

test('a deployed preview is returned untouched, with no sandbox work', async () => {
  const { context, calls } = fakeReadySandbox();

  const state = createProjectState('cid');
  state.created = true;
  state.previewKind = 'makers';
  state.previewUrl = 'https://demo.edgeone.app/';
  const preview = await ensurePreview(context, 'cid', state);

  assert.equal(preview.url, 'https://demo.edgeone.app/');
  assert.equal(preview.kind, 'makers');
  assert.equal(preview.restarted, false);
  assert.equal(calls.getHost, 0, 'a Makers URL has no sandbox host to look up');
  assert.equal(calls.commands, 0, 'and no process in this sandbox to probe');
});

test('the sandbox level is settled once per request, not once per asker', async () => {
  const { context, calls } = fakeReadySandbox();

  await ensureSandbox(context, 'cid');
  await ensureSandbox(context, 'cid');
  assert.equal(calls.extendTimeout, 1, 'a live sandbox stays live for the rest of the request');
  assert.equal(calls.makeDir, 2, 'sessionDir and appDir, once for both askers');

  await ensureWorkspace(context, 'cid');
  assert.equal(calls.extendTimeout, 1, 'the level above inherits level 1 rather than repeating it');
  // The workspace level re-creates the directories after touching the tree,
  // because a snapshot restore unpacks over appDir and the layout repair moves
  // its contents. That pair is the cost of the restore, not of asking twice.
  assert.equal(calls.makeDir, 4);
});

test('a failed level can be retried inside the same request', async () => {
  const { context, calls } = fakeReadySandbox();
  const sandbox = (context as unknown as { sandbox: Record<string, unknown> }).sandbox;
  let failures = 1;
  sandbox.extendTimeout = async () => {
    calls.extendTimeout += 1;
    if (failures-- > 0) throw new Error('sandbox is waking up');
  };
  // extendTimeout failures are swallowed by design, so fail the step after it.
  const makeDir = (sandbox.files as { makeDir: () => Promise<void> }).makeDir;
  let dirFailures = 1;
  (sandbox.files as { makeDir: () => Promise<void> }).makeDir = async () => {
    if (dirFailures-- > 0) throw new Error('sandbox is waking up');
    return makeDir();
  };

  await assert.rejects(ensureSandbox(context, 'cid'), /waking up/);
  // A rejection is not kept, so the level is askable again rather than poisoned
  // for the rest of the request.
  const state = await ensureSandbox(context, 'cid');
  assert.equal(state.appDir, 'projects/cid/app');
});

test('the readiness chain is the only place that starts a preview', async () => {
  const sources = await Promise.all([
    readFile('agents/_lib/turn/chat.ts', 'utf8'),
    readFile('agents/_lib/session/resume.ts', 'utf8'),
    readFile('agents/_lib/session/gateway-apply.ts', 'utf8'),
    readFile('agents/_lib/tools/preview-command-result.ts', 'utf8'),
    readFile('agents/_lib/tools/preview-tools.ts', 'utf8'),
  ]);

  for (const source of sources) {
    assert.match(source, /ensurePreview\(/);
    // startPreviewServer is level 3.5 and belongs to the readiness layer. The
    // two remaining direct callers ask it to restart a process they just
    // stopped, which is not the same request as "give me a URL".
    assert.doesNotMatch(source, /publishRunningPreview/);
  }

  const direct = await Promise.all([
    readFile('agents/_lib/turn/deploy.ts', 'utf8'),
    readFile('agents/_lib/tools/commands-wrap.ts', 'utf8'),
  ]);
  for (const source of direct) {
    assert.match(
      source,
      /startPreviewServer\(/,
      'a deploy stops the dev server and restarts it without republishing a link',
    );
  }
});
