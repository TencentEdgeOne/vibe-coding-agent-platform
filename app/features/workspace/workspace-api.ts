import type {
  PersistedActivityTurn,
  ResumeData,
  WorkspaceSnapshot,
} from '../../../shared/protocol';
import type { ModelOption } from '../../../shared/models';
import type { Locale } from '@/app/i18n';

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

export function startPromptTurn(options: {
  conversationId: string;
  message: string;
  turnId: string;
  model?: string;
  language?: Locale;
  apiKey?: string;
  gatewaySkip?: boolean;
  signal?: AbortSignal;
}) {
  return fetch('/prompt', {
    method: 'POST',
    headers: conversationHeaders(options.conversationId),
    body: JSON.stringify({
      message: options.message,
      turnId: options.turnId,
      ...(options.model ? { model: options.model } : {}),
      ...(options.language ? { language: options.language } : {}),
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.gatewaySkip ? { gatewaySkip: true } : {}),
    }),
    signal: options.signal,
  });
}

export function startDeployTurn(options: {
  conversationId: string;
  turnId: string;
  language?: Locale;
  apiKey?: string;
  gatewaySkip?: boolean;
  signal?: AbortSignal;
}) {
  return fetch('/deploy', {
    method: 'POST',
    headers: conversationHeaders(options.conversationId),
    body: JSON.stringify({
      turnId: options.turnId,
      ...(options.language ? { language: options.language } : {}),
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
  return fetch('/stop', {
    method: 'POST',
    headers: conversationHeaders(conversationId),
    body: JSON.stringify({
      conversation_id: conversationId,
      turn,
      ...(options.discardProject ? { discardProject: true } : {}),
    }),
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

export function openTranscriptStream(conversationId: string, signal?: AbortSignal) {
  return fetch('/transcript', {
    method: 'GET',
    headers: conversationHeaders(conversationId),
    signal,
  });
}

export function fetchWorkspaceSnapshot(conversationId: string, signal?: AbortSignal) {
  return fetch('/workspace', {
    method: 'GET',
    headers: conversationHeaders(conversationId),
    signal,
  }).then((response) => readJson<WorkspaceSnapshot>(response)).catch(() => null);
}

export type FileBatchEntry = {
  path: string;
  ok?: boolean;
  content?: string;
  size?: number;
  truncated?: boolean;
  error?: string;
};

const FILE_BATCH_MAX = 12;

export async function fetchFileBatch(
  conversationId: string,
  paths: string[],
  signal?: AbortSignal,
): Promise<FileBatchEntry[]> {
  const unique = [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
  const files: FileBatchEntry[] = [];
  for (let index = 0; index < unique.length; index += FILE_BATCH_MAX) {
    const batch = unique.slice(index, index + FILE_BATCH_MAX);
    const response = await fetch(`/file?paths=${encodeURIComponent(batch.join(','))}`, {
      method: 'GET',
      headers: conversationHeaders(conversationId),
      signal,
    });
    const data = await readJson<{ ok?: boolean; files?: FileBatchEntry[] }>(response);
    if (Array.isArray(data?.files)) files.push(...data.files);
  }
  return files;
}
