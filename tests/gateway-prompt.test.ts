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
  buildRequestGatewayCredentialsTool,
  declaredGatewayKeys,
  envAssignmentValue,
  gatewayBaseUrlForAgentFramework,
  pauseForGatewayCredentialsIfNeeded,
  projectDeclaresGatewayKeys,
  readProjectGatewayEnv,
  sandboxGatewayKeyIsSet,
  shouldPauseForGatewayCredentials,
} from '../agents/_lib/project/gateway-prompt.ts';
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

test('preview pauses when an AI project has no key and continues after skip', async () => {
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

test('request_gateway_credentials asks once and does not wait', async () => {
  const { context } = sandboxFiles([
    ['projects/demo/app/.env.example', 'AI_GATEWAY_API_KEY=\nAI_GATEWAY_BASE_URL=\n'],
  ]);
  const events: Array<Record<string, unknown>> = [];
  const state = projectState();
  const tool = buildRequestGatewayCredentialsTool({
    context,
    state,
    conversationId: 'conv-tool',
    send: (event) => { events.push(event); },
  });

  const first = await tool.handler({}, {});
  const text = first.content?.[0] && 'text' in first.content[0]
    ? String(first.content[0].text)
    : '';
  assert.match(text, /askedUser/);
  assert.equal(events.length, 1);
  assert.equal(state.gatewayPromptPending, true);

  const configured = sandboxFiles([
    ['projects/demo/app/.env.example', 'AI_GATEWAY_API_KEY=\nAI_GATEWAY_BASE_URL=\n'],
    ['projects/demo/app/.env', `AI_GATEWAY_API_KEY=sk-user\nAI_GATEWAY_BASE_URL=${DEFAULT_AI_GATEWAY_BASE_URL}\n`],
  ]);
  const ready = buildRequestGatewayCredentialsTool({
    context: configured.context,
    state: projectState(),
  });
  const readyResult = await ready.handler({}, {});
  const readyText = readyResult.content?.[0] && 'text' in readyResult.content[0]
    ? String(readyResult.content[0].text)
    : '';
  assert.match(readyText, /configured": true/);

  const skippedState = projectState('projects/demo', { gatewaySkipped: true });
  const skippedTool = buildRequestGatewayCredentialsTool({
    context,
    state: skippedState,
  });
  const skippedResult = await skippedTool.handler({}, {});
  const skippedText = skippedResult.content?.[0] && 'text' in skippedResult.content[0]
    ? String(skippedResult.content[0].text)
    : '';
  assert.match(skippedText, /skipped": true/);
  assert.match(skippedText, /not a preview or deploy failure/);
  assert.deepEqual(
    await readProjectGatewayEnv(configured.context, projectState()),
    {
      AI_GATEWAY_API_KEY: 'sk-user',
      AI_GATEWAY_BASE_URL: DEFAULT_AI_GATEWAY_BASE_URL,
    },
  );
});

test('the conversation card asks for API Key and submits a masked chat turn', async () => {
  const [conversation, screen, api] = await Promise.all([
    readFile('app/components/agent-conversation.tsx', 'utf8'),
    readFile('app/features/workspace/workspace-screen.tsx', 'utf8'),
    readFile('app/features/workspace/workspace-api.ts', 'utf8'),
  ]);
  const card = conversation.slice(
    conversation.indexOf('className="gateway-prompt"'),
    conversation.indexOf('className="gateway-prompt-actions"'),
  );

  assert.equal(TRANSLATIONS.zh.workspace.gatewayPromptTitle, '集成 Models 调用大模型');
  assert.equal(TRANSLATIONS.zh.workspace.gatewayPromptDocs, '如何获取');
  assert.equal(TRANSLATIONS.en.workspace.gatewayPromptDocs, 'How to get them');
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
  assert.match(card, /href=\{gatewayPrompt\.docsUrl\}/);
  assert.match(card, /gatewayPrompt\.apiKey/);
  assert.doesNotMatch(card, /gatewayPrompt\.baseUrl/);
  assert.equal(DEFAULT_AI_GATEWAY_BASE_URL, 'https://ai-gateway.edgeone.link/v1');
  assert.equal(AI_GATEWAY_ORIGIN, 'https://ai-gateway.edgeone.link');
  assert.match(screen, /maskApiKey\(apiKey\)/);
  assert.match(screen, /extractApiKeyFromUserText\(trimmed\)/);
  assert.match(screen, /inboundApiKey \? \{ apiKey: inboundApiKey \}/);
  assert.match(screen, /sendMessage\(`\$\{t\.workspace\.gatewayPromptApiKey\}: \$\{maskApiKey\(apiKey\)\}`, \{ apiKey \}\)/);
  assert.match(screen, /sendMessage\(t\.workspace\.gatewayPromptSkip, \{ gatewaySkip: true \}\)/);
  assert.doesNotMatch(api, /gateway-credentials/);
  assert.match(api, /options\.apiKey \? \{ apiKey: options\.apiKey \}/);
  // The card stays after the assistant turn ends; wiping it in finalize made
  // the input appear and then vanish.
  const finalize = screen.slice(
    screen.indexOf('const finalizeAssistant'),
    screen.indexOf('const activatePreview'),
  );
  assert.doesNotMatch(finalize, /setGatewayNeeded\(false\)/);
  assert.match(screen, /if \(data\.gatewayNeeded\) \{\s*setGatewayNeeded\(true\);/);
});

test('the API key card waits until the assistant turn has finished', async () => {
  const [conversation, screen] = await Promise.all([
    readFile('app/components/agent-conversation.tsx', 'utf8'),
    readFile('app/features/workspace/workspace-screen.tsx', 'utf8'),
  ]);

  // The tool asks mid-stream, but showing the card then greys it out for the
  // last few seconds of copy. Hold it until loading is false so it appears
  // ready to type into.
  assert.match(screen, /gatewayPrompt=\{gatewayNeeded && !loading \? \{/);
  assert.match(conversation, /autoFocus/);
  assert.match(conversation, /disabled=\{gatewayBusy\}/);
});

test('a turn waiting for the API key is completed, not a red error', async () => {
  const [chat, helpers, prompt] = await Promise.all([
    readFile('agents/_lib/pipelines/chat.ts', 'utf8'),
    readFile('agents/_lib/pipelines/helpers.ts', 'utf8'),
    readFile('agents/_lib/prompt.ts', 'utf8'),
  ]);
  const pause = chat.slice(
    chat.indexOf('if (state.gatewayPromptPending)'),
    chat.indexOf('const sanitizedModelOutput'),
  );

  assert.match(helpers, /GATEWAY_CREDENTIALS_USER_REPLY/);
  assert.match(pause, /GATEWAY_CREDENTIALS_USER_REPLY\[replyLocale\]/);
  assert.match(pause, /gatewayNeeded: true/);
  assert.match(pause, /ok: true,\s*\n\s*reply: pauseReply/);
  // The card is gated on result/loading, so a Blob snapshot that hangs or
  // fails must not sit in front of that event. Persist after it, unawaited.
  assert.match(pause, /withSnapshot: false/);
  assert.match(pause, /void checkpoint\.flush\(\)/);
  assert.ok(
    pause.indexOf("type: 'result'") < pause.indexOf('void checkpoint.flush()'),
    'result must go out before snapshot persist, or the card waits on Blob',
  );
  assert.doesNotMatch(pause, /await checkpoint\.flush\(\)/);
  assert.match(prompt, /do not say the preview is ready/);
  assert.match(prompt, /preview and deploy must still run/);
});

test('the host writes .env from a chat sentence, not only from the card', async () => {
  const [chat, tasks, prompt] = await Promise.all([
    readFile('agents/_lib/pipelines/chat.ts', 'utf8'),
    readFile('agents/_lib/chat-tasks.ts', 'utf8'),
    readFile('agents/_lib/prompt.ts', 'utf8'),
  ]);
  assert.match(chat, /resolveGatewayUserTurn\(message, options\.apiKey\)/);
  assert.match(tasks, /resolveGatewayUserTurn\(message, options\.apiKey\)/);
  assert.match(prompt, /natural language/);
  assert.match(prompt, /配置好并重新预览/);
});
