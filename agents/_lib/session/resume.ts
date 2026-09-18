import {
  getChatTask,
  getConversationRecord,
  getModelPreference,
  getProjectState,
  saveProjectState,
} from './store.ts';
import { hasLiveChatTask, isChatTaskActive, iterateLiveChatTaskEvents, markOrphanedTaskFailed } from './task.ts';
import { loadTranscriptJsonl } from './transcript.ts';
import { projectTranscript, turnsToMessages } from './projection.ts';
import {
  assertPreviewServerReady,
  getFileTree,
  resolvePublicLinks,
  rewritePreviewAccessToken,
  separateLegacyMakersDeployment,
  startPreviewServer,
} from '../project/index.ts';
import { restoreProjectWorkspace } from '../project/workspace.ts';
import { loadResumeFileContents } from '../project/resume-files.ts';
import type { FileTreeItem, PersistedActivity, PersistedActivityTurn, ProjectState } from '../types.ts';
import { createSSEResponse, sseEvent } from '../runtime/sse.ts';
import { mergeSseGenerators } from '../runtime/merge.ts';
import { isMakersDeployUrl } from '../../../shared/makers-url.ts';
import { isMakersDeployCommand, isMakersDevCommand } from '../makers/tool-phase.ts';
import { resolveConversationId } from '../runtime/request.ts';
import { ensureProjectDependencies, withTimeout } from '../turn/checkpoint.ts';

function isMakersPreviewState(state: ProjectState) {
  return state.previewKind === 'makers' || isMakersDeployUrl(state.previewUrl);
}

function toolNameImpliesProject(name: string) {
  return name.includes('write_project_file')
    || name.includes('ensure_project_scaffold')
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
      && isMakersDevCommand(activity.inputSummary || ''),
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

async function loadProjectResumeHistory(context: any, conversationId: string) {
  const [record, jsonl, model] = await Promise.all([
    getConversationRecord(context, conversationId),
    loadTranscriptJsonl(context, conversationId),
    getModelPreference(context, conversationId),
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
    gatewayNeeded: state.gatewayPromptPending === true,
  };
}

async function republishPreviewOnResume(context: any, state: ProjectState) {
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
        state.previewUrl = rewritten;
        state.sandboxDebugUrl = warmLinks.sandboxDebugUrl || state.sandboxDebugUrl;
        return {
          url: rewritten,
          sandboxDebugUrl: state.sandboxDebugUrl,
          restarted: false,
        };
      }
    }

    const warmLinks = await resolvePublicLinks(context);
    if (warmLinks.previewUrl) {
      state.previewUrl = warmLinks.previewUrl;
      state.sandboxDebugUrl = warmLinks.sandboxDebugUrl;
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
  state.previewUrl = links.previewUrl;
  state.sandboxDebugUrl = links.sandboxDebugUrl;
  return {
    url: links.previewUrl,
    sandboxDebugUrl: links.sandboxDebugUrl,
    restarted: true,
  };
}

async function runWorkspaceRestoreBody(context: any, conversationId: string) {
  const [storedState, chatTask, jsonl] = await Promise.all([
    getProjectState(context, conversationId),
    getChatTask(context, conversationId),
    loadTranscriptJsonl(context, conversationId),
  ]);
  const activityHistory = projectTranscript(jsonl, storedState.appDir);
  const restored = await restoreProjectWorkspace(context, conversationId, { mode: 'resume' });
  const state = restored.state;
  const hadPreview = projectStateImpliesPreview(state, activityHistory);
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
  const shouldRestartPreview = !generationActive && hasFileItems && hadPreview;

  let preview: {
    url?: string;
    sandboxDebugUrl?: string;
    error?: string;
    restarted?: boolean;
    kind?: 'sandbox' | 'makers';
  } = {};
  if (shouldRestartPreview) {
    try {
      preview = await withTimeout(
        republishPreviewOnResume(context, state),
        PREVIEW_RESTART_BUDGET_MS,
        'preview resume',
      );
      state.previewPublished = true;
    } catch (error) {
      state.previewUrl = undefined;
      state.sandboxDebugUrl = undefined;
      console.warn(
        '[resume:workspace] preview restart failed:',
        error instanceof Error ? error.message : error,
      );
      preview = {};
    }
  } else if (!generationActive && !hadPreview) {
    state.previewUrl = undefined;
    state.sandboxDebugUrl = undefined;
    state.previewKind = undefined;
  }

  try {
    await saveProjectState(context, conversationId, state);
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
    ...(hasFileItems ? { download: { url: '/download', filename: 'source.zip' } } : {}),
  };
}

async function runPreviewRefreshBody(context: any, conversationId: string) {
  const [storedState, jsonl] = await Promise.all([
    getProjectState(context, conversationId),
    loadTranscriptJsonl(context, conversationId),
  ]);
  const state = separateLegacyMakersDeployment(storedState);
  const hadPreview = projectStateImpliesPreview(state, projectTranscript(jsonl, state.appDir));
  if (!hadPreview) {
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
    state.previewPublished = true;
    try {
      await saveProjectState(context, conversationId, state);
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

export async function runProjectResumePreviewPipeline(context: any): Promise<Response> {
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
  context: any,
  conversationId: string,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  try {
    const workspace = await withTimeout(
      runWorkspaceRestoreBody(context, conversationId),
      WORKSPACE_RESUME_BUDGET_MS,
      'workspace resume',
    );
    if (signal?.aborted) return;
    yield sseEvent({ type: 'resume_workspace', data: workspace });

    const fileItems = workspace.files?.items || [];
    if (!signal?.aborted && fileItems.length > 0) {
      const contents = await loadResumeFileContents(context, conversationId, fileItems);
      for (const file of contents) {
        if (signal?.aborted) return;
        yield sseEvent({ type: 'resume_file_content', data: file });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Workspace resume failed.';
    console.warn('[resume:stream]', message);
    if (!signal?.aborted) {
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

export async function createProjectResumeStreamResponse(context: any): Promise<Response> {
  const { conversationId } = resolveConversationId(context, { allowQuery: true });
  if (!conversationId) {
    return jsonResponse({ ok: false, error: 'missing conversation_id' }, 400);
  }

  return createSSEResponse(async function* (signal) {
    const history = await loadProjectResumeHistory(context, conversationId);
    yield sseEvent({ type: 'resume_history', data: history });

    if (signal?.aborted) return;

    const storedTask = await getChatTask(context, conversationId);
    const liveTask = isChatTaskActive(storedTask) && hasLiveChatTask(conversationId, storedTask.id)
      ? storedTask
      : null;
    const generators: Array<AsyncGenerator<string>> = [];
    if (history.needsWorkspace) {
      generators.push(iterateWorkspaceResumeEvents(context, conversationId, signal));
    }
    if (liveTask) {
      generators.push(iterateLiveChatTaskEvents(context, conversationId, liveTask, undefined, signal));
    }
    if (generators.length === 0) return;
    yield* mergeSseGenerators(generators, signal);
  }, context?.request?.signal);
}
