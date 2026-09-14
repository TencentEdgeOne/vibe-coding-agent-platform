import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { getMakersModelsDocsUrl } from '../app/lib/conversation.ts';
import { TRANSLATIONS } from '../app/i18n.ts';
import {
  DEFAULT_AI_GATEWAY_BASE_URL,
  cancelGatewayPrompt,
  declaredGatewayKeys,
  gatewayEnvFromDecision,
  getGatewayDecision,
  resolveGatewayEnvForMakers,
  submitGatewayDecision,
  waitForGatewayDecision,
} from '../agents/project/_gateway-prompt.ts';
import { projectState } from './helpers/fixtures.ts';

test('declared gateway keys come from .env.example lines', () => {
  assert.deepEqual(
    declaredGatewayKeys('APP_TITLE=Demo\nAI_GATEWAY_API_KEY=\nAI_GATEWAY_BASE_URL=\n'),
    ['AI_GATEWAY_API_KEY', 'AI_GATEWAY_BASE_URL'],
  );
  assert.deepEqual(declaredGatewayKeys('APP_TITLE=Demo\n'), []);
});

test('a provided decision becomes .env values and a skip does not', () => {
  assert.deepEqual(
    gatewayEnvFromDecision({
      status: 'provided',
      apiKey: 'sk-user',
    }),
    {
      AI_GATEWAY_API_KEY: 'sk-user',
      AI_GATEWAY_BASE_URL: DEFAULT_AI_GATEWAY_BASE_URL,
    },
  );
  assert.deepEqual(gatewayEnvFromDecision({ status: 'skipped' }), {});
});

test('the conversation writes provided gateway values to .env', async () => {
  const files = new Map<string, string>([
    ['projects/demo/app/.env.example', 'AI_GATEWAY_API_KEY=\nAI_GATEWAY_BASE_URL=\n'],
    ['projects/demo/app/.env', 'APP_TITLE=Demo\n'],
  ]);
  const context = {
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
      },
    },
  };
  const events: Array<Record<string, unknown>> = [];
  const conversationId = `gateway-prompt-${Date.now()}`;

  const pending = resolveGatewayEnvForMakers(context, projectState(), {
    conversationId,
    send: (event) => { events.push(event); },
  });

  for (let i = 0; i < 20 && events.length === 0; i += 1) {
    await Promise.resolve();
  }
  assert.equal(getGatewayDecision(conversationId), undefined);
  assert.equal(events[0]?.type, 'gateway_credentials');
  assert.deepEqual(
    (events[0]?.data as { status?: string })?.status,
    'needed',
  );

  submitGatewayDecision(conversationId, {
    status: 'provided',
    apiKey: 'sk-user',
  });

  assert.deepEqual(await pending, {
    AI_GATEWAY_API_KEY: 'sk-user',
    AI_GATEWAY_BASE_URL: DEFAULT_AI_GATEWAY_BASE_URL,
  });
  assert.equal(events.at(-1)?.type, 'gateway_credentials');
  assert.equal((events.at(-1)?.data as { skipped?: boolean })?.skipped, false);
  assert.equal(
    files.get('projects/demo/app/.env'),
    `APP_TITLE=Demo\nAI_GATEWAY_API_KEY=sk-user\nAI_GATEWAY_BASE_URL=${DEFAULT_AI_GATEWAY_BASE_URL}\n`,
  );
  assert.equal(
    files.get('projects/demo/app/.env.example'),
    'AI_GATEWAY_API_KEY=\nAI_GATEWAY_BASE_URL=\n',
  );

  assert.deepEqual(
    await resolveGatewayEnvForMakers(context, projectState(), {
      conversationId,
      send: (event) => { events.push(event); },
    }),
    {
      AI_GATEWAY_API_KEY: 'sk-user',
      AI_GATEWAY_BASE_URL: DEFAULT_AI_GATEWAY_BASE_URL,
    },
  );
  assert.equal(
    files.get('projects/demo/app/.env'),
    `APP_TITLE=Demo\nAI_GATEWAY_API_KEY=sk-user\nAI_GATEWAY_BASE_URL=${DEFAULT_AI_GATEWAY_BASE_URL}\n`,
  );
});

test('skipping continues preview without writing .env', async () => {
  const files = new Map<string, string>([
    ['projects/demo/app/.env.example', 'AI_GATEWAY_API_KEY=\nAI_GATEWAY_BASE_URL=\n'],
  ]);
  const context = {
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
      },
    },
  };
  const conversationId = `gateway-skip-${Date.now()}`;
  const pending = resolveGatewayEnvForMakers(context, projectState(), {
    conversationId,
    send: () => {},
  });
  await Promise.resolve();
  submitGatewayDecision(conversationId, { status: 'skipped' });
  assert.deepEqual(await pending, {});
  assert.equal(getGatewayDecision(conversationId)?.status, 'skipped');
  assert.equal(files.has('projects/demo/app/.env'), false);
});

test('a cancelled wait rejects and does not keep a decision', async () => {
  const conversationId = `gateway-cancel-${Date.now()}`;
  const pending = waitForGatewayDecision(conversationId);
  cancelGatewayPrompt(conversationId);
  await assert.rejects(pending, /cancelled/);
  assert.equal(getGatewayDecision(conversationId), undefined);
});

test('the conversation card asks for API Key and links to the models docs', async () => {
  const [conversation, screen] = await Promise.all([
    readFile('app/components/agent-conversation.tsx', 'utf8'),
    readFile('app/features/workspace/workspace-screen.tsx', 'utf8'),
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
  assert.equal(DEFAULT_AI_GATEWAY_BASE_URL, 'https://ai-gateway.edgeone.link');
});
