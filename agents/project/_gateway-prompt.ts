/**
 * Models API key collection for a generated AI project.
 *
 * `.env.example` declares the names. The agent checks before preview or deploy
 * and asks the user when `.env` has no key. The host shows the input card; the
 * next user turn carries the key (masked in the transcript) or a skip, and
 * this module writes `.env` so the CLI can load it.
 */

import { tool as defineClaudeTool } from '@anthropic-ai/claude-agent-sdk';
import { saveProjectState } from '../_memory.ts';
import type { ClaudeMcpTool, ProjectState, StreamSend } from '../_types.ts';
import { stringifyToolResult } from '../utils/_text.ts';
import { getFileTree } from './_fs.ts';
import { AGENT_GATEWAY_ENV_KEYS } from './_makers-declarations.ts';

/** Origin the Claude Agent SDK wants. OpenAI-compatible clients need `/v1` on top. */
export const AI_GATEWAY_ORIGIN = 'https://ai-gateway.edgeone.link';

/** Default written into a generated project's `.env` (DeepAgents / LangGraph / OpenAI). */
export const DEFAULT_AI_GATEWAY_BASE_URL = `${AI_GATEWAY_ORIGIN}/v1`;

/**
 * Claude's client treats the base as an origin and appends its own path.
 * OpenAI-compatible clients append `/chat/completions`, so they need `/v1`.
 */
export function gatewayBaseUrlForAgentFramework(framework?: string | null) {
  return framework === 'claude-agent-sdk' ? AI_GATEWAY_ORIGIN : DEFAULT_AI_GATEWAY_BASE_URL;
}

export const REQUEST_GATEWAY_CREDENTIALS_TOOL = 'request_gateway_credentials';

export const GATEWAY_CREDENTIALS_PAUSE_MESSAGE = [
  'AI_GATEWAY_API_KEY is not set in the project .env.',
  'The user has been shown the API key input card.',
  'End this turn now. Do not run preview or deploy, and do not call this again.',
  'A later turn will continue after they provide a key or skip.',
].join(' ');

export function isRequestGatewayCredentialsTool(name: string) {
  return name === REQUEST_GATEWAY_CREDENTIALS_TOOL
    || name.endsWith(`__${REQUEST_GATEWAY_CREDENTIALS_TOOL}`);
}

export function declaredGatewayKeys(content: string): string[] {
  return AGENT_GATEWAY_ENV_KEYS.filter((key) => (
    new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`, 'm').test(content)
  ));
}

export function envAssignmentValue(content: string, key: string): string {
  const match = content.match(new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=(.*)$`, 'm'));
  if (!match) return '';
  let value = match[1].trim();
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value.trim();
}

async function readProjectFile(context: any, state: ProjectState, relPath: string) {
  try {
    const content = await context.sandbox.files.read(`${state.appDir}/${relPath}`);
    return typeof content === 'string' ? content : '';
  } catch {
    return '';
  }
}

export async function projectDeclaresGatewayKeys(
  context: any,
  state: ProjectState,
): Promise<boolean> {
  const content = await readProjectFile(context, state, '.env.example');
  return Boolean(content) && declaredGatewayKeys(content).length > 0;
}

async function projectHasAgentsDirectory(context: any, state: ProjectState) {
  try {
    return Boolean(await context.sandbox.files.exists(`${state.appDir}/agents`));
  } catch {
    return false;
  }
}

export async function projectNeedsGatewayKey(
  context: any,
  state: ProjectState,
): Promise<boolean> {
  return await projectDeclaresGatewayKeys(context, state)
    || await projectHasAgentsDirectory(context, state);
}

export async function sandboxGatewayKeyIsSet(
  context: any,
  state: ProjectState,
): Promise<boolean> {
  const content = await readProjectFile(context, state, '.env');
  return Boolean(content) && Boolean(envAssignmentValue(content, 'AI_GATEWAY_API_KEY'));
}

async function readProjectAgentFramework(context: any, state: ProjectState) {
  const content = await readProjectFile(context, state, 'edgeone.json');
  if (!content) return '';
  try {
    const framework = JSON.parse(content)?.agents?.framework;
    return typeof framework === 'string' ? framework : '';
  } catch {
    return '';
  }
}

export async function readProjectGatewayEnv(
  context: any,
  state: ProjectState,
): Promise<Record<string, string>> {
  const content = await readProjectFile(context, state, '.env');
  if (!content) return {};
  const apiKey = envAssignmentValue(content, 'AI_GATEWAY_API_KEY');
  if (!apiKey) return {};
  return {
    AI_GATEWAY_API_KEY: apiKey,
    AI_GATEWAY_BASE_URL: envAssignmentValue(content, 'AI_GATEWAY_BASE_URL')
      || gatewayBaseUrlForAgentFramework(await readProjectAgentFramework(context, state)),
  };
}

function upsertEnvValues(content: string, values: Record<string, string>) {
  let next = content.replace(/\r\n/g, '\n');
  for (const [key, value] of Object.entries(values)) {
    const pattern = new RegExp(`^(\\s*(?:export\\s+)?${key}\\s*=).*$`, 'm');
    if (pattern.test(next)) {
      next = next.replace(pattern, (_match, prefix: string) => `${prefix}${value}`);
      continue;
    }
    next = `${next.replace(/\n*$/, '\n')}${key}=${value}\n`;
  }
  return next.replace(/^\n+/, '').replace(/\n*$/, '\n');
}

export async function writeSandboxGatewayEnv(
  context: any,
  state: ProjectState,
  values: Record<string, string>,
) {
  if (Object.keys(values).length === 0) return;
  const envPath = `${state.appDir}/.env`;
  let current = '';
  try {
    const existing = await context.sandbox.files.read(envPath);
    if (typeof existing === 'string') current = existing;
  } catch {
    current = '';
  }
  const next = upsertEnvValues(current, values);
  if (next === current.replace(/\r\n/g, '\n').replace(/\n*$/, '\n')) return;
  await context.sandbox.files.write(envPath, next);
}

async function publishFileTreeAfterEnvWrite(
  context: any,
  state: ProjectState,
  send?: StreamSend,
) {
  if (!send) return;
  try {
    send({
      type: 'file_tree',
      data: {
        root: state.appDir,
        items: await getFileTree(context, state),
      },
    });
  } catch {
    // The files panel refreshes again at the end of the turn.
  }
}

export type GatewayPromptOptions = {
  conversationId?: string;
  send?: StreamSend;
};

export async function askUserForGatewayCredentials(
  context: any,
  state: ProjectState,
  options: GatewayPromptOptions = {},
) {
  state.gatewayPromptPending = true;
  await persistGatewayState(context, options.conversationId || '', state);
  options.send?.({
    type: 'gateway_credentials',
    data: {
      status: 'needed',
      keys: [...AGENT_GATEWAY_ENV_KEYS],
    },
  });
}

export async function shouldPauseForGatewayCredentials(
  context: any,
  state: ProjectState,
): Promise<boolean> {
  if (state.gatewaySkipped) return false;
  if (await sandboxGatewayKeyIsSet(context, state)) return false;
  return projectNeedsGatewayKey(context, state);
}

export async function pauseForGatewayCredentialsIfNeeded(
  context: any,
  state: ProjectState,
  options: GatewayPromptOptions = {},
): Promise<string> {
  if (!await shouldPauseForGatewayCredentials(context, state)) return '';
  await askUserForGatewayCredentials(context, state, options);
  return GATEWAY_CREDENTIALS_PAUSE_MESSAGE;
}

async function persistGatewayState(
  context: any,
  conversationId: string,
  state: ProjectState,
) {
  const id = conversationId.trim();
  if (!id) return;
  try {
    await saveProjectState(context, id, state);
  } catch {
    // The card and `.env` write are still useful without a durable flag.
  }
}

export async function applyUserGatewayDecision(
  context: any,
  state: ProjectState,
  conversationId: string,
  decision: { apiKey?: string; skip?: boolean },
  send?: StreamSend,
) {
  if (decision.skip) {
    state.gatewayPromptPending = false;
    state.gatewaySkipped = true;
    await persistGatewayState(context, conversationId, state);
    return {};
  }

  const apiKey = (decision.apiKey || '').trim();
  if (!apiKey) return {};

  const values = {
    AI_GATEWAY_API_KEY: apiKey,
    AI_GATEWAY_BASE_URL: gatewayBaseUrlForAgentFramework(
      await readProjectAgentFramework(context, state),
    ),
  };
  await writeSandboxGatewayEnv(context, state, values);
  state.gatewayPromptPending = false;
  state.gatewaySkipped = false;
  await persistGatewayState(context, conversationId, state);
  await publishFileTreeAfterEnvWrite(context, state, send);
  return values;
}

export function buildRequestGatewayCredentialsTool(options: {
  context: any;
  state: ProjectState;
  conversationId?: string;
  send?: StreamSend;
}): ClaudeMcpTool {
  const { context, state, conversationId, send } = options;
  return defineClaudeTool(
    REQUEST_GATEWAY_CREDENTIALS_TOOL,
    [
      'Before preview or deploy of an AI project, check whether .env has a non-empty AI_GATEWAY_API_KEY.',
      'If the key is already set, not required, or the user already skipped, continue with preview or deploy.',
      'If the key is missing, this shows the user the API key input card and you must end the turn.',
      'Do not run edgeone makers dest or deploy after this tool says the user has been asked.',
    ].join(' '),
    {},
    async () => {
      if (state.gatewaySkipped) {
        return {
          content: [{
            type: 'text' as const,
            text: stringifyToolResult({
              needed: true,
              configured: false,
              skipped: true,
              instruction: 'The user already skipped the API key. Continue preview or deploy without writing .env. A missing key is not a preview or deploy failure.',
            }),
          }],
        };
      }

      const needed = await projectNeedsGatewayKey(context, state);
      if (!needed) {
        return {
          content: [{
            type: 'text' as const,
            text: stringifyToolResult({
              needed: false,
              instruction: 'This project does not need a Models API key. Continue.',
            }),
          }],
        };
      }

      if (await sandboxGatewayKeyIsSet(context, state)) {
        return {
          content: [{
            type: 'text' as const,
            text: stringifyToolResult({
              needed: true,
              configured: true,
              instruction: 'AI_GATEWAY_API_KEY is already set. Continue preview or deploy. Do not quote the value.',
            }),
          }],
        };
      }

      await askUserForGatewayCredentials(context, state, { conversationId, send });
      return {
        content: [{
          type: 'text' as const,
          text: stringifyToolResult({
            needed: true,
            configured: false,
            askedUser: true,
            instruction: GATEWAY_CREDENTIALS_PAUSE_MESSAGE,
          }),
        }],
      };
    },
  ) as ClaudeMcpTool;
}
