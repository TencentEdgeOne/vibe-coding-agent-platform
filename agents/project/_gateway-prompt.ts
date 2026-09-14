/**
 * In-conversation collection of AI Gateway values for a generated project.
 *
 * `.env.example` declares the names. When the user types values here they are
 * written to `.env` so the CLI can load them; skip leaves that file alone.
 */

import type { ProjectState, StreamSend } from '../_types.ts';
import { getFileTree } from './_fs.ts';
import { AGENT_GATEWAY_ENV_KEYS } from './_makers-declarations.ts';

export const DEFAULT_AI_GATEWAY_BASE_URL = 'https://ai-gateway.edgeone.link';

export type GatewayDecision =
  | { status: 'provided'; apiKey: string }
  | { status: 'skipped' };

type GatewayWaiter = {
  promise: Promise<GatewayDecision>;
  resolve: (decision: GatewayDecision) => void;
  reject: (error: Error) => void;
};

const decisions = new Map<string, GatewayDecision>();
const waiters = new Map<string, GatewayWaiter>();

export function declaredGatewayKeys(content: string): string[] {
  return AGENT_GATEWAY_ENV_KEYS.filter((key) => (
    new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`, 'm').test(content)
  ));
}

export async function projectDeclaresGatewayKeys(
  context: any,
  state: ProjectState,
): Promise<boolean> {
  try {
    const content = await context.sandbox.files.read(`${state.appDir}/.env.example`);
    return typeof content === 'string' && declaredGatewayKeys(content).length > 0;
  } catch {
    return false;
  }
}

export function gatewayEnvFromDecision(decision?: GatewayDecision): Record<string, string> {
  if (!decision || decision.status !== 'provided' || !decision.apiKey) return {};
  return {
    AI_GATEWAY_API_KEY: decision.apiKey,
    AI_GATEWAY_BASE_URL: DEFAULT_AI_GATEWAY_BASE_URL,
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

export function getGatewayDecision(conversationId: string): GatewayDecision | undefined {
  const id = conversationId.trim();
  return id ? decisions.get(id) : undefined;
}

export function submitGatewayDecision(conversationId: string, decision: GatewayDecision) {
  const id = conversationId.trim();
  if (!id) return;
  decisions.set(id, decision);
  const waiter = waiters.get(id);
  if (!waiter) return;
  waiters.delete(id);
  waiter.resolve(decision);
}

export function cancelGatewayPrompt(conversationId: string) {
  const id = conversationId.trim();
  if (!id) return;
  const waiter = waiters.get(id);
  if (!waiter) return;
  waiters.delete(id);
  waiter.reject(new Error('Gateway credential prompt cancelled.'));
}

export function waitForGatewayDecision(
  conversationId: string,
  signal?: AbortSignal,
): Promise<GatewayDecision> {
  const id = conversationId.trim();
  if (!id) {
    return Promise.reject(new Error('Gateway credential prompt cancelled.'));
  }

  const existing = decisions.get(id);
  if (existing) return Promise.resolve(existing);

  const pending = waiters.get(id);
  if (pending) return pending.promise;

  let resolve!: (decision: GatewayDecision) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<GatewayDecision>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const onAbort = () => {
    if (!waiters.has(id)) return;
    waiters.delete(id);
    reject(new Error('Gateway credential prompt cancelled.'));
  };
  if (signal?.aborted) {
    onAbort();
    return promise;
  }
  signal?.addEventListener('abort', onAbort, { once: true });

  waiters.set(id, {
    promise,
    resolve: (decision) => {
      signal?.removeEventListener('abort', onAbort);
      resolve(decision);
    },
    reject,
  });
  return promise;
}

export type GatewayPromptOptions = {
  conversationId?: string;
  send?: StreamSend;
  signal?: AbortSignal;
};

/**
 * Ask once per conversation when `.env.example` declares gateway keys.
 *
 * A provided answer is written to `.env`. No `send` means there is no card
 * to show (resume/restart): reuse a decision if one exists, otherwise continue.
 */
export async function resolveGatewayEnvForMakers(
  context: any,
  state: ProjectState,
  options: GatewayPromptOptions = {},
): Promise<Record<string, string>> {
  const conversationId = (options.conversationId || '').trim();
  if (conversationId) {
    const existing = getGatewayDecision(conversationId);
    if (existing) {
      const values = gatewayEnvFromDecision(existing);
      await writeSandboxGatewayEnv(context, state, values);
      await publishFileTreeAfterEnvWrite(context, state, options.send);
      return values;
    }
  }

  if (!await projectDeclaresGatewayKeys(context, state)) {
    return {};
  }

  if (!conversationId || !options.send) {
    return {};
  }

  options.send({
    type: 'gateway_credentials',
    data: {
      status: 'needed',
      keys: [...AGENT_GATEWAY_ENV_KEYS],
    },
  });

  try {
    const decision = await waitForGatewayDecision(conversationId, options.signal);
    options.send({
      type: 'gateway_credentials',
      data: {
        status: 'resolved',
        skipped: decision.status === 'skipped',
      },
    });
    const values = gatewayEnvFromDecision(decision);
    await writeSandboxGatewayEnv(context, state, values);
    await publishFileTreeAfterEnvWrite(context, state, options.send);
    return values;
  } catch {
    options.send({
      type: 'gateway_credentials',
      data: { status: 'resolved', skipped: true },
    });
    throw new Error('Gateway credential prompt cancelled.');
  }
}
