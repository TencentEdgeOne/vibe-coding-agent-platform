import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

test('the model menu is an edge function, not an agent route', async () => {
  const route = await readFile('edge-functions/models.ts', 'utf8');
  const client = await readFile('app/features/workspace/workspace-api.ts', 'utf8');
  const screen = await readFile('app/features/workspace/workspace-screen.tsx', 'utf8');

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
  const client = await readFile('app/features/workspace/workspace-api.ts', 'utf8');

  assert.match(session, /onRequestGet/);
  assert.match(session, /createProjectResumeStreamResponse/);
  assert.doesNotMatch(session, /onRequestPost/);
  assert.match(prompt, /onRequestPost/);
  assert.match(prompt, /kind: 'prompt'/);
  assert.match(deploy, /onRequestPost/);
  assert.match(deploy, /kind: 'deploy'/);
  assert.match(tasks, /export async function\* iterateLiveChatTaskEvents/);
  assert.match(client, /fetch\('\/session',[\s\S]*?method: 'GET'/);
  assert.match(client, /fetch\('\/prompt',[\s\S]*?method: 'POST'/);
  assert.match(client, /fetch\('\/deploy',[\s\S]*?method: 'POST'/);
  assert.doesNotMatch(client, /fetch\('\/session-model'/);
  assert.doesNotMatch(client, /fetch\('\/chat'/);
  assert.doesNotMatch(client, /fetch\('\/resume'/);
  assert.doesNotMatch(client, /intent:/);
  assert.doesNotMatch(client, /resetProject/);
  assert.match(preview, /onRequestPost/);
  assert.match(preview, /runProjectResumePreviewPipeline/);
  assert.doesNotMatch(preview, /onRequestGet/);
  assert.match(client, /fetch\('\/preview',[\s\S]*?method: 'POST'/);
  await assert.rejects(access('agents/chat.ts'));
  await assert.rejects(access('agents/resume.ts'));
  await assert.rejects(access('agents/session-model.ts'));
  await assert.rejects(access('agents/session/index.ts'));
});

test('initial session restore is one progressive SSE request that can attach a live task', async () => {
  const route = await readFile('agents/session.ts', 'utf8');
  const pipeline = await readFile('agents/_lib/session/resume.ts', 'utf8');
  const client = await readFile('app/features/workspace/workspace-api.ts', 'utf8');

  assert.match(route, /onRequestGet/);
  assert.match(route, /createProjectResumeStreamResponse/);
  assert.match(pipeline, /type: 'resume_history'/);
  assert.match(pipeline, /type: 'resume_workspace'/);
  assert.match(pipeline, /iterateLiveChatTaskEvents/);
  assert.doesNotMatch(pipeline, /streamUrl: `\/chat\?runId=/);
  assert.match(client, /fetch\('\/session',[\s\S]*?method: 'GET'/);
});

test('the session tab reads the raw JSONL transcript and does not project it', async () => {
  const route = await readFile('agents/transcript.ts', 'utf8');
  const pipeline = await readFile('agents/_lib/session/transcript.ts', 'utf8');
  const client = await readFile('app/features/workspace/workspace-api.ts', 'utf8');
  const panel = await readFile('app/components/session-panel.tsx', 'utf8');
  const screen = await readFile('app/features/workspace/workspace-screen.tsx', 'utf8');

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
  assert.match(screen, /value="session"/);
});

test('file panel performs no automatic or hover prefetch', async () => {
  const source = await readFile('app/components/files-panel.tsx', 'utf8');
  assert.doesNotMatch(source, /prefetch/i);
  assert.doesNotMatch(source, /onMouseEnter/);
  assert.match(source, /fetch\(`\/file\?path=/);
});

test('an untouched new project does not persist an empty conversation', async () => {
  const screen = await readFile('app/features/workspace/workspace-screen.tsx', 'utf8');
  const start = screen.indexOf('function startNewProject()');
  const end = screen.indexOf('function handleNewProject()', start);
  const startBlock = screen.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(startBlock, /clearCachedConversationId\(\)/);
  assert.match(startBlock, /setConversationId\(null\)/);
  assert.doesNotMatch(startBlock, /cacheConversationId\(/);
  assert.doesNotMatch(startBlock, /createConversationId\(/);
});

test('stop sends makers-conversation-id like every other agent route', async () => {
  const client = await readFile('app/features/workspace/workspace-api.ts', 'utf8');
  const start = client.indexOf('export async function stopChatTask');
  const end = client.indexOf('export function fetchProjectArchive');
  const stopFn = client.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(stopFn, /headers: conversationHeaders\(conversationId\)/);
  assert.match(stopFn, /conversation_id: conversationId/);
  assert.doesNotMatch(stopFn, /AGENT_CONVERSATION_ID_REQUIRED/);
});

test('starting a new project does not wait for the old stop request', async () => {
  const screen = await readFile('app/features/workspace/workspace-screen.tsx', 'utf8');
  const client = await readFile('app/features/workspace/workspace-api.ts', 'utf8');
  const stopRoute = await readFile('agents/stop.ts', 'utf8');
  const start = screen.indexOf('function confirmNewProject()');
  const end = screen.indexOf('if (!resume.resumeChecked)', start);
  const confirmBlock = screen.slice(start, end);
  const abortIndex = stopRoute.indexOf('abortActiveRun');
  const snapshotIndex = stopRoute.indexOf('if (!discardProject)');

  assert.ok(start >= 0 && end > start);
  assert.match(confirmBlock, /void live\.stopCurrentTask\(\{ discardProject: true \}\)/);
  assert.match(confirmBlock, /startNewProject\(\)/);
  assert.doesNotMatch(confirmBlock, /await/);
  assert.match(client, /options\.discardProject \? \{ discardProject: true \} : \{\}/);
  assert.ok(abortIndex >= 0 && snapshotIndex > abortIndex);
  assert.match(stopRoute, /if \(!discardProject\) \{[\s\S]*?persistProjectSnapshot/);
});

test('workspace persistence uses the sandbox SDK and Blob state.json, not context.store', async () => {
  const helpers = await readFile('agents/_lib/turn/checkpoint.ts', 'utf8');
  const persistence = await readFile('agents/_lib/project/persistence.ts', 'utf8');
  const store = await readFile('agents/_lib/session/store.ts', 'utf8');

  assert.match(helpers, /context\.sandbox\.persist\(\{ path: state\.appDir \}\)/);
  assert.match(persistence, /context\.sandbox\.restore\(\{ path: state\.appDir \}\)/);
  assert.doesNotMatch(persistence, /getLegacyProjectSnapshot/);
  assert.doesNotMatch(persistence, /clearLegacyProjectSnapshot/);
  assert.match(store, /getStore\(\{ name: BLOB_STORE_NAME, consistency: 'strong' \}\)/);
  assert.doesNotMatch(store, /context\.store/);
  assert.doesNotMatch(store, /saveProjectSnapshot/);
  assert.doesNotMatch(store, /listConversations/);
  assert.doesNotMatch(store, /deleteConversation/);
});
