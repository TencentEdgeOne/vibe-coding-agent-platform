import type { AgentContext } from '../runtime/context.ts';
import {
  getChatTask,
  getConversationRecord,
  getLanguagePreference,
  getModelPreference,
  getProjectState,
} from './store.ts';
import { hasLiveChatTask, isChatTaskActive, iterateLiveChatTaskEvents, markOrphanedTaskFailed } from './task.ts';
import { loadTranscriptJsonl } from './transcript.ts';
import { projectTranscript, turnsToMessages } from './projection.ts';
import { assertPreviewServerReady, resolvePublicLinks, rewritePreviewAccessToken, startPreviewServer } from '../project/preview.ts';
import { getFileTree } from '../project/fs.ts';
import { separateLegacyMakersDeployment } from '../project/state.ts';
import { restoreProjectWorkspace } from '../project/workspace.ts';
import {
  clearPreview,
  persistWorkspace,
  publishPreview,
} from '../project/workspace-store.ts';
import type { FileTreeItem, PersistedActivity, PersistedActivityTurn, ProjectState } from '../types.ts';
import { createSSEResponse, sseEvent } from '../runtime/sse.ts';
import { mergeSseGenerators } from '../runtime/merge.ts';
import { isMakersDeployUrl } from '../../../shared/makers-url.ts';
import { isMakersDeployCommand, isMakersDevCommand } from '../makers/tool-phase.ts';
import { resolveConversationId, getRequestQueryParam } from '../runtime/request.ts';
import { ensureProjectDependencies, withTimeout } from '../turn/checkpoint.ts';
import {
  iterateConversationPrep,
  iterateSandboxAndAgentPrep,
  resolveSessionPrepMode,
  sessionPrepSse,
} from './prepare.ts';

function isMakersPreviewState(state: ProjectState) {
  return state.previewKind === 'makers' || isMakersDeployUrl(state.previewUrl);
}

function toolNameImpliesProject(name: string) {
  return name.includes('write_project_file')
    || name.includes('write_files')
    || /__files_write$/.test(name);
}

function activityIsMakersCli(activity: PersistedActivity) {
  if (activity.kind !== 'tool' || !activity.name.includes('commands')) return false;
  const command = activity.inputSummary || '';
  return isMakersDevCommand(command) || isMakersDeployCommand(command);
}

function activityHistoryImpliesProject(activityHistory: PersistedActivityTurn[]) {
  return activityHistory.some((turn) =>
    (turn.activities || []).some((activity: PersistedActivity) =>
      activity.kind === 'tool'
      && (toolNameImpliesProject(activity.name || '') || activityIsMakersCli(activity)),
    ),
  );
}

function activityHistoryImpliesPreview(activityHistory: PersistedActivityTurn[]) {
  return activityHistory.some((turn) =>
    (turn.activities || []).some((activity: PersistedActivity) =>
      activity.kind === 'tool'
      && activity.status === 'completed'
      && activity.name.includes('commands')
      && isMakersDevCommand(activity.command || activity.inputSummary || ''),
    ),
  );
}

function projectStateImpliesPreview(state: ProjectState, activityHistory: PersistedActivityTurn[] = []) {
  return Boolean(state.previewUrl)
    || Boolean(state.previewPublished)
    || activityHistoryImpliesPreview(activityHistory);
}

const WORKSPACE_RESUME_BUDGET_MS = 600_000;
const SANDBOX_PROBE_MS = 15_000;
const PREVIEW_RESTART_BUDGET_MS = 540_000;

function jsonResponse(obj: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

async function loadProjectResumeHistory(context: AgentContext, conversationId: string) {
  const [record, jsonl, model, language] = await Promise.all([
    getConversationRecord(context, conversationId),
    loadTranscriptJsonl(context, conversationId),
    getModelPreference(context, conversationId),
    getLanguagePreference(context, conversationId),
  ]);
  const state = separateLegacyMakersDeployment(record.projectState);
  const activityHistory = projectTranscript(jsonl, state.appDir);
  const messages = turnsToMessages(activityHistory);
  const storedTask = record.chatTask || null;
  let activeTask = isChatTaskActive(storedTask)
    && hasLiveChatTask(conversationId, storedTask.id)
    ? {
        id: storedTask.id,
        message: storedTask.message,
        status: storedTask.status,
        createdAt: storedTask.createdAt,
        startedAt: storedTask.startedAt,
      }
    : null;
  if (isChatTaskActive(storedTask) && !activeTask) {
    await markOrphanedTaskFailed(context, conversationId);
  }

  const hasProject = Boolean(state.created) || activityHistoryImpliesProject(activityHistory);
  const hasPreview = projectStateImpliesPreview(state, activityHistory);

  return {
    ok: true as const,
    stage: 'history' as const,
    conversation_id: conversationId,
    messages,
    activityHistory,
    activeTask,
    hasProject,
    hasPreview,
    needsWorkspace: hasProject,
    deployment: state.deployment,
    model,
    language: language || undefined,
    gatewayNeeded: state.gatewayPromptPending === true,
    gatewaySkipped: state.gatewaySkipped === true,
  };
}

async function republishPreviewOnResume(context: AgentContext, state: ProjectState) {
  if (isMakersPreviewState(state) && state.previewUrl) {
    return {
      url: state.previewUrl,
      kind: 'makers' as const,
      restarted: false,
    };
  }
  try {
    await assertPreviewServerReady(context);
    const accessToken = typeof context.sandbox?.envdAccessToken === 'string'
      ? context.sandbox.envdAccessToken
      : '';

    if (state.previewUrl && accessToken) {
      const rewritten = rewritePreviewAccessToken(state.previewUrl, accessToken);
      if (rewritten) {
        const warmLinks = await resolvePublicLinks(context);
        publishPreview(state, {
          url: rewritten,
          sandboxDebugUrl: warmLinks.sandboxDebugUrl || state.sandboxDebugUrl,
          kind: 'sandbox',
        });
        return {
          url: rewritten,
          sandboxDebugUrl: state.sandboxDebugUrl,
          restarted: false,
        };
      }
    }

    const warmLinks = await resolvePublicLinks(context);
    if (warmLinks.previewUrl) {
      publishPreview(state, {
        url: warmLinks.previewUrl,
        sandboxDebugUrl: warmLinks.sandboxDebugUrl,
        kind: 'sandbox',
      });
      return {
        url: warmLinks.previewUrl,
        sandboxDebugUrl: warmLinks.sandboxDebugUrl,
        restarted: false,
      };
    }
  } catch {
    // Server is not ready — fall through to a full restart.
  }

  const depsReady = await ensureProjectDependencies(context, state);
  if (!depsReady) {
    throw new Error('Project dependencies are not available for preview resume.');
  }

  const server = await startPreviewServer(context, state);
  await assertPreviewServerReady(context, server.readyPath);
  const links = await resolvePublicLinks(context);
  if (!links.previewUrl) {
    throw new Error('Preview server started but no public preview URL was available.');
  }
  publishPreview(state, {
    url: links.previewUrl,
    sandboxDebugUrl: links.sandboxDebugUrl,
    kind: 'sandbox',
  });
  return {
    url: links.previewUrl,
    sandboxDebugUrl: links.sandboxDebugUrl,
    restarted: true,
  };
}

async function runWorkspaceRestoreBody(context: AgentContext, conversationId: string) {
  const chatTask = await getChatTask(context, conversationId);
  const restored = await restoreProjectWorkspace(context, conversationId, { mode: 'resume' });
  const state = restored.state;
  const generationActive = isChatTaskActive(chatTask) && hasLiveChatTask(conversationId, chatTask.id);

  if (!restored.hasFiles) {
    return {
      ok: true as const,
      stage: 'workspace' as const,
      conversation_id: conversationId,
      hasProject: false,
      preview: restored.restoreError ? { error: restored.restoreError } : {},
      deployment: state.deployment,
      files: { root: state.appDir, items: [] as FileTreeItem[] },
    };
  }

  let items: FileTreeItem[] = [];
  try {
    items = await withTimeout(getFileTree(context, state), SANDBOX_PROBE_MS, 'file tree');
  } catch {
    items = [];
  }

  const hasFileItems = items.some((item) => item.type === 'file');
  const shouldStartPreview = !generationActive && hasFileItems;

  let preview: {
    url?: string;
    sandboxDebugUrl?: string;
    error?: string;
    restarted?: boolean;
    kind?: 'sandbox' | 'makers';
  } = {};
  if (shouldStartPreview) {
    try {
      preview = await withTimeout(
        republishPreviewOnResume(context, state),
        PREVIEW_RESTART_BUDGET_MS,
        'preview resume',
      );
    } catch (error) {
      clearPreview(state);
      console.warn(
        '[resume:workspace] preview restart failed:',
        error instanceof Error ? error.message : error,
      );
      preview = {};
    }
  }

  try {
    await persistWorkspace(context, conversationId, state);
  } catch {
    // Non-fatal — the files payload below is still useful.
  }

  return {
    ok: true as const,
    stage: 'workspace' as const,
    conversation_id: conversationId,
    hasProject: hasFileItems || Boolean(state.created),
    preview,
    deployment: state.deployment,
    files: { root: state.appDir, items },
    gatewayNeeded: state.gatewayPromptPending === true,
    gatewaySkipped: state.gatewaySkipped === true,
    ...(hasFileItems ? { download: { url: '/download', filename: 'source.zip' } } : {}),
  };
}

async function runPreviewRefreshBody(context: AgentContext, conversationId: string) {
  const storedState = await getProjectState(context, conversationId);
  const state = separateLegacyMakersDeployment(storedState);
  if (!state.created && !state.previewUrl && !state.previewPublished) {
    return {
      ok: true as const,
      stage: 'preview' as const,
      conversation_id: conversationId,
      preview: {},
      deployment: state.deployment,
    };
  }

  try {
    const preview = await republishPreviewOnResume(context, state);
    try {
      await persistWorkspace(context, conversationId, state);
    } catch {
      // Non-fatal — the fresh URL below is still usable for this session.
    }

    return {
      ok: true as const,
      stage: 'preview' as const,
      conversation_id: conversationId,
      preview,
      deployment: state.deployment,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[resume:preview] remint failed, escalating to workspace restore:', message);
    const workspace = await runWorkspaceRestoreBody(context, conversationId);
    return {
      ...workspace,
      stage: 'preview' as const,
    };
  }
}

export async function runProjectResumePreviewPipeline(context: AgentContext): Promise<Response> {
  const { conversationId } = resolveConversationId(context, { allowQuery: true });
  if (!conversationId) {
    return jsonResponse({ ok: false, error: 'missing conversation_id' }, 400);
  }

  try {
    const payload = await withTimeout(
      runPreviewRefreshBody(context, conversationId),
      WORKSPACE_RESUME_BUDGET_MS,
      'preview refresh',
    );
    return jsonResponse(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Preview refresh failed.';
    console.warn('[resume:preview]', message);
    return jsonResponse({
      ok: true,
      stage: 'preview',
      conversation_id: conversationId,
      preview: { error: message },
    });
  }
}

async function* iterateWorkspaceResumeEvents(
  context: AgentContext,
  conversationId: string,
  mode: ReturnType<typeof resolveSessionPrepMode>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  yield sessionPrepSse(mode, 'workspace', 'running');
  try {
    const workspace = await withTimeout(
      runWorkspaceRestoreBody(context, conversationId),
      WORKSPACE_RESUME_BUDGET_MS,
      'workspace resume',
    );
    if (signal?.aborted) return;
    yield sseEvent({ type: 'resume_workspace', data: workspace });
    yield sessionPrepSse(mode, 'workspace', 'done');
    if (workspace.preview && 'url' in workspace.preview && workspace.preview.url) {
      yield sessionPrepSse(mode, 'preview', 'done');
    }

    const fileItems = workspace.files?.items || [];
    const paths = fileItems.filter((item) => item.type === 'file').map((item) => item.path);
    if (!signal?.aborted && paths.length > 0) {
      yield sseEvent({ type: 'file_changed', data: { paths } });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Workspace resume failed.';
    console.warn('[resume:stream]', message);
    if (!signal?.aborted) {
      yield sessionPrepSse(mode, 'workspace', 'failed');
      yield sseEvent({
        type: 'resume_workspace',
        data: {
          ok: true,
          stage: 'workspace',
          conversation_id: conversationId,
          hasProject: false,
          preview: { error: message },
          files: { root: '', items: [] },
        },
      });
    }
  }
}

export async function createProjectResumeStreamResponse(context: AgentContext): Promise<Response> {
  const { conversationId } = resolveConversationId(context, { allowQuery: true });
  if (!conversationId) {
    return jsonResponse({ ok: false, error: 'missing conversation_id' }, 400);
  }

  const mode = resolveSessionPrepMode(context);
  const model = getRequestQueryParam(context, 'model').value;
  const language = getRequestQueryParam(context, 'language').value;

  return createSSEResponse(async function* (signal) {
    yield* iterateConversationPrep(context, conversationId, {
      mode,
      model,
      language,
      signal,
    });
    if (signal?.aborted) return;

    if (mode === 'create') {
      yield* iterateSandboxAndAgentPrep(context, conversationId, {
        mode,
        isNewProject: true,
        model,
        signal,
      });
      if (!signal?.aborted) yield sessionPrepSse(mode, 'ready', 'done');
      return;
    }

    const history = await loadProjectResumeHistory(context, conversationId);
    yield sseEvent({ type: 'resume_history', data: history });
    if (signal?.aborted) return;

    const storedTask = await getChatTask(context, conversationId);
    const liveTask = isChatTaskActive(storedTask) && hasLiveChatTask(conversationId, storedTask.id)
      ? storedTask
      : null;
    const generators: Array<AsyncGenerator<string>> = [
      iterateSandboxAndAgentPrep(context, conversationId, {
        mode,
        isNewProject: !history.hasProject,
        model: model || history.model,
        signal,
      }),
    ];
    if (history.needsWorkspace) {
      generators.push(iterateWorkspaceResumeEvents(context, conversationId, mode, signal));
    }
    yield* mergeSseGenerators(generators, signal);
    if (!signal?.aborted) yield sessionPrepSse(mode, 'ready', 'done');

    if (liveTask && !signal?.aborted) {
      yield* iterateLiveChatTaskEvents(context, conversationId, liveTask, undefined, signal);
    }
  }, context?.request?.signal);
}
