import assert from 'node:assert/strict';
import test from 'node:test';
import { createSSEResponse, sseEvent } from '../agents/_lib/runtime/sse.ts';
import type { AgentContext, BlobStoreLike } from '../agents/_lib/runtime/context.ts';
import { createMemoryBlobStore, patchConversationRecord } from '../agents/_lib/session/store.ts';
import { createProjectResumeStreamResponse } from '../agents/_lib/session/resume.ts';
import { consumeEventStream } from '../app/features/workspace/sse.ts';

test('SSE responses frame events and terminate with DONE', async () => {
  const response = createSSEResponse(async function* () {
    yield sseEvent({ type: 'ping', ts: 1 });
  });
  const body = await response.text();

  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-cache, no-transform');
  assert.match(body, /^data: \{"type":"ping","ts":1\}\n\n/);
  assert.match(body, /data: \[DONE\]\n\n$/);
});

type StreamEvent = {
  type: string;
  data?: { stage?: string; status?: string; mode?: string };
};

function streamLabel(event: StreamEvent) {
  if (event.type === 'session_prep') return `${event.data?.stage}:${event.data?.status}`;
  return event.type;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sessionContext(options: {
  conversationId: string;
  mode: 'create' | 'restore';
  model?: string;
  language?: string;
  delaySetJSON?: number;
}) {
  const inner = createMemoryBlobStore();
  const stats = { setJSONs: 0 };
  const blobStore: BlobStoreLike = {
    set: (key, value, extra) => inner.set(key, value, extra),
    delete: (key) => inner.delete(key),
    list: (extra) => inner.list(extra),
    get: (key, extra) => inner.get(key, extra),
    async setJSON(key, value, extra) {
      stats.setJSONs += 1;
      if (options.delaySetJSON) await delay(options.delaySetJSON);
      return inner.setJSON(key, value, extra);
    },
  };
  const context = {
    conversation_id: options.conversationId,
    blobStore,
    request: {
      query: {
        mode: options.mode,
        ...(options.model ? { model: options.model } : {}),
        ...(options.language ? { language: options.language } : {}),
      },
    },
    sandbox: {
      extendTimeout: async () => {},
      restore: async () => ({ restored: false }),
      files: {
        makeDir: async () => {},
        exists: async () => false,
      },
      commands: {
        run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      },
    },
  } as unknown as AgentContext;
  return { context, blobStore, stats };
}

async function collectSessionEvents(context: AgentContext) {
  const response = await createProjectResumeStreamResponse(context);
  const events: StreamEvent[] = [];
  await consumeEventStream<StreamEvent>(response, (event) => {
    if (event.type !== 'ping') events.push(event);
  });
  return events;
}

test('restore session SSE skips an empty conversation patch and interleaves history with warmup', async () => {
  const fixture = sessionContext({
    conversationId: 'cid-restore-stream',
    mode: 'restore',
  });
  const events = await collectSessionEvents(fixture.context);
  const labels = events.map(streamLabel);

  assert.equal(fixture.stats.setJSONs, 0);
  assert.deepEqual(labels.slice(0, 2), ['conversation:running', 'conversation:done']);
  const ready = labels.indexOf('ready:done');
  assert.ok(ready >= 0, 'restore must emit ready');
  assert.ok(labels.includes('resume_history'));
  assert.ok(labels.indexOf('resume_history') < ready);
  assert.ok(labels.indexOf('sandbox:running') < ready);
  assert.ok(labels.indexOf('agent:running') < ready);
  assert.ok(labels.indexOf('resume_history') > labels.indexOf('conversation:done'));
  assert.ok(
    labels.indexOf('sandbox:running') > labels.indexOf('conversation:done'),
    'restore still finishes conversation before the warmup merge',
  );
  assert.ok(!labels.includes('workspace:running'));
  assert.ok(!labels.includes('resume_workspace'));
});

test('restore session SSE emits ready before workspace events', async () => {
  const fixture = sessionContext({
    conversationId: 'cid-restore-ready',
    mode: 'restore',
  });
  const current = await patchConversationRecord(fixture.context, 'cid-restore-ready', {});
  await patchConversationRecord(fixture.context, 'cid-restore-ready', {
    projectState: { ...current.projectState, created: true },
  });

  const events = await collectSessionEvents(fixture.context);
  const labels = events.map(streamLabel);
  const ready = labels.indexOf('ready:done');
  const workspace = labels.findIndex((label) => (
    label === 'workspace:running' || label === 'resume_workspace'
  ));

  assert.ok(ready >= 0, 'restore must emit ready');
  assert.ok(workspace >= 0, 'a created project must resume the workspace');
  assert.ok(ready < workspace, 'ready must precede workspace and preview events');
  assert.ok(labels.includes('resume_history'));
  assert.ok(labels.indexOf('resume_history') < ready);
  const preview = labels.indexOf('preview:running');
  if (preview >= 0) assert.ok(ready < preview);
});

test('create session SSE runs conversation with sandbox warmup and still starts in order', async () => {
  const fixture = sessionContext({
    conversationId: 'cid-create-stream',
    mode: 'create',
    model: 'kimi-k2.6',
    language: 'en',
    delaySetJSON: 40,
  });
  const events = await collectSessionEvents(fixture.context);
  const labels = events.map(streamLabel);

  const conversationRunning = labels.indexOf('conversation:running');
  const sandboxRunning = labels.indexOf('sandbox:running');
  const agentRunning = labels.indexOf('agent:running');
  assert.ok(conversationRunning >= 0 && sandboxRunning >= 0 && agentRunning >= 0);
  assert.ok(conversationRunning < sandboxRunning);
  assert.ok(sandboxRunning < agentRunning);
  assert.ok(
    labels.indexOf('sandbox:done') < labels.indexOf('conversation:done'),
    'conversation:done is no longer a gate in front of sandbox:done',
  );
  assert.equal(labels.at(-1), 'ready:done');
  assert.ok(!labels.includes('resume_history'));
  assert.ok(!labels.includes('workspace:running'));
});
