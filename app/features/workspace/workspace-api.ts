import type {
  PersistedActivityTurn,
  ResumeData,
} from '../../../shared/protocol';
import type { ModelOption } from '../../../shared/models';

function conversationHeaders(conversationId: string): HeadersInit {
  return {
    'content-type': 'application/json',
    conversationId,
    'makers-conversation-id': conversationId,
  };
}

async function readJson<T>(response: Response): Promise<T | null> {
  return response.json().catch(() => null) as Promise<T | null>;
}

export function openSessionStream(conversationId: string, signal?: AbortSignal) {
  return fetch('/session', {
    method: 'GET',
    headers: conversationHeaders(conversationId),
    signal,
  });
}

// Cold session restore can reinstall the EdgeOne CLI (420s ceiling) and project
// dependencies before makers-dev starts.
const PREVIEW_CLIENT_TIMEOUT_MS = 620_000;

export function fetchPreviewRefresh(conversationId: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PREVIEW_CLIENT_TIMEOUT_MS);
  return fetch('/preview', {
    method: 'POST',
    headers: conversationHeaders(conversationId),
    body: JSON.stringify({}),
    signal: controller.signal,
  })
    .then((response) => readJson<ResumeData>(response))
    .catch(() => null)
    .finally(() => clearTimeout(timer));
}

/**
 * The models this deployment offers. Fetched rather than bundled: the list is
 * assembled from server environment the browser cannot read, and the server
 * validates against the same list, so building one here could only drift.
 *
 * An edge function, so it does not need a conversation the way agent routes do.
 */
export function fetchModelCatalog(signal?: AbortSignal) {
  return fetch('/models', {
    method: 'GET',
    signal,
  })
    .then((response) => readJson<{
      ok?: boolean;
      models?: ModelOption[];
      defaultModel?: string;
    }>(response))
    .catch(() => null);
}

export function startSessionTurn(options: {
  conversationId: string;
  message: string;
  turnId: string;
  resetProject: boolean;
  /** 'deploy' publishes the current project instead of running the model. */
  intent?: 'deploy';
  /** Omitted runs the deployment default; the server drops anything it does not offer. */
  model?: string;
  siteDomain?: string;
  /** Real key from the input card; the visible message stays masked. */
  apiKey?: string;
  gatewaySkip?: boolean;
  signal?: AbortSignal;
}) {
  return fetch('/session', {
    method: 'POST',
    headers: conversationHeaders(options.conversationId),
    body: JSON.stringify({
      message: options.message,
      turnId: options.turnId,
      ...(options.resetProject ? { resetProject: true } : {}),
      ...(options.intent ? { intent: options.intent } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.siteDomain ? { siteDomain: options.siteDomain } : {}),
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.gatewaySkip ? { gatewaySkip: true } : {}),
    }),
    signal: options.signal,
  });
}

export async function stopChatTask(
  conversationId: string,
  turn: PersistedActivityTurn,
  options: { discardProject?: boolean } = {},
) {
  const request = (headers: HeadersInit) => fetch('/stop', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      conversation_id: conversationId,
      turn,
      ...(options.discardProject ? { discardProject: true } : {}),
    }),
  });

  const response = await request({ 'content-type': 'application/json' });
  if (response.status !== 400) return response;
  const error = await readJson<{ code?: string }>(response.clone());
  if (error?.code !== 'AGENT_CONVERSATION_ID_REQUIRED') return response;

  // Compatibility only: current runtimes require body-only /stop so sticky
  // routing cannot pin cancellation to the busy chat instance.
  return request({
    'content-type': 'application/json',
    'makers-conversation-id': conversationId,
  });
}

export function fetchProjectArchive(url: string, conversationId: string) {
  return fetch(url, {
    method: 'GET',
    headers: conversationId
      ? {
          conversationId,
          'makers-conversation-id': conversationId,
        }
      : {},
  });
}
