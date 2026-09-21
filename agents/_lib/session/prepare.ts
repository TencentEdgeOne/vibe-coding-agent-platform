import type { AgentContext } from '../runtime/context.ts';
import { mergeSseGenerators } from '../runtime/merge.ts';
import { getRequestQueryParam } from '../runtime/request.ts';
import { sseEvent } from '../runtime/sse.ts';
import { extendExistingSandboxTimeout } from '../turn/checkpoint.ts';
import { ensureWorkspaceDirectories, markFreshWorkspace } from '../project/workspace.ts';
import { getProjectState, patchConversationRecord } from './store.ts';
import { warmLiveQuery } from './live.ts';
import { timeStage } from '../utils/timing.ts';
import type {
  SessionPrepData,
  SessionPrepMode,
  SessionPrepStage,
  SessionPrepStatus,
} from '../../../shared/protocol.ts';

export function resolveSessionPrepMode(context: AgentContext): SessionPrepMode {
  return getRequestQueryParam(context, 'mode').value === 'create' ? 'create' : 'restore';
}

export function sessionPrepSse(
  mode: SessionPrepMode,
  stage: SessionPrepStage,
  status: SessionPrepStatus,
): string {
  const data: SessionPrepData = { mode, stage, status };
  return sseEvent({ type: 'session_prep', data });
}

export async function persistConversationPreferences(
  context: AgentContext,
  conversationId: string,
  options: { model?: string; language?: string } = {},
) {
  const model = (options.model || '').trim();
  const language = (options.language || '').trim();
  await patchConversationRecord(context, conversationId, {
    ...(model ? { modelPreference: model } : {}),
    ...(language === 'zh' || language === 'en' ? { languagePreference: language } : {}),
  });
}

export async function prepareSandboxWorkspace(
  context: AgentContext,
  conversationId: string,
  options: { mode?: SessionPrepMode } = {},
) {
  await extendExistingSandboxTimeout(context);
  const state = await getProjectState(context, conversationId);
  await ensureWorkspaceDirectories(context, state);
  // Only a create visit knows the workspace is empty; a restore may still have
  // a snapshot to pull down, so its first prompt must keep probing.
  if (options.mode === 'create' && !state.created) {
    markFreshWorkspace(conversationId, state.appDir);
  }
  return state;
}

export async function* iterateConversationPrep(
  context: AgentContext,
  conversationId: string,
  options: {
    mode: SessionPrepMode;
    model?: string;
    language?: string;
    signal?: AbortSignal;
  },
): AsyncGenerator<string> {
  const { mode, signal } = options;
  const model = (options.model || '').trim();
  const language = (options.language || '').trim();
  yield sessionPrepSse(mode, 'conversation', 'running');
  // A restore carries no preferences, so the patch would be a strong-consistency
  // read plus a write that changes nothing, in front of every later stage.
  if (!model && !language) {
    yield sessionPrepSse(mode, 'conversation', 'done');
    return;
  }
  try {
    await timeStage(
      'session:prep',
      { mode, stage: 'conversation' },
      () => persistConversationPreferences(context, conversationId, { model, language }),
    );
    if (signal?.aborted) return;
    yield sessionPrepSse(mode, 'conversation', 'done');
  } catch (error) {
    console.warn(
      '[session:prep] conversation',
      error instanceof Error ? error.message : error,
    );
    if (!signal?.aborted) yield sessionPrepSse(mode, 'conversation', 'failed');
  }
}

export async function* iterateSandboxPrepEvents(
  context: AgentContext,
  conversationId: string,
  options: {
    mode: SessionPrepMode;
    signal?: AbortSignal;
  },
): AsyncGenerator<string> {
  const { mode, signal } = options;
  yield sessionPrepSse(mode, 'sandbox', 'running');
  try {
    await timeStage(
      'session:prep',
      { mode, stage: 'sandbox' },
      () => prepareSandboxWorkspace(context, conversationId, { mode }),
    );
    if (signal?.aborted) return;
    yield sessionPrepSse(mode, 'sandbox', 'done');
  } catch (error) {
    console.warn(
      '[session:prep] sandbox',
      error instanceof Error ? error.message : error,
    );
    if (!signal?.aborted) yield sessionPrepSse(mode, 'sandbox', 'failed');
  }
}

export async function* iterateAgentWarmupEvents(
  context: AgentContext,
  conversationId: string,
  options: {
    mode: SessionPrepMode;
    model?: string;
    signal?: AbortSignal;
  },
): AsyncGenerator<string> {
  const { mode, signal } = options;
  yield sessionPrepSse(mode, 'agent', 'running');
  try {
    const state = await getProjectState(context, conversationId);
    const warmed = await timeStage(
      'session:prep',
      { mode, stage: 'agent' },
      () => warmLiveQuery({
        context,
        conversationId,
        state,
        model: options.model,
        abortSignal: signal,
      }),
    );
    if (signal?.aborted) return;
    yield sessionPrepSse(mode, 'agent', warmed.ok ? 'done' : 'failed');
  } catch (error) {
    console.warn(
      '[session:prep] agent',
      error instanceof Error ? error.message : error,
    );
    if (!signal?.aborted) yield sessionPrepSse(mode, 'agent', 'failed');
  }
}

/** Activate the sandbox and pre-warm the CLI together; the coding turn waits for both. */
export async function* iterateSandboxAndAgentPrep(
  context: AgentContext,
  conversationId: string,
  options: {
    mode: SessionPrepMode;
    model?: string;
    signal?: AbortSignal;
  },
): AsyncGenerator<string> {
  yield* mergeSseGenerators([
    iterateSandboxPrepEvents(context, conversationId, options),
    iterateAgentWarmupEvents(context, conversationId, options),
  ], options.signal);
}
