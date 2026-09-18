import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { getMakersModelsDocsUrl } from '../app/lib/conversation.ts';
import { TRANSLATIONS } from '../app/i18n.ts';
import {
  extractApiKeyFromUserText,
  maskApiKey,
  resolveGatewayUserTurn,
} from '../shared/gateway-secret.ts';
import {
  AI_GATEWAY_ORIGIN,
  DEFAULT_AI_GATEWAY_BASE_URL,
  GATEWAY_CREDENTIALS_PAUSE_MESSAGE,
  applyUserGatewayDecision,
  askUserForGatewayCredentials,
  declaredGatewayKeys,
  envAssignmentValue,
  gatewayBaseUrlForAgentFramework,
  pauseForGatewayCredentialsIfNeeded,
  projectDeclaresGatewayKeys,
  readProjectGatewayEnv,
  sandboxGatewayKeyIsSet,
  shouldPauseForGatewayCredentials,
  writeSuggestsAiGatewayProject,
} from '../agents/_lib/project/gateway.ts';
import { buildLoadMakersSkillTool } from '../agents/_lib/tools/makers-skills.ts';
import { buildWriteProjectFileTool } from '../agents/_lib/tools/project-tools.ts';
import { projectState } from './helpers/fixtures.ts';

function sandboxFiles(initial: Array<[string, string]>) {
  const files = new Map<string, string>(initial);
  return {
    files,
    context: {
      sandbox: {
        files: {
          read: async (target: string) => {
            const content = files.get(target);
            if (content == null) throw new Error('File does not exist.');
            return content;
          },
          write: async (target: string, content: string) => {
            files.set(target, content);
          },
          exists: async (target: string) => files.has(target) || [...files.keys()].some((path) => (
            path === target || path.startsWith(`${target}/`)
          )),
          makeDir: async () => undefined,
        },
        commands: {
          run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        },
      },
    },
  };
}

test('declared gateway keys come from .env.example lines', () => {
  assert.deepEqual(
    declaredGatewayKeys('APP_TITLE=Demo\nAI_GATEWAY_API_KEY=\nAI_GATEWAY_BASE_URL=\n'),
    ['AI_GATEWAY_API_KEY', 'AI_GATEWAY_BASE_URL'],
  );
  assert.deepEqual(declaredGatewayKeys('APP_TITLE=Demo\n'), []);
});

test('env assignment values ignore quotes and blanks', () => {
  assert.equal(envAssignmentValue('AI_GATEWAY_API_KEY=\n', 'AI_GATEWAY_API_KEY'), '');
  assert.equal(envAssignmentValue('AI_GATEWAY_API_KEY="sk-user"\n', 'AI_GATEWAY_API_KEY'), 'sk-user');
  assert.equal(envAssignmentValue("AI_GATEWAY_API_KEY='sk-user'\n", 'AI_GATEWAY_API_KEY'), 'sk-user');
});

test('maskApiKey keeps a short tail and never returns the raw key', () => {
  assert.equal(maskApiKey('abcd'), '••••');
  assert.equal(maskApiKey('sk-abcdefghijklmnopqrstuvwxyz'), 'sk-••••••••wxyz');
  assert.doesNotMatch(maskApiKey('sk-user-secret-key-1234'), /secret/);
});

test('a chat sentence can carry a key the same way the input card does', () => {
  const spoken = extractApiKeyFromUserText('我的apikey是 abc，配置好并重新预览');
  assert.equal(spoken?.apiKey, 'abc');
  assert.equal(spoken?.maskedText, '我的apikey是 •••，配置好并重新预览');
  assert.doesNotMatch(spoken?.maskedText || '', /\babc\b/);

  const labeled = extractApiKeyFromUserText('API Key: sk-abcdefghijklmnopqrstuvwxyz then preview');
  assert.equal(labeled?.apiKey, 'sk-abcdefghijklmnopqrstuvwxyz');
  assert.match(labeled?.maskedText || '', /sk-••••••••wxyz/);

  const assigned = extractApiKeyFromUserText('AI_GATEWAY_API_KEY=sk-user-secret-key-1234');
  assert.equal(assigned?.apiKey, 'sk-user-secret-key-1234');

  const pasted = extractApiKeyFromUserText('please use sk-ant-abcdefghijklmnop and preview');
  assert.equal(pasted?.apiKey, 'sk-ant-abcdefghijklmnop');

  assert.equal(extractApiKeyFromUserText('帮我做一个带 API Key 输入框的页面'), null);
  assert.equal(extractApiKeyFromUserText('API Key: sk-••••••••wxyz'), null);
  assert.equal(extractApiKeyFromUserText('跳过'), null);

  const resolved = resolveGatewayUserTurn('我的apikey是 abc，配置好并重新预览');
  assert.equal(resolved.apiKey, 'abc');
  assert.equal(resolved.message, '我的apikey是 •••，配置好并重新预览');
});

test('a provided key is written to .env and a skip is not', async () => {
  const { files, context } = sandboxFiles([
    ['projects/demo/app/.env.example', 'AI_GATEWAY_API_KEY=\nAI_GATEWAY_BASE_URL=\n'],
    ['projects/demo/app/.env', 'APP_TITLE=Demo\n'],
  ]);
  const state = projectState();

  assert.deepEqual(
    await applyUserGatewayDecision(context, state, 'conv-1', { apiKey: 'sk-user' }),
    {
      AI_GATEWAY_API_KEY: 'sk-user',
      AI_GATEWAY_BASE_URL: DEFAULT_AI_GATEWAY_BASE_URL,
    },
  );
  assert.equal(
    files.get('projects/demo/app/.env'),
    `APP_TITLE=Demo\nAI_GATEWAY_API_KEY=sk-user\nAI_GATEWAY_BASE_URL=${DEFAULT_AI_GATEWAY_BASE_URL}\n`,
  );
  assert.equal(state.gatewayPromptPending, false);
  assert.equal(state.gatewaySkipped, false);
  assert.deepEqual(
    await readProjectGatewayEnv(context, projectState()),
    {
      AI_GATEWAY_API_KEY: 'sk-user',
      AI_GATEWAY_BASE_URL: DEFAULT_AI_GATEWAY_BASE_URL,
    },
  );

  const skipped = projectState();
  assert.deepEqual(
    await applyUserGatewayDecision(context, skipped, 'conv-2', { skip: true }),
    {},
  );
  assert.equal(skipped.gatewaySkipped, true);
  assert.equal(
    files.get('projects/demo/app/.env.example'),
    'AI_GATEWAY_API_KEY=\nAI_GATEWAY_BASE_URL=\n',
  );
});

test('a claude-agent-sdk project gets the origin without /v1', async () => {
  const { files, context } = sandboxFiles([
    ['projects/demo/app/.env.example', 'AI_GATEWAY_API_KEY=\nAI_GATEWAY_BASE_URL=\n'],
    ['projects/demo/app/edgeone.json', '{"agents":{"framework":"claude-agent-sdk"}}'],
  ]);
  const state = projectState();

  assert.equal(gatewayBaseUrlForAgentFramework('claude-agent-sdk'), AI_GATEWAY_ORIGIN);
  assert.equal(gatewayBaseUrlForAgentFramework('deepagents'), DEFAULT_AI_GATEWAY_BASE_URL);
  assert.equal(gatewayBaseUrlForAgentFramework(undefined), DEFAULT_AI_GATEWAY_BASE_URL);

  assert.deepEqual(
    await applyUserGatewayDecision(context, state, 'conv-claude', { apiKey: 'sk-user' }),
    {
      AI_GATEWAY_API_KEY: 'sk-user',
      AI_GATEWAY_BASE_URL: AI_GATEWAY_ORIGIN,
    },
  );
  assert.equal(
    files.get('projects/demo/app/.env'),
    `AI_GATEWAY_API_KEY=sk-user\nAI_GATEWAY_BASE_URL=${AI_GATEWAY_ORIGIN}\n`,
  );
});

test('an AI project without a key is offered the card and dest is not blocked', async () => {
  const { context } = sandboxFiles([
    ['projects/demo/app/.env.example', 'AI_GATEWAY_API_KEY=\nAI_GATEWAY_BASE_URL=\n'],
  ]);
  const events: Array<Record<string, unknown>> = [];
  const state = projectState();

  assert.equal(await projectDeclaresGatewayKeys(context, state), true);
  assert.equal(await sandboxGatewayKeyIsSet(context, state), false);
  assert.equal(await shouldPauseForGatewayCredentials(context, state), true);

  const pause = await pauseForGatewayCredentialsIfNeeded(context, state, {
    conversationId: 'conv-pause',
    send: (event) => { events.push(event); },
  });
  assert.equal(pause, GATEWAY_CREDENTIALS_PAUSE_MESSAGE);
  assert.equal(events[0]?.type, 'gateway_credentials');
  assert.equal((events[0]?.data as { status?: string })?.status, 'needed');
  assert.equal(state.gatewayPromptPending, true);

  state.gatewaySkipped = true;
  assert.equal(await shouldPauseForGatewayCredentials(context, state), false);
  assert.equal(await pauseForGatewayCredentialsIfNeeded(context, state), '');
});

test('the coding agent has no request_gateway_credentials tool', async () => {
  const [assemble, gateway, prompt, chat] = await Promise.all([
    readFile('agents/_lib/tools/assemble.ts', 'utf8'),
    readFile('agents/_lib/project/gateway.ts', 'utf8'),
    readFile('agents/_lib/prompt.ts', 'utf8'),
    readFile('agents/_lib/turn/chat.ts', 'utf8'),
  ]);
  assert.doesNotMatch(assemble, /request_gateway_credentials/);
  assert.doesNotMatch(assemble, /buildRequestGatewayCredentialsTool/);
  assert.doesNotMatch(gateway, /buildRequestGatewayCredentialsTool/);
  assert.doesNotMatch(gateway, /defineClaudeTool/);
  assert.doesNotMatch(prompt, /request_gateway_credentials/);
  assert.doesNotMatch(chat, /isRequestGatewayCredentialsTool/);
  assert.doesNotMatch(chat, /hiddenToolUseIds/);
});

test('loading makers-agents offers the gateway card without ending the turn', async () => {
  const events: Array<Record<string, unknown>> = [];
  const state = projectState();
  const tool = buildLoadMakersSkillTool({
    context: { sandbox: { files: {} } } as never,
    state,
    conversationId: 'conv-skill',
    send: (event) => { events.push(event); },
  });

  const result = await tool.handler({ skill: 'makers-agents' }, {});
  const text = result.content?.[0] && 'text' in result.content[0]
    ? String(result.content[0].text)
    : '';
  assert.match(text, /makers-agents|SKILL/);
  assert.equal(events[0]?.type, 'gateway_credentials');
  assert.equal((events[0]?.data as { status?: string })?.status, 'needed');
  assert.equal(state.gatewayPromptPending, true);
});

test('writing agents/ or a gateway .env.example offers the card immediately', async () => {
  const { context } = sandboxFiles([
    ['projects/demo/app/package.json', JSON.stringify({ dependencies: { '@openai/agents': 'latest' } })],
  ]);
  const events: Array<Record<string, unknown>> = [];
  const state = projectState();
  const tool = buildWriteProjectFileTool(
    context,
    state,
    undefined,
    {
      conversationId: 'conv-write',
      send: (event) => { events.push(event); },
    },
  );

  assert.equal(writeSuggestsAiGatewayProject('agents/chat.ts', 'export {}'), true);
  assert.equal(writeSuggestsAiGatewayProject('.env.example', 'AI_GATEWAY_API_KEY=\n'), true);
  assert.equal(writeSuggestsAiGatewayProject('src/App.tsx', 'export default () => null;\n'), false);

  const result = await tool.handler({
    path: 'agents/chat.ts',
    content: 'export async function onRequest() { return new Response("ok"); }\n',
  }, {});
  assert.equal(result.isError, undefined);
  assert.equal(events[0]?.type, 'gateway_credentials');
  assert.equal(state.gatewayPromptPending, true);

  const later = sandboxFiles([
    ['projects/demo/app/src/App.tsx', 'export default () => null;\n'],
  ]);
  const quietEvents: Array<Record<string, unknown>> = [];
  const quiet = buildWriteProjectFileTool(
    later.context,
    projectState(),
    undefined,
    { send: (event) => { quietEvents.push(event); } },
  );
  await quiet.handler({ path: 'src/App.tsx', content: 'export default () => null;\n' }, {});
  assert.equal(quietEvents.length, 0);
});

test('the conversation card is visible while generating and submits without a chat turn', async () => {
  const [conversation, screen, live, api, promptRoute, apply] = await Promise.all([
    readFile('app/components/agent-conversation.tsx', 'utf8'),
    readFile('app/features/workspace/workspace-screen.tsx', 'utf8'),
    readFile('app/features/workspace/hooks/use-live-turn.ts', 'utf8'),
    readFile('app/features/workspace/workspace-api.ts', 'utf8'),
    readFile('agents/prompt.ts', 'utf8'),
    readFile('agents/_lib/session/gateway-apply.ts', 'utf8'),
  ]);
  const card = conversation.slice(
    conversation.indexOf('className="gateway-prompt"'),
    conversation.indexOf('className="gateway-prompt-actions"'),
  );

  assert.equal(TRANSLATIONS.zh.workspace.gatewayPromptTitle, '启用 AI 对话');
  assert.equal(
    TRANSLATIONS.zh.workspace.gatewayPromptDescription,
    '添加 Models API 密钥，即可在预览中试用对话。密钥只保存在此项目中，无需登录。',
  );
  assert.equal(TRANSLATIONS.zh.workspace.gatewayPromptSkip, '稍后');
  assert.equal(TRANSLATIONS.zh.workspace.gatewayPromptContinue, '添加');
  assert.equal(TRANSLATIONS.zh.workspace.gatewayPromptDocs, '如何获取密钥');
  assert.equal(TRANSLATIONS.en.workspace.gatewayPromptDocs, 'How to get a key');
  assert.equal(
    getMakersModelsDocsUrl('edgeone.dev'),
    'https://pages.edgeone.ai/document/models',
  );
  assert.equal(
    getMakersModelsDocsUrl('edgeone.cool'),
    'https://makers.edgeone.link/document/models',
  );
  assert.equal(
    getMakersModelsDocsUrl(''),
    'https://makers.edgeone.link/document/models',
  );
  assert.match(screen, /docsUrl: makersModelsDocsUrl/);
  assert.match(screen, /setMakersModelsDocsUrl\(getMakersModelsDocsUrl\(domain\)\)/);
  assert.match(card, /gatewayPrompt\.title/);
  assert.match(card, /gatewayPrompt\.description/);
  assert.match(card, /href=\{gatewayPrompt\.docsUrl\}/);
  assert.match(card, /gatewayPrompt\.apiKey/);
  assert.doesNotMatch(card, /gatewayPrompt\.baseUrl/);
  assert.equal(DEFAULT_AI_GATEWAY_BASE_URL, 'https://ai-gateway.edgeone.link/v1');
  assert.equal(AI_GATEWAY_ORIGIN, 'https://ai-gateway.edgeone.link');
  assert.match(screen, /gatewayPrompt=\{workspace\.gatewayNeeded \? \{/);
  assert.doesNotMatch(screen, /gatewayNeeded && !live\.loading/);
  assert.match(screen, /live\.applyGateway\(\{ apiKey \}\)/);
  assert.match(screen, /live\.applyGateway\(\{ skip: true \}\)/);
  assert.doesNotMatch(screen, /sendMessage\(`\$\{t\.workspace\.gatewayPromptApiKey\}/);
  assert.doesNotMatch(screen, /sendMessage\(t\.workspace\.gatewayPromptSkip/);
  assert.match(conversation, /className="gateway-prompt-chip"/);
  assert.match(live, /async function applyGateway/);
  assert.match(live, /if \(!trimmed \|\| loading\) return/);
  assert.match(live, /extractApiKeyFromUserText\(trimmed\)/);
  assert.match(live, /inboundApiKey \? \{ apiKey: inboundApiKey \}/);
  assert.match(api, /function applyGatewayDecision/);
  const applyClient = api.slice(
    api.indexOf('export function applyGatewayDecision'),
    api.indexOf('export function startPromptTurn'),
  );
  assert.doesNotMatch(applyClient, /message:/);
  const promptTurn = api.slice(
    api.indexOf('export function startPromptTurn'),
    api.indexOf('export function startDeployTurn'),
  );
  assert.doesNotMatch(promptTurn, /gatewaySkip/);
  assert.match(promptRoute, /!message && \(apiKey \|\| gatewaySkip\)/);
  assert.match(promptRoute, /applyGatewayDecisionAndRespond/);
  assert.doesNotMatch(apply, /createChatTask/);
  assert.match(apply, /getLiveWorkspace/);
  const finalize = live.slice(
    live.indexOf('const finalizeAssistant'),
    live.indexOf('const applyResponse'),
  );
  assert.doesNotMatch(finalize, /setGatewayNeeded\(false\)/);
  assert.match(live, /event\.type === 'gateway_credentials'/);
  assert.match(live, /workspace\.setGatewayNeeded\(true\)/);
});

test('a missing key no longer stops the turn or preview', async () => {
  const [chat, prompt, commands] = await Promise.all([
    readFile('agents/_lib/turn/chat.ts', 'utf8'),
    readFile('agents/_lib/prompt.ts', 'utf8'),
    readFile('agents/_lib/tools/commands-wrap.ts', 'utf8'),
  ]);

  assert.doesNotMatch(chat, /if \(state\.gatewayPromptPending\)/);
  assert.doesNotMatch(chat, /GATEWAY_CREDENTIALS_USER_REPLY/);
  assert.match(chat, /bindLiveWorkspace/);
  assert.match(prompt, /Do not stop this turn/);
  assert.doesNotMatch(prompt, /do not say the preview is ready/);
  assert.doesNotMatch(prompt, /stop this turn: do not start a preview/);
  assert.doesNotMatch(prompt, /request_gateway_credentials/);
  assert.match(prompt, /A missing key is not a preview or deploy failure/);
  assert.match(commands, /isDeploymentCommand/);
  assert.match(commands, /askUserForGatewayCredentials/);
  assert.match(commands, /pauseForGatewayCredentialsIfNeeded/);
});

test('the host still writes .env from a chat sentence', async () => {
  const [chat, tasks, prompt] = await Promise.all([
    readFile('agents/_lib/turn/chat.ts', 'utf8'),
    readFile('agents/_lib/session/task.ts', 'utf8'),
    readFile('agents/_lib/prompt.ts', 'utf8'),
  ]);
  assert.match(chat, /resolveGatewayUserTurn\(message, options\.apiKey\)/);
  assert.match(tasks, /resolveGatewayUserTurn\(message, options\.apiKey\)/);
  assert.match(prompt, /natural language/);
  assert.match(prompt, /配置好并重新预览/);
});

test('applying a key or skip emits gateway_credentials resolved', async () => {
  const { context } = sandboxFiles([
    ['projects/demo/app/.env.example', 'AI_GATEWAY_API_KEY=\nAI_GATEWAY_BASE_URL=\n'],
  ]);
  const events: Array<Record<string, unknown>> = [];
  const state = projectState();
  await applyUserGatewayDecision(context, state, 'conv-resolved', { apiKey: 'sk-user' }, (event) => {
    events.push(event);
  });
  assert.equal(events.some((event) => (
    event.type === 'gateway_credentials'
    && (event.data as { status?: string })?.status === 'resolved'
  )), true);

  const skippedEvents: Array<Record<string, unknown>> = [];
  await applyUserGatewayDecision(context, projectState(), 'conv-skip', { skip: true }, (event) => {
    skippedEvents.push(event);
  });
  assert.equal((skippedEvents[0]?.data as { skipped?: boolean })?.skipped, true);
});

test('askUserForGatewayCredentials does not re-ask after skip', async () => {
  const { context } = sandboxFiles([
    ['projects/demo/app/.env.example', 'AI_GATEWAY_API_KEY=\nAI_GATEWAY_BASE_URL=\n'],
  ]);
  const events: Array<Record<string, unknown>> = [];
  const state = projectState();
  await askUserForGatewayCredentials(context, state, {
    send: (event) => { events.push(event); },
  });
  assert.equal(events.length, 1);
  assert.equal(state.gatewayPromptPending, true);
  state.gatewaySkipped = true;
  await askUserForGatewayCredentials(context, state, {
    send: (event) => { events.push(event); },
  });
  assert.equal(events.length, 1);
});
