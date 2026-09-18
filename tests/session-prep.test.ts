import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createMemoryBlobStore } from '../agents/_lib/session/store.ts';
import {
  iterateConversationPrep,
  iterateSandboxAndAgentPrep,
  persistConversationPreferences,
  prepareSandboxWorkspace,
  sessionPrepSse,
} from '../agents/_lib/session/prepare.ts';
import { getConversationRecord } from '../agents/_lib/session/store.ts';
import { sseEvent } from '../agents/_lib/runtime/sse.ts';
import type { AgentContext } from '../agents/_lib/runtime/context.ts';
import { prepStageRange } from '../app/features/workspace/session-prep-progress.ts';

function fakeContext() {
  const blobStore = createMemoryBlobStore();
  const made: string[] = [];
  return {
    context: {
      blobStore,
      sandbox: {
        extendTimeout: async () => {},
        files: {
          makeDir: async (target: string) => {
            made.push(target);
          },
          exists: async () => false,
        },
      },
    } as unknown as AgentContext,
    made,
  };
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

test('conversation prep streams before the sandbox and agent start', async () => {
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

test('sandbox activation and CLI warmup run together and both finish', async () => {
  const fixture = fakeContext();
  const events: string[] = [];
  for await (const chunk of iterateSandboxAndAgentPrep(fixture.context, 'cid-parallel', {
    mode: 'create',
    isNewProject: true,
  })) {
    events.push(chunk);
  }

  const stages = events.map((chunk) => {
    const line = chunk.replace(/^data: /, '').trim();
    return JSON.parse(line) as {
      data?: { stage?: string; status?: string };
    };
  });
  const labels = stages.map((event) => `${event.data?.stage}:${event.data?.status}`);
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

test('warmLiveQuery reuses a live process and recycles one that never starts a turn', async () => {
  const live = await readFile('agents/_lib/session/live.ts', 'utf8');
  assert.match(live, /export async function warmLiveQuery/);
  assert.match(live, /liveQueries\.get\(options\.conversationId\)/);
  assert.match(live, /scheduleIdleClose/);
  assert.match(live, /LIVE_QUERY_IDLE_MS/);
  assert.match(live, /WARM_LIVE_QUERY_BUDGET_MS/);
  assert.doesNotMatch(live, /SCAFFOLD_TOOL_NAME/);
  assert.doesNotMatch(live, /onWorkspaceReady/);
});

test('GET /session streams prep stages before history on restore, and only prep on create', async () => {
  const resume = await readFile('agents/_lib/session/resume.ts', 'utf8');
  assert.match(resume, /iterateConversationPrep/);
  assert.match(resume, /mode === 'create'/);
  assert.match(resume, /iterateSandboxAndAgentPrep/);
  assert.match(resume, /sessionPrepSse\(mode, 'ready', 'done'\)/);
  assert.match(resume, /type: 'resume_history'/);
  const createBranch = resume.slice(resume.indexOf("if (mode === 'create')"));
  const historyCall = resume.indexOf('loadProjectResumeHistory');
  const warmupInCreate = createBranch.indexOf('iterateSandboxAndAgentPrep');
  assert.ok(warmupInCreate >= 0);
  assert.ok(historyCall > resume.indexOf('iterateConversationPrep'));
  const readyInCreate = createBranch.indexOf("sessionPrepSse(mode, 'ready', 'done')");
  assert.ok(readyInCreate > warmupInCreate);
  const prepare = await readFile('agents/_lib/session/prepare.ts', 'utf8');
  assert.match(prepare, /mergeSseGenerators\(\[\s*iterateSandboxPrepEvents/);
  assert.match(prepare, /iterateAgentWarmupEvents/);
});

test('the prompt no longer tells the model to prepare the environment', async () => {
  const prompt = await readFile('agents/_lib/prompt.ts', 'utf8');
  assert.doesNotMatch(prompt, /ensure_project_scaffold/);
  assert.match(prompt, /load_makers_skill as the first tool/);
  assert.match(prompt, /host has already prepared an empty/);
});

test('frontend copy names each session prep stage in both languages', async () => {
  const i18n = await readFile('app/i18n.ts', 'utf8');
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
    readFile('app/features/workspace/workspace-api.ts', 'utf8'),
    readFile('app/features/workspace/hooks/use-live-turn.ts', 'utf8'),
    readFile('app/features/workspace/hooks/use-session-resume.ts', 'utf8'),
    readFile('app/features/workspace/workspace-screen.tsx', 'utf8'),
  ]);
  assert.match(api, /params\.set\('model'/);
  assert.match(api, /params\.set\('language'/);
  assert.match(api, /params\.set\('mode'/);
  assert.match(liveTurn, /mode: 'create'/);
  assert.match(liveTurn, /setSessionPreparing\(true\)/);
  assert.match(liveTurn, /setPrepStage\(event\.data\.stage\)/);
  assert.doesNotMatch(liveTurn, /sessionPrepToChatEvents/);
  assert.doesNotMatch(liveTurn, /name: 'environment'/);
  assert.doesNotMatch(liveTurn, /consumeEventStream\(resumeResponse, \(\) => \{\}\)/);
  assert.match(resume, /mode: 'restore'/);
  assert.match(resume, /setPrepStage\(event\.data\.stage\)/);
  assert.match(screen, /live\.sessionPreparing/);
  assert.match(screen, /SessionPrepLoading/);
  assert.match(screen, /t\.workspace\.preparing/);
  const loading = await readFile(
    'app/features/workspace/components/session-prep-loading.tsx',
    'utf8',
  );
  assert.match(loading, /role="progressbar"/);
  assert.match(loading, /usePrepProgress/);
  const css = await readFile('app/styles/workspace.css', 'utf8');
  assert.match(css, /\.session-prep-bar-fill/);
  assert.match(css, /@keyframes session-prep-sheen/);
  assert.match(resume, /if \(!restored\) \{[\s\S]*?setResumeChecked\(true\)/);
  assert.match(resume, /finally \{[\s\S]*setResumeChecked\(true\)/);
});
