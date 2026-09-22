import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';
import { workspaceSnapshotFromState } from '../agents/_lib/project/snapshot.ts';
import {
  FILES_PANEL,
  LIVE_TURN,
  NEW_PROJECT,
  PREVIEW_SURFACE,
  SESSION_PANEL,
  WORKSPACE,
  surface,
} from './helpers/source.ts';

test('the model menu is an edge function, not an agent route', async () => {
  const route = await readFile('edge-functions/models.ts', 'utf8');
  const client = await surface('app/features/workspace/workspace-api.ts');
  const screen = await surface(WORKSPACE);

  assert.match(route, /onRequestGet/);
  assert.match(route, /resolveModelCatalog/);
  assert.match(client, /fetch\('\/models'/);
  assert.doesNotMatch(client, /function fetchModelCatalog\(conversationId/);
  assert.match(screen, /fetchModelCatalog\(controller\.signal\)/);
  assert.doesNotMatch(screen, /fetchModelCatalog\(routingId/);
  await assert.rejects(access('agents/models.ts'));
});

test('session is GET restore; turns go through /prompt and /deploy', async () => {
  const session = await readFile('agents/session.ts', 'utf8');
  const prompt = await readFile('agents/prompt.ts', 'utf8');
  const deploy = await readFile('agents/deploy.ts', 'utf8');
  const preview = await readFile('agents/preview.ts', 'utf8');
  const tasks = await readFile('agents/_lib/session/task.ts', 'utf8');
  const client = await surface('app/features/workspace/workspace-api.ts');

  assert.match(session, /onRequestGet/);
  assert.match(session, /createProjectResumeStreamResponse/);
  assert.doesNotMatch(session, /onRequestPost/);
  assert.match(prompt, /onRequestPost/);
  assert.match(prompt, /kind: 'prompt'/);
  assert.match(deploy, /onRequestPost/);
  assert.match(deploy, /kind: 'deploy'/);
  assert.match(tasks, /export async function\* iterateLiveChatTaskEvents/);
  assert.match(client, /fetch\('\/session'/);
  assert.match(client, /fetch\('\/prompt',[\s\S]*?method: 'POST'/);
  assert.match(client, /fetch\('\/deploy',[\s\S]*?method: 'POST'/);
  assert.doesNotMatch(client, /fetch\('\/session-model'/);
  assert.doesNotMatch(client, /fetch\('\/chat'/);
  assert.doesNotMatch(client, /fetch\('\/resume'/);
  assert.doesNotMatch(client, /intent:/);
  assert.doesNotMatch(client, /resetProject/);
  assert.match(preview, /onRequestPost/);
  assert.match(preview, /runProjectResumePreviewPipeline/);
  assert.match(preview, /onRequestGet/);
  assert.match(preview, /runPreviewStatusPipeline/);
  assert.match(client, /fetch\('\/preview',[\s\S]*?method: 'POST'/);
  await assert.rejects(access('agents/chat.ts'));
  await assert.rejects(access('agents/resume.ts'));
  await assert.rejects(access('agents/session-model.ts'));
  await assert.rejects(access('agents/session/index.ts'));
});

test('initial session restore is one progressive SSE request that can attach a live task', async () => {
  const route = await readFile('agents/session.ts', 'utf8');
  const pipeline = await readFile('agents/_lib/session/resume.ts', 'utf8');
  const client = await surface('app/features/workspace/workspace-api.ts');

  assert.match(route, /onRequestGet/);
  assert.match(route, /createProjectResumeStreamResponse/);
  assert.match(pipeline, /type: 'resume_history'/);
  assert.doesNotMatch(pipeline, /type: 'resume_workspace'/);
  assert.doesNotMatch(pipeline, /sessionPrepSse/);
  assert.match(pipeline, /iterateLiveChatTaskEvents/);
  assert.doesNotMatch(pipeline, /streamUrl: `\/chat\?runId=/);
  assert.match(client, /fetch\('\/session'/);
});

test('the session tab reads the raw JSONL transcript and does not project it', async () => {
  const route = await readFile('agents/transcript.ts', 'utf8');
  const pipeline = await readFile('agents/_lib/session/transcript.ts', 'utf8');
  const client = await surface('app/features/workspace/workspace-api.ts');
  const panel = await surface(SESSION_PANEL);
  const screen = await surface(WORKSPACE);

  assert.match(route, /onRequestGet/);
  assert.match(route, /createTranscriptStreamResponse/);
  assert.match(route, /getLiveQuery/);
  assert.doesNotMatch(route, /onRequestPost/);
  assert.match(pipeline, /export async function loadTranscriptJsonl/);
  assert.match(pipeline, /export async function createTranscriptStreamResponse/);
  assert.match(pipeline, /type: 'transcript'/);
  assert.match(client, /fetch\('\/transcript',[\s\S]*?method: 'GET'/);
  assert.match(panel, /openTranscriptStream\(/);
  assert.match(panel, /consumeEventStream/);
  assert.match(panel, /\{state\.jsonl\}/);
  assert.doesNotMatch(panel, /setInterval|fetchTranscript/);
  assert.doesNotMatch(panel, /projectTranscript|JSON\.stringify\(|JSON\.parse\(/);
  assert.match(screen, /SHOW_SESSION_TAB = process\.env\.NODE_ENV === 'development'/);
  assert.match(screen, /SHOW_SESSION_TAB && \([\s\S]*value="session"/);
  assert.match(screen, /SHOW_SESSION_TAB && workspace\.sandboxTab === 'session'/);
});

test('file panel performs no automatic or hover prefetch', async () => {
  const source = await surface(FILES_PANEL);
  assert.doesNotMatch(source, /prefetch/i);
  assert.doesNotMatch(source, /onMouseEnter/);
  assert.match(source, /fetch\(`\/file\?path=/);
});

test('an untouched new project does not persist an empty conversation', async () => {
  const screen = await surface(NEW_PROJECT);
  const start = screen.indexOf('function startNewProject()');
  const end = screen.indexOf('function handleNewProject()', start);
  const startBlock = screen.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(startBlock, /clearCachedConversationId\(\)/);
  assert.match(startBlock, /setConversationId\(null\)/);
  assert.doesNotMatch(startBlock, /cacheConversationId\(/);
  assert.doesNotMatch(startBlock, /createConversationId\(/);
});

// Sticky routing pins makers-conversation-id to one agent instance. /stop is the
// only route that must omit it: abortActiveRun has to reach a stuck instance,
// and the header would pin the request to that same instance.
test('/stop is the only agent route that omits makers-conversation-id', async () => {
  const client = await surface('app/features/workspace/workspace-api.ts');
  const start = client.indexOf('export async function stopChatTask');
  const end = client.indexOf('export function fetchProjectArchive');
  const stopFn = client.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(stopFn, /No makers-conversation-id/);
  assert.doesNotMatch(stopFn, /conversationHeaders\(/);
  assert.doesNotMatch(stopFn, /'makers-conversation-id'/);
  assert.match(stopFn, /conversation_id: conversationId/);
  assert.match(stopFn, /'content-type': 'application\/json'/);
  const others = client.replace(stopFn, '');
  assert.match(others, /conversationHeaders\(/);
  assert.match(others, /'makers-conversation-id': conversationId/);
});

test('starting a new project does not wait for the old stop request', async () => {
  const screen = await surface(NEW_PROJECT);
  const client = await surface('app/features/workspace/workspace-api.ts');
  const stopRoute = await readFile('agents/stop.ts', 'utf8');
  const abortIndex = stopRoute.indexOf('abortActiveRun');
  const snapshotIndex = stopRoute.indexOf('if (!discardProject &&');

  assert.match(screen, /void live\.stopCurrentTask\(\{ discardProject: true \}\)/);
  assert.match(screen, /startNewProject\(\)/);
  assert.doesNotMatch(screen, /await live\.stopCurrentTask/);
  assert.match(client, /options\.discardProject \? \{ discardProject: true \} : \{\}/);
  assert.ok(abortIndex >= 0 && snapshotIndex > abortIndex);
  assert.match(stopRoute, /if \(!discardProject && sandboxWasActivated\(conversationId\)\) \{[\s\S]*?persistProjectSnapshot/);
});

test('workspace persistence uses the sandbox SDK and Blob state.json, not context.store', async () => {
  const helpers = await readFile('agents/_lib/turn/checkpoint.ts', 'utf8');
  const persistence = await readFile('agents/_lib/project/persistence.ts', 'utf8');
  const store = await readFile('agents/_lib/session/store.ts', 'utf8');

  assert.match(helpers, /requireSandbox\(context\)\.persist\?\.\(\{ path: state\.appDir \}\)/);
  assert.match(persistence, /requireSandbox\(context\)\.restore\?\.\(\{ path: state\.appDir \}\)/);
  assert.doesNotMatch(persistence, /getLegacyProjectSnapshot/);
  assert.doesNotMatch(persistence, /clearLegacyProjectSnapshot/);
  assert.match(store, /BLOB_STORE_NAME/);
  assert.match(store, /consistency: 'strong'/);
  assert.doesNotMatch(store, /context\.store/);
  assert.doesNotMatch(store, /saveProjectSnapshot/);
  assert.doesNotMatch(store, /listConversations/);
  assert.doesNotMatch(store, /deleteConversation/);
});

test('workspace snapshot and preview status are pullable without the chat stream', async () => {
  const workspace = await readFile('agents/workspace.ts', 'utf8');
  const preview = await readFile('agents/preview.ts', 'utf8');
  const client = await surface('app/features/workspace/workspace-api.ts');
  const previewSurface = await surface(PREVIEW_SURFACE);

  assert.match(workspace, /onRequestGet/);
  assert.match(workspace, /runWorkspaceSnapshotPipeline/);
  assert.match(preview, /onRequestGet/);
  assert.match(client, /fetch\('\/workspace'/);
  assert.match(client, /fetch\(`\/file\?paths=/);
  assert.match(
    previewSurface,
    /void options\.refreshWorkspace\?\.\(id, \{ includePreview: false \}\)/,
  );
});

test('a finished turn streams a state-only workspace snapshot instead of GET /workspace', async () => {
  const [
    protocol,
    result,
    chat,
    deploy,
    snapshot,
    live,
  ] = await Promise.all([
    readFile('shared/protocol.ts', 'utf8'),
    readFile('agents/_lib/turn/result.ts', 'utf8'),
    readFile('agents/_lib/turn/chat.ts', 'utf8'),
    readFile('agents/_lib/turn/deploy.ts', 'utf8'),
    readFile('agents/_lib/project/snapshot.ts', 'utf8'),
    surface(LIVE_TURN),
  ]);

  assert.match(protocol, /type: 'workspace'; data\?: WorkspaceSnapshot/);
  assert.match(result, /type: 'workspace'/);
  assert.match(snapshot, /export function workspaceSnapshotFromState/);
  assert.match(chat, /workspaceSnapshotFromState\(conversationId, state\)/);
  assert.doesNotMatch(chat, /fileTreePush|flushedItems|rememberTree/);
  assert.match(deploy, /workspaceSnapshotFromState\(/);
  assert.match(live, /event\.type === 'workspace' && event\.data/);
  assert.match(live, /snapshot\.applySnapshot\(event\.data\)/);

  const applyResponse = live.slice(
    live.indexOf('const applyResponse'),
    live.indexOf('const handleStreamEvent'),
  );
  assert.doesNotMatch(applyResponse, /snapshot\.refresh/);

  const applyGateway = live.slice(live.indexOf('async function applyGateway'));
  assert.doesNotMatch(applyGateway, /snapshot\.refresh/);
});

test('workspaceSnapshotFromState reuses a listing and skips files when none was passed', () => {
  const withFiles = workspaceSnapshotFromState('c1', {
    created: true,
    sessionDir: 'projects/c1',
    appDir: 'projects/c1/app',
    previewUrl: 'https://preview.example',
    previewKind: 'sandbox',
    lastBuild: { status: 'failed', stderr: 'boom' },
    deployment: { status: 'success', startedAt: 1, url: 'https://live.example' },
  }, [{ path: 'index.html', name: 'index.html', type: 'file', depth: 0 }]);

  assert.equal(withFiles.ok, true);
  assert.equal(withFiles.conversation_id, 'c1');
  assert.equal(withFiles.files?.items.length, 1);
  assert.equal(withFiles.preview?.url, 'https://preview.example');
  assert.equal(withFiles.download?.url, '/download');
  assert.equal(withFiles.build?.status, 'failed');
  assert.equal(withFiles.deployment?.url, 'https://live.example');

  const metaOnly = workspaceSnapshotFromState('c1', {
    created: true,
    sessionDir: 'projects/c1',
    appDir: 'projects/c1/app',
    lastBuild: { status: 'success' },
  });
  assert.equal(metaOnly.files, undefined);
  assert.equal(metaOnly.download, undefined);
  assert.equal(metaOnly.build?.status, 'success');
});
