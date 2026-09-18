import { runChatPipeline } from '../turn/chat.ts';
import { runDeployPipeline } from '../turn/deploy.ts';
import {
  getChatTask,
  getModelPreference,
  saveChatTask,
  saveModelPreference,
} from './store.ts';
import { interruptLiveQuery } from './live.ts';
import type { ChatTask, ChatTaskKind, ChatTaskStatus, StreamSend } from '../types.ts';
import { createSSEResponse, sseEvent } from '../runtime/sse.ts';
import { resolveConversationId } from '../runtime/request.ts';
import { resolveGatewayUserTurn } from '../../../shared/gateway-secret.ts';
import type { ChatStreamEvent } from '../../../shared/protocol.ts';

type SequencedEvent = {
  sequence: number;
  event: ChatStreamEvent;
};

type TaskListener = (event: SequencedEvent) => void;

type LiveChatTask = {
  conversationId: string;
  task: ChatTask;
  events: SequencedEvent[];
  nextSequence: number;
  listeners: Set<TaskListener>;
  abortController: AbortController;
  runPromise?: Promise<void>;
  gatewayApiKey?: string;
  gatewaySkip?: boolean;
};

const liveTasks = new Map<string, LiveChatTask>();

export function abortLiveChatTask(conversationId: string) {
  const trimmed = conversationId.trim();
  if (!trimmed) return;
  void interruptLiveQuery(trimmed);
  for (const liveTask of liveTasks.values()) {
    if (liveTask.conversationId === trimmed && !liveTask.abortController.signal.aborted) {
      liveTask.abortController.abort();
      if (liveTask.task.status === 'queued' || liveTask.task.status === 'running') {
        liveTask.task = {
          ...liveTask.task,
          status: 'stopped',
          finishedAt: Date.now(),
        };
      }
    }
  }
}

export async function markChatTaskStopped(context: any, conversationId: string) {
  const trimmed = conversationId.trim();
  if (!trimmed) return;
  try {
    const existing = await getChatTask(context, trimmed);
    if (!existing) return;
    if (existing.status !== 'queued' && existing.status !== 'running') return;
    await saveChatTask(context, trimmed, {
      ...existing,
      status: 'stopped',
      finishedAt: Date.now(),
    });
  } catch (error) {
    console.warn('[chat-task] failed to mark task stopped', error);
  }
}

export async function markOrphanedTaskFailed(context: any, conversationId: string) {
  const existing = await getChatTask(context, conversationId);
  if (!existing || !isChatTaskActive(existing)) return null;
  if (hasLiveTask(conversationId, existing.id)) return existing;
  const failed: ChatTask = {
    ...existing,
    status: 'failed',
    finishedAt: Date.now(),
    error: 'The previous generation stopped when this instance restarted.',
  };
  await saveChatTask(context, conversationId, failed);
  return null;
}

function taskKey(conversationId: string, taskId: string) {
  return `${conversationId}:${taskId}`;
}

function createTaskId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function getConversationId(context: any): string {
  return resolveConversationId(context).conversationId.trim();
}

function isTerminalEvent(event: ChatStreamEvent) {
  return event.type === 'result' || event.type === 'error';
}

function statusFromResult(event: ChatStreamEvent): ChatTaskStatus {
  const data = event.type === 'result' && event.data ? event.data : {};
  if (data.stopped === true) return 'stopped';
  return data.ok === false ? 'failed' : 'completed';
}

function hasLiveTask(conversationId: string, taskId: string) {
  return liveTasks.has(taskKey(conversationId, taskId));
}

function getOrCreateLiveTask(conversationId: string, task: ChatTask): LiveChatTask {
  const key = taskKey(conversationId, task.id);
  const existing = liveTasks.get(key);
  if (existing) return existing;

  const liveTask: LiveChatTask = {
    conversationId,
    task,
    events: [],
    nextSequence: 0,
    listeners: new Set(),
    abortController: new AbortController(),
  };
  liveTasks.set(key, liveTask);
  return liveTask;
}

function filePushPath(event: ChatStreamEvent): string {
  if (event.type !== 'file_content') return '';
  return event.data?.path || '';
}

function publish(liveTask: LiveChatTask, event: ChatStreamEvent) {
  const supersededPath = filePushPath(event);
  if (supersededPath) {
    const previousIndex = liveTask.events.findIndex(
      (record) => filePushPath(record.event) === supersededPath,
    );
    if (previousIndex >= 0) liveTask.events.splice(previousIndex, 1);
  }

  const record = {
    sequence: ++liveTask.nextSequence,
    event,
  };
  liveTask.events.push(record);
  if (liveTask.events.length > 2_000) {
    liveTask.events.splice(0, liveTask.events.length - 2_000);
  }
  for (const listener of liveTask.listeners) listener(record);
}

export function isChatTaskActive(task: ChatTask | null | undefined): task is ChatTask {
  return task?.status === 'queued' || task?.status === 'running';
}

export function hasLiveChatTask(conversationId: string, taskId: string) {
  const live = liveTasks.get(taskKey(conversationId, taskId));
  return Boolean(live?.runPromise);
}

type ChatTaskOptions = {
  turnId?: string;
  kind?: ChatTaskKind;
  model?: string;
  siteDomain?: string;
  apiKey?: string;
  gatewaySkip?: boolean;
};

async function createChatTask(
  context: any,
  message: string,
  options: ChatTaskOptions = {},
) {
  const conversationId = getConversationId(context);
  if (!conversationId) {
    return {
      ok: false as const,
      status: 400,
      error: 'Missing conversationId. The project workspace cannot be prepared.',
    };
  }

  const taskId = options.turnId || createTaskId();
  const existing = await getChatTask(context, conversationId);
  if (existing && existing.id === taskId && existing.message === message) {
    return { ok: true as const, conversationId, task: existing };
  }
  if (existing && isChatTaskActive(existing)) {
    return {
      ok: false as const,
      status: 409,
      error: 'Another generation is already running for this conversation.',
    };
  }

  const requestedModel = (options.model || '').trim();
  const model = requestedModel || await getModelPreference(context, conversationId);
  const siteDomain = (options.siteDomain || '').trim();
  const task: ChatTask = {
    id: taskId,
    message,
    ...(options.kind === 'deploy' ? { kind: 'deploy' as const } : { kind: 'prompt' as const }),
    ...(siteDomain ? { siteDomain } : {}),
    ...(model ? { model } : {}),
    status: 'queued',
    createdAt: Date.now(),
  };
  await saveChatTask(context, conversationId, task);
  if (requestedModel) {
    await saveModelPreference(context, conversationId, requestedModel);
  }
  return { ok: true as const, conversationId, task };
}

function withTaskAbortSignal(context: any, signal: AbortSignal) {
  const request = context?.request && typeof context.request === 'object'
    ? { ...context.request, signal }
    : { signal };
  return { ...context, request };
}

async function executeLiveTask(context: any, liveTask: LiveChatTask) {
  const runningTask: ChatTask = {
    ...liveTask.task,
    status: 'running',
    startedAt: liveTask.task.startedAt || Date.now(),
    error: undefined,
  };
  liveTask.task = runningTask;
  let finalEvent: ChatStreamEvent | undefined;
  let error: string | undefined;
  const send: StreamSend = (event) => {
    publish(liveTask, event);
    if (isTerminalEvent(event)) finalEvent = event;
  };
  const taskContext = withTaskAbortSignal(context, liveTask.abortController.signal);

  try {
    await saveChatTask(taskContext, liveTask.conversationId, runningTask);
    if (liveTask.task.kind === 'deploy') {
      await runDeployPipeline(taskContext, liveTask.task.message, send, {
        turnId: liveTask.task.id,
        siteDomain: liveTask.task.siteDomain,
        apiKey: liveTask.gatewayApiKey,
        gatewaySkip: liveTask.gatewaySkip,
      });
    } else {
      await runChatPipeline(taskContext, liveTask.task.message, send, {
        turnId: liveTask.task.id,
        model: liveTask.task.model,
        siteDomain: liveTask.task.siteDomain,
        apiKey: liveTask.gatewayApiKey,
        gatewaySkip: liveTask.gatewaySkip,
      });
      liveTask.gatewayApiKey = undefined;
      liveTask.gatewaySkip = undefined;
    }
  } catch (runError) {
    error = runError instanceof Error ? runError.message : 'Request processing failed.';
    if (!finalEvent) {
      publish(liveTask, { type: 'error', error });
      finalEvent = { type: 'error', error };
    }
  }

  const current = liveTask.task;
  const nextStatus = finalEvent?.type === 'result'
    ? statusFromResult(finalEvent)
    : error
      ? 'failed'
      : current.status === 'running' ? 'completed' : current.status;
  const nextTask: ChatTask = {
    ...current,
    status: nextStatus,
    finishedAt: Date.now(),
    ...(error ? { error } : {}),
  };
  liveTask.task = nextTask;
  try {
    await saveChatTask(taskContext, liveTask.conversationId, nextTask);
  } catch (persistError) {
    console.error('[chat-task] failed to persist final task state', persistError);
  }

  const key = taskKey(liveTask.conversationId, liveTask.task.id);
  setTimeout(() => {
    if (liveTask.listeners.size === 0 && !isChatTaskActive(liveTask.task) && liveTasks.get(key) === liveTask) {
      liveTasks.delete(key);
    }
  }, 5 * 60 * 1_000);
}

function ensureChatTaskStarted(
  context: any,
  conversationId: string,
  task: ChatTask,
  extras?: { gatewayApiKey?: string; gatewaySkip?: boolean },
) {
  const liveTask = getOrCreateLiveTask(conversationId, task);
  if (extras?.gatewayApiKey) liveTask.gatewayApiKey = extras.gatewayApiKey;
  if (extras?.gatewaySkip) liveTask.gatewaySkip = true;
  if (!liveTask.runPromise && isChatTaskActive(liveTask.task)) {
    liveTask.runPromise = executeLiveTask(context, liveTask).catch((error) => {
      console.error('[chat-task] execution failed', error);
    });
  }
  return liveTask;
}

class AsyncEventQueue<T> {
  private values: T[] = [];
  private waiters: Array<(value: T) => void> = [];

  push(value: T) {
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.values.push(value);
  }

  next() {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve(value);
    return new Promise<T>((resolve) => this.waiters.push(resolve));
  }
}

const ABORTED = Symbol('aborted');

export async function* iterateLiveChatTaskEvents(
  context: any,
  conversationId: string,
  task: ChatTask,
  extras?: { gatewayApiKey?: string; gatewaySkip?: boolean },
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const liveTask = ensureChatTaskStarted(context, conversationId, task, extras);
  yield sseEvent({
    type: 'task_started',
    data: {
      runId: task.id,
      conversation_id: conversationId,
      status: task.status,
    },
  });
  const queue = new AsyncEventQueue<SequencedEvent>();
  const afterSequence = liveTask.nextSequence;
  const listener: TaskListener = (record) => {
    if (record.sequence > afterSequence) queue.push(record);
  };
  liveTask.listeners.add(listener);

  try {
    for (const record of liveTask.events) {
      if (record.sequence <= afterSequence) yield sseEvent(record.event);
    }

    if (!isChatTaskActive(liveTask.task)) {
      for (const record of liveTask.events) {
        if (record.sequence > afterSequence) yield sseEvent(record.event);
      }
      return;
    }

    const abortPromise = signal
      ? new Promise<typeof ABORTED>((resolve) => {
        if (signal.aborted) resolve(ABORTED);
        else signal.addEventListener('abort', () => resolve(ABORTED), { once: true });
      })
      : null;

    while (!signal?.aborted) {
      const record = await (abortPromise
        ? Promise.race([queue.next(), abortPromise])
        : queue.next());
      if (record === ABORTED) return;
      yield sseEvent(record.event);
      if (isTerminalEvent(record.event)) return;
    }
  } finally {
    liveTask.listeners.delete(listener);
  }
}

function createLiveTaskStreamResponse(
  context: any,
  conversationId: string,
  task: ChatTask,
  extras?: { gatewayApiKey?: string; gatewaySkip?: boolean },
) {
  return createSSEResponse(async function* (signal) {
    yield* iterateLiveChatTaskEvents(context, conversationId, task, extras, signal);
  }, context?.request?.signal);
}

export async function createChatTaskAndStreamResponse(
  context: any,
  message: string,
  options: ChatTaskOptions = {},
) {
  const resolved = resolveGatewayUserTurn(message, options.apiKey);
  const result = await createChatTask(context, resolved.message, {
    ...options,
    ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
  });
  if (!result.ok) {
    return new Response(JSON.stringify(result), {
      status: result.status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  return createLiveTaskStreamResponse(context, result.conversationId, result.task, {
    ...(resolved.apiKey ? { gatewayApiKey: resolved.apiKey } : {}),
    ...(options.gatewaySkip ? { gatewaySkip: true } : {}),
  });
}
