import { getStore } from '@edgeone/pages-blob';
import { createProjectState } from '../project/state.ts';
import type { BlobStoreLike, PersistCapable } from '../runtime/context.ts';
import type { ChatTask, ProjectState } from '../types.ts';

const BLOB_STORE_NAME = 'vibe-sessions';

export type ConversationRecord = {
  claudeSessionId?: string;
  transcriptPath?: string;
  modelPreference?: string;
  languagePreference?: 'zh' | 'en';
  projectState: ProjectState;
  chatTask?: ChatTask | null;
};

function conversationKey(conversationId: string) {
  return `conv/${conversationId}/state.json`;
}

export function transcriptBlobKey(sessionId: string) {
  return `sessions/${sessionId}.jsonl`;
}

export function createMemoryBlobStore(): BlobStoreLike {
  const data = new Map<string, { kind: 'json' | 'bytes'; value: unknown }>();
  return {
    async set(key, value) {
      if (typeof value === 'string') {
        data.set(key, { kind: 'bytes', value });
        return;
      }
      if (value instanceof ReadableStream) {
        const reader = value.getReader();
        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          if (chunk) chunks.push(chunk);
        }
        const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        data.set(key, { kind: 'bytes', value: Buffer.from(bytes).toString('utf8') });
        return;
      }
      if (value instanceof ArrayBuffer) {
        data.set(key, { kind: 'bytes', value: Buffer.from(value).toString('utf8') });
        return;
      }
      data.set(key, { kind: 'bytes', value: String(value) });
    },
    async setJSON(key, value) {
      data.set(key, { kind: 'json', value });
    },
    async get(key, options) {
      const entry = data.get(key);
      if (!entry) return null;
      if (options?.type === 'stream') {
        const text = entry.kind === 'bytes' ? String(entry.value) : JSON.stringify(entry.value);
        return new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
          },
        });
      }
      if (options?.type === 'json' || entry.kind === 'json') {
        return entry.kind === 'json' ? entry.value : JSON.parse(String(entry.value));
      }
      return entry.kind === 'bytes' ? entry.value : JSON.stringify(entry.value);
    },
    async delete(key) {
      data.delete(key);
    },
    async list(options) {
      const prefix = options?.prefix || '';
      return {
        blobs: [...data.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key })),
      };
    },
  };
}

export function getBlobStore(context?: PersistCapable): BlobStoreLike {
  if (context?.blobStore) return context.blobStore;
  return (getStore as unknown as (options: { name: string; consistency: 'strong' }) => BlobStoreLike)({
    name: BLOB_STORE_NAME,
    consistency: 'strong',
  });
}

/**
 * One wake reads `conv/{id}/state.json` about a dozen times over
 * strong-consistency Blob. The request `context` is the natural lifetime for a
 * memo of it — a WeakMap on it cannot outlive the request or leak across
 * conversations. Writes stay read-modify-write against the blob so a
 * concurrent request's field is never clobbered, and refresh this entry so a
 * read after a write in the same request sees the new value.
 */
const recordCache = new WeakMap<object, Map<string, ConversationRecord>>();

function recordCacheFor(context: { blobStore?: BlobStoreLike }) {
  if (!context || typeof context !== 'object') return null;
  const existing = recordCache.get(context);
  if (existing) return existing;
  const created = new Map<string, ConversationRecord>();
  recordCache.set(context, created);
  return created;
}

export async function getConversationRecord(
  context: { blobStore?: BlobStoreLike },
  conversationId: string,
  /** `refresh` is for callers that poll for another writer's field. */
  options: { refresh?: boolean } = {},
): Promise<ConversationRecord> {
  const cache = recordCacheFor(context);
  if (!options.refresh) {
    const cached = cache?.get(conversationId);
    if (cached) return cached;
  }
  const stored = await getBlobStore(context).get(conversationKey(conversationId), { type: 'json' });
  const record = stored
    && typeof stored === 'object'
    && (stored as ConversationRecord).projectState
    && typeof (stored as ConversationRecord).projectState === 'object'
    ? stored as ConversationRecord
    : { projectState: createProjectState(conversationId) };
  cache?.set(conversationId, record);
  return record;
}

export async function saveConversationRecord(
  context: { blobStore?: BlobStoreLike },
  conversationId: string,
  record: ConversationRecord,
) {
  await getBlobStore(context).setJSON(conversationKey(conversationId), record);
  recordCacheFor(context)?.set(conversationId, record);
}

export async function patchConversationRecord(
  context: { blobStore?: BlobStoreLike },
  conversationId: string,
  patch: Partial<ConversationRecord>,
) {
  const current = await getConversationRecord(context, conversationId, { refresh: true });
  const next: ConversationRecord = {
    ...current,
    ...patch,
    projectState: patch.projectState || current.projectState,
  };
  await saveConversationRecord(context, conversationId, next);
  return next;
}

export async function getProjectState(context: { blobStore?: BlobStoreLike }, conversationId: string) {
  return (await getConversationRecord(context, conversationId)).projectState;
}

export async function saveProjectState(
  context: { blobStore?: BlobStoreLike },
  conversationId: string,
  state: ProjectState,
) {
  await patchConversationRecord(context, conversationId, { projectState: state });
}

export async function getChatTask(context: { blobStore?: BlobStoreLike }, conversationId: string) {
  return (await getConversationRecord(context, conversationId)).chatTask || null;
}

export async function saveChatTask(
  context: { blobStore?: BlobStoreLike },
  conversationId: string,
  task: ChatTask | null,
) {
  await patchConversationRecord(context, conversationId, { chatTask: task });
}

export async function getModelPreference(context: { blobStore?: BlobStoreLike }, conversationId: string) {
  return (await getConversationRecord(context, conversationId)).modelPreference?.trim() || '';
}

export async function saveModelPreference(
  context: { blobStore?: BlobStoreLike },
  conversationId: string,
  model: string,
) {
  await patchConversationRecord(context, conversationId, { modelPreference: model.trim() });
}

export async function getLanguagePreference(
  context: { blobStore?: BlobStoreLike },
  conversationId: string,
) {
  const value = (await getConversationRecord(context, conversationId)).languagePreference;
  return value === 'zh' || value === 'en' ? value : '';
}

export async function saveLanguagePreference(
  context: { blobStore?: BlobStoreLike },
  conversationId: string,
  language: string,
) {
  const next = language.trim();
  if (next !== 'zh' && next !== 'en') return;
  await patchConversationRecord(context, conversationId, { languagePreference: next });
}
