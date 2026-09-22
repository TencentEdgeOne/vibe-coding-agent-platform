import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  createMemoryBlobStore,
  getConversationRecord,
  patchConversationRecord,
} from '../agents/_lib/session/store.ts';
import {
  iterateConversationPrep,
  iterateSandboxAndAgentPrep,
  persistConversationPreferences,
  prepareSandboxWorkspace,
  sessionPrepSse,
} from '../agents/_lib/session/prepare.ts';
import { ensureWorkspace } from '../agents/_lib/project/readiness.ts';
import { timeStage } from '../agents/_lib/utils/timing.ts';
import { sseEvent } from '../agents/_lib/runtime/sse.ts';
import type { AgentContext, BlobStoreLike } from '../agents/_lib/runtime/context.ts';
import { prepStageRange } from '../app/features/workspace/session-prep-progress.ts';
import { I18N, LIVE_TURN, WORKSPACE, surface } from './helpers/source.ts';

function parsePrepLabels(chunks: string[]) {
  return chunks.map((chunk) => {
    const line = chunk.replace(/^data: /, '').trim();
    const event = JSON.parse(line) as { data?: { stage?: string; status?: string; mode?: string } };
    return `${event.data?.stage}:${event.data?.status}`;
  });
}

function fakeContext() {
  const inner = createMemoryBlobStore();
  const stats = { gets: 0, setJSONs: 0 };
  const made: string[] = [];
  const exists: string[] = [];
  const dirs = new Set<string>();
  const blobStore: BlobStoreLike = {
    set: (key, value, options) => inner.set(key, value, options),
    delete: (key) => inner.delete(key),
    list: (options) => inner.list(options),
    async get(key, options) {
      stats.gets += 1;
      return inner.get(key, options);
    },
    async setJSON(key, value, options) {
      stats.setJSONs += 1;
      return inner.setJSON(key, value, options);
    },
  };
  return {
    blobStore,
    stats,
    made,
    exists,
    dirs,
    context: {
      blobStore,
      sandbox: {
        extendTimeout: async () => {},
        restore: async () => ({ restored: false }),
        files: {
          makeDir: async (target: string) => {
            made.push(target);
            dirs.add(target);
          },
          exists: async (target: string) => {
            exists.push(target);
            return dirs.has(target);
          },
        },
        commands: {
          run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        },
      },
    } as unknown as AgentContext,
  };
}

function fakeWorkspaceContext() {
  const fixture = fakeContext();
  const restoreCount = { value: 0 };
  const commandCount = { value: 0 };
  const sandbox = (fixture.context as { sandbox: Record<string, unknown> }).sandbox;
  sandbox.restore = async () => {
    restoreCount.value += 1;
    return { restored: false };
  };
  (sandbox as { commands: { run: () => Promise<unknown> } }).commands.run = async () => {
    commandCount.value += 1;
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return { ...fixture, restoreCount, commandCount };
}

test('session prep progress never jumps backward between stages', () => {
  let previous = 0;
  for (const stage of ['conversation', 'sandbox', 'agent', 'workspace', 'preview', 'ready'] as const) {
    const range = prepStageRange(stage);
    assert.ok(range.floor >= previous, `${stage} floor ${range.floor} went backward from ${previous}`);
    assert.ok(range.ceiling >= range.floor);
    previous = range.floor;
  }
  assert.equal(prepStageRange('ready').floor, 100);
  assert.equal(prepStageRange(null).floor, prepStageRange('conversation').floor);
});

test('session_prep events name the stage and status, not a user-facing sentence', () => {
  const payload = sessionPrepSse('create', 'sandbox', 'running');
  assert.match(payload, /"type":"session_prep"/);
  assert.match(payload, /"mode":"create"/);
  assert.match(payload, /"stage":"sandbox"/);
  assert.match(payload, /"status":"running"/);
  assert.equal(payload, sseEvent({
    type: 'session_prep',
    data: { mode: 'create', stage: 'sandbox', status: 'running' },
  }));
});

test('conversation prep persists model and language on a brand-new cid', async () => {
  const { context } = fakeContext();
  await persistConversationPreferences(context, 'cid-new', {
    model: 'kimi-k2.6',
    language: 'zh',
  });
  const record = await getConversationRecord(context, 'cid-new');
  assert.equal(record.modelPreference, 'kimi-k2.6');
  assert.equal(record.languagePreference, 'zh');
  assert.equal(record.projectState.created, false);
  assert.match(record.projectState.appDir, /projects\/cid-new\/app/);
});

test('sandbox prep extends the timeout and creates the empty app directory', async () => {
  const fixture = fakeContext();
  const state = await prepareSandboxWorkspace(fixture.context, 'cid-sandbox');
  assert.deepEqual(fixture.made, [state.sessionDir, state.appDir]);
  assert.equal(state.created, false);
});

test('conversation prep emits running then done and persists preferences', async () => {
  const fixture = fakeContext();
  const events: string[] = [];
  for await (const chunk of iterateConversationPrep(fixture.context, 'cid-flow', {
    mode: 'create',
    model: 'kimi-k2.6',
    language: 'en',
  })) {
    events.push(chunk);
  }

  const stages = events.map((chunk) => {
    const line = chunk.replace(/^data: /, '').trim();
    return JSON.parse(line) as {
      type: string;
      data?: { stage?: string; status?: string; mode?: string };
    };
  });
  assert.deepEqual(
    stages.map((event) => `${event.data?.stage}:${event.data?.status}`),
    ['conversation:running', 'conversation:done'],
  );
  assert.equal(stages[0]?.data?.mode, 'create');
  const record = await getConversationRecord(fixture.context, 'cid-flow');
  assert.equal(record.languagePreference, 'en');
  assert.equal(record.modelPreference, 'kimi-k2.6');
});

test('restore conversation prep skips an empty preference patch', async () => {
  const fixture = fakeContext();
  const events: string[] = [];
  for await (const chunk of iterateConversationPrep(fixture.context, 'cid-empty-patch', {
    mode: 'restore',
  })) {
    events.push(chunk);
  }

  assert.deepEqual(parsePrepLabels(events), ['conversation:running', 'conversation:done']);
  assert.equal(fixture.stats.setJSONs, 0);
  const record = await getConversationRecord(fixture.context, 'cid-empty-patch');
  assert.equal(record.modelPreference, undefined);
  assert.equal(record.languagePreference, undefined);
});

test('sandbox activation and CLI warmup run together and both finish', async () => {
  const fixture = fakeContext();
  const events: string[] = [];
  for await (const chunk of iterateSandboxAndAgentPrep(fixture.context, 'cid-parallel', {
    mode: 'create',
  })) {
    events.push(chunk);
  }

  const labels = parsePrepLabels(events);
  assert.ok(labels.includes('sandbox:running'));
  assert.ok(labels.includes('sandbox:done'));
  assert.ok(labels.includes('agent:running'));
  assert.ok(labels.includes('agent:done') || labels.includes('agent:failed'));
  assert.ok(
    labels.indexOf('sandbox:running') < labels.indexOf('sandbox:done'),
    'sandbox must finish after it starts',
  );
  const agentDone = labels.findIndex((label) => label === 'agent:done' || label === 'agent:failed');
  assert.ok(labels.indexOf('agent:running') < agentDone);
  assert.ok(fixture.made.length >= 2, 'sandbox directories are created during the parallel warmup');
});

test('a conversation record patch is visible to the next read on the same context', async () => {
  const { context, stats } = fakeContext();
  await getConversationRecord(context, 'cid-cache');
  const getsAfterFirstRead = stats.gets;
  await getConversationRecord(context, 'cid-cache');
  assert.equal(stats.gets, getsAfterFirstRead, 'the second read must reuse the per-request memo');

  await patchConversationRecord(context, 'cid-cache', { modelPreference: 'kimi-k2.6' });
  const record = await getConversationRecord(context, 'cid-cache');
  assert.equal(record.modelPreference, 'kimi-k2.6');
});

test('a conversation record patch reads through the memo then refreshes it', async () => {
  const { context, blobStore } = fakeContext();
  const cached = await getConversationRecord(context, 'cid-cache-fresh');
  await blobStore.setJSON('conv/cid-cache-fresh/state.json', {
    projectState: cached.projectState,
    modelPreference: 'from-disk',
  });

  const stale = await getConversationRecord(context, 'cid-cache-fresh');
  assert.equal(stale.modelPreference, undefined);

  await patchConversationRecord(context, 'cid-cache-fresh', { languagePreference: 'zh' });
  const next = await getConversationRecord(context, 'cid-cache-fresh');
  assert.equal(next.modelPreference, 'from-disk');
  assert.equal(next.languagePreference, 'zh');
});

test('create prep lets the first workspace restore skip sandbox probes', async () => {
  const fixture = fakeWorkspaceContext();
  const conversationId = 'cid-fresh-memo';
  await prepareSandboxWorkspace(fixture.context, conversationId, { mode: 'create' });
  const afterPrep = {
    made: fixture.made.length,
    exists: fixture.exists.length,
    restore: fixture.restoreCount.value,
    commands: fixture.commandCount.value,
  };

  const first = await ensureWorkspace(fixture.context, conversationId);
  assert.equal(first.hasFiles, false);
  assert.equal(fixture.made.length, afterPrep.made, 'memo path must not mkdir again');
  assert.equal(fixture.exists.length, afterPrep.exists, 'memo path must not probe layout or files');
  assert.equal(fixture.restoreCount.value, afterPrep.restore, 'memo path must not call sandbox.restore');
  assert.equal(fixture.commandCount.value, afterPrep.commands, 'memo path must not run find');

  const second = await ensureWorkspace(fixture.context, conversationId);
  assert.equal(second.hasFiles, false);
  assert.ok(fixture.exists.length > afterPrep.exists, 'a second restore must probe the sandbox');
  assert.ok(fixture.restoreCount.value > afterPrep.restore, 'a second restore must try the snapshot');
});

test('restore prep does not consume the create-only workspace memo', async () => {
  const fixture = fakeWorkspaceContext();
  const conversationId = 'cid-restore-no-memo';
  await prepareSandboxWorkspace(fixture.context, conversationId, { mode: 'restore' });
  const existsAfterPrep = fixture.exists.length;

  await ensureWorkspace(fixture.context, conversationId);
  assert.ok(fixture.exists.length > existsAfterPrep);
});

test('timeStage returns the inner result and logs elapsed time', async () => {
  const lines: unknown[][] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => {
    lines.push(args);
  };
  try {
    const value = await timeStage('session:prep', { mode: 'create', stage: 'conversation' }, async () => 7);
    assert.equal(value, 7);
    assert.ok(lines.some((entry) => entry[0] === '[session:prep]'));
  } finally {
    console.info = original;
  }
});

test('warmLiveQuery reuses a live process and recycles one that never starts a turn', async () => {
  const live = await readFile('agents/_lib/session/live.ts', 'utf8');
  assert.match(live, /export async function warmLiveQuery/);
  assert.match(live, /liveQueries\.get\(options\.conversationId\)/);
  assert.match(live, /scheduleIdleClose/);
  assert.match(live, /LIVE_QUERY_IDLE_MS/);
  assert.doesNotMatch(live, /WARM_LIVE_QUERY_BUDGET_MS/);
  assert.doesNotMatch(live, /waitForLiveSessionId/);
  // The prompt is rendered once per process from constants only. Neither the
  // reply language nor whether the project is new reaches it any more: the
  // language rule follows the user's own language and the model reads the
  // workspace itself.
  assert.match(live, /systemPrompt: buildPrompt\(\s*session\.getState\(\),\s*SANDBOX_MCP_SERVER_NAME,\s*\)/);
  assert.doesNotMatch(live, /options\.language/);
  assert.doesNotMatch(live, /options\.isNewProject/);
  assert.doesNotMatch(live, /SCAFFOLD_TOOL_NAME/);
  assert.doesNotMatch(live, /onWorkspaceReady/);
});

test('GET /session merges restore history with warmup and emits ready before workspace', async () => {
  const resume = await readFile('agents/_lib/session/resume.ts', 'utf8');
  assert.match(resume, /iterateConversationPrep/);
  assert.match(resume, /mode === 'create'/);
  assert.match(resume, /iterateSandboxAndAgentPrep/);
  assert.match(resume, /sessionPrepSse\(mode, 'ready', 'done'\)/);
  assert.match(resume, /type: 'resume_history'/);
  // The warmup is no longer told whether the project has files: the prompt is
  // identical either way, and the model reads the workspace itself.
  assert.doesNotMatch(resume, /isNewProject/);
  assert.match(resume, /const hasProject = Boolean\(state\.created\) \|\| activityHistoryImpliesProject/);

  const createStart = resume.indexOf("if (mode === 'create')");
  const createReturn = resume.indexOf('return;', createStart);
  const createBranch = resume.slice(createStart, createReturn);
  assert.match(createBranch, /mergeSseGenerators/);
  assert.match(createBranch, /iterateConversationPrep/);
  assert.match(createBranch, /iterateSandboxAndAgentPrep/);
  assert.doesNotMatch(createBranch, /loadProjectResumeHistory/);
  assert.doesNotMatch(createBranch, /iterateWorkspaceResumeEvents/);
  const readyInCreate = createBranch.indexOf("sessionPrepSse(mode, 'ready', 'done')");
  assert.ok(readyInCreate > createBranch.indexOf('iterateSandboxAndAgentPrep'));

  const restoreBranch = resume.slice(createReturn);
  const readyInRestore = restoreBranch.indexOf("sessionPrepSse(mode, 'ready', 'done')");
  const workspaceInRestore = restoreBranch.indexOf('iterateWorkspaceResumeEvents');
  assert.ok(restoreBranch.indexOf('iterateHistoryEvent') >= 0);
  assert.ok(readyInRestore >= 0 && workspaceInRestore >= 0);
  assert.ok(
    readyInRestore < workspaceInRestore,
    'restore ready must be yielded before workspace resume events',
  );

  const prepare = await readFile('agents/_lib/session/prepare.ts', 'utf8');
  assert.match(prepare, /mergeSseGenerators\(\[\s*iterateSandboxPrepEvents/);
  assert.match(prepare, /iterateAgentWarmupEvents/);
  assert.match(prepare, /if \(!model && !language\)/);
  assert.match(prepare, /markFresh: options\.mode === 'create'/);

  const readiness = await readFile('agents/_lib/project/readiness.ts', 'utf8');
  assert.match(readiness, /export function markFreshWorkspace/);
  assert.match(readiness, /FRESH_WORKSPACE_TTL_MS = 5 \* 60 \* 1000/);
  assert.match(readiness, /Promise\.all\(\[\s*files\.makeDir\(state\.sessionDir\),\s*files\.makeDir\(state\.appDir\),/);

  const transcript = await readFile('agents/_lib/session/transcript.ts', 'utf8');
  assert.match(transcript, /getConversationRecord\(context, conversationId, \{ refresh: true \}\)/);
});

test('the prompt no longer tells the model to prepare the environment', async () => {
  const prompt = await readFile('agents/_lib/prompt.ts', 'utf8');
  assert.doesNotMatch(prompt, /ensure_project_scaffold/);
  assert.match(prompt, /load_makers_skill as the first tool/);
  // The host prepared the directory, but whether it holds files is the model's
  // to check — asserting emptiness here outlived the empty workspace.
  assert.match(prompt, /host has already prepared the project directory/);
  assert.doesNotMatch(prompt, /has already prepared an empty/);
});

test('frontend copy names each session prep stage in both languages', async () => {
  const i18n = await surface(I18N);
  for (const stage of ['conversation', 'sandbox', 'agent', 'workspace', 'preview', 'ready']) {
    assert.match(i18n, new RegExp(`${stage}: '`));
  }
  assert.match(i18n, /正在创建会话/);
  assert.match(i18n, /Creating the conversation/);
  assert.match(i18n, /正在唤醒编码代理/);
  assert.match(i18n, /Waking the coding agent/);
  assert.match(i18n, /正在准备环境/);
  assert.match(i18n, /Preparing the environment/);
});

test('the workspace consumes session_prep as a loading screen, not a chat turn', async () => {
  const [api, liveTurn, resume, screen] = await Promise.all([
    surface('app/features/workspace/workspace-api.ts'),
    surface(LIVE_TURN),
    surface('app/features/workspace/hooks/use-session-resume.ts'),
    surface(WORKSPACE),
  ]);
  assert.match(api, /params\.set\('model'/);
  assert.match(api, /params\.set\('language'/);
  assert.match(api, /params\.set\('mode'/);
  assert.match(liveTurn, /mode: 'create'/);
  assert.match(liveTurn, /setSessionPreparing\(true\)/);
  assert.match(liveTurn, /setPrepStage\(event\.data\.stage\)/);
  assert.match(liveTurn, /onReady:/);
  assert.match(liveTurn, /options\.onReady\(\)/);
  assert.doesNotMatch(liveTurn, /sessionPrepToChatEvents/);
  assert.doesNotMatch(liveTurn, /name: 'environment'/);
  assert.doesNotMatch(liveTurn, /consumeEventStream\(resumeResponse, \(\) => \{\}\)/);
  assert.match(resume, /mode: 'restore'/);
  assert.match(resume, /openSessionStream\([\s\S]*\{\s*mode: 'restore',\s*\}\)/);
  assert.match(resume, /setPrepStage\(event\.data\.stage\)/);
  assert.match(resume, /event\.data\.stage === 'ready'/);
  assert.match(resume, /setResumeChecked\(true\);\s*setPrepStage\(null\)/);
  assert.match(screen, /live\.sessionPreparing/);
  assert.match(screen, /SessionPrepLoading/);
  assert.match(screen, /t\.workspace\.preparing/);
  const loading = await surface(
    'app/features/workspace/components/session-prep-loading.tsx',
  );
  assert.match(loading, /role="progressbar"/);
  assert.match(loading, /usePrepProgress/);
  const css = await readFile('app/styles/workspace.css', 'utf8');
  assert.match(css, /\.session-prep-bar-fill/);
  assert.match(css, /@keyframes session-prep-sheen/);
  assert.match(resume, /if \(!restored\) \{[\s\S]*?setResumeChecked\(true\)/);
  assert.match(resume, /finally \{[\s\S]*setResumeChecked\(true\)/);
  assert.match(resume, /finally \{[\s\S]*setWorkspaceRestoring\(false\)/);
});
