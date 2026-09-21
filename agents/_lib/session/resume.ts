import type { AgentContext } from '../runtime/context.ts';
import {
  getChatTask,
  getConversationRecord,
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
import { timeStage } from '../utils/timing.ts';

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
  const [record, jsonl] = await Promise.all([
    getConversationRecord(context, conversationId),
    loadTranscriptJsonl(context, conversationId),
  ]);
  const model = record.modelPreference?.trim() || '';
  const storedLanguage = record.languagePreference;
  const language = storedLanguage === 'zh' || storedLanguage === 'en' ? storedLanguage : '';
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

  const depsReady = await timeStage(
    'resume:preview',
    { phase: 'dependencies' },
    () => ensureProjectDependencies(context, state),
  );
  if (!depsReady) {
    throw new Error('Project dependencies are not available for preview resume.');
  }

  const server = await timeStage(
    'resume:preview',
    { phase: 'server' },
    () => startPreviewServer(context, state),
  );
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

type WorkspaceRestore = {
  state: ProjectState;
  hasFiles: boolean;
  items: FileTreeItem[];
  hasFileItems: boolean;
  restoreError?: string;
  generationActive: boolean;
};

type WorkspacePreviewLink = {
  url?: string;
  sandboxDebugUrl?: string;
  error?: string;
  restarted?: boolean;
  kind?: 'sandbox' | 'makers';
};

/**
 * Whether the restore is going to rebuild the preview at all. A turn still in
 * flight owns the dev server, and an empty project has nothing to serve, so in
 * both cases the preview stage is skipped rather than reported as a failure.
 */
function willRestorePreview(restore: WorkspaceRestore) {
  return restore.hasFiles && !restore.generationActive && restore.hasFileItems;
}

/**
 * Everything the Code tab needs, and nothing that waits on the preview. Pulling
 * the snapshot down is the only unavoidable cost here: a cold sandbox spends
 * minutes on `npm install` and a dev server boot before a preview link exists,
 * and the file listing must not travel with that.
 */
async function restoreWorkspaceFiles(
  context: AgentContext,
  conversationId: string,
): Promise<WorkspaceRestore> {
  const chatTask = await getChatTask(context, conversationId);
  const restored = await restoreProjectWorkspace(context, conversationId, { mode: 'resume' });
  const state = restored.state;
  const generationActive = isChatTaskActive(chatTask) && hasLiveChatTask(conversationId, chatTask.id);

  let items: FileTreeItem[] = [];
  if (restored.hasFiles) {
    try {
      items = await withTimeout(getFileTree(context, state), SANDBOX_PROBE_MS, 'file tree');
    } catch {
      items = [];
    }
  }

  return {
    state,
    hasFiles: restored.hasFiles,
    items,
    hasFileItems: items.some((item) => item.type === 'file'),
    restoreError: restored.restoreError,
    generationActive,
  };
}

function workspaceFilesPayload(conversationId: string, restore: WorkspaceRestore) {
  if (!restore.hasFiles) {
    return {
      ok: true as const,
      stage: 'workspace' as const,
      conversation_id: conversationId,
      hasProject: false,
      preview: restore.restoreError ? { error: restore.restoreError } : {},
      deployment: restore.state.deployment,
      files: { root: restore.state.appDir, items: [] as FileTreeItem[] },
    };
  }

  return {
    ok: true as const,
    stage: 'workspace' as const,
    conversation_id: conversationId,
    hasProject: restore.hasFileItems || Boolean(restore.state.created),
    deployment: restore.state.deployment,
    files: { root: restore.state.appDir, items: restore.items },
    gatewayNeeded: restore.state.gatewayPromptPending === true,
    gatewaySkipped: restore.state.gatewaySkipped === true,
    ...(restore.hasFileItems ? { download: { url: '/download', filename: 'source.zip' } } : {}),
  };
}

async function restoreWorkspacePreview(
  context: AgentContext,
  conversationId: string,
  restore: WorkspaceRestore,
): Promise<WorkspacePreviewLink> {
  // Nothing was pulled down, so there is no preview to restart — the restore
  // error, if any, is still the whole answer the panel needs.
  if (!restore.hasFiles) {
    return restore.restoreError ? { error: restore.restoreError } : {};
  }

  let preview: WorkspacePreviewLink = {};
  if (willRestorePreview(restore)) {
    try {
      preview = await withTimeout(
        republishPreviewOnResume(context, restore.state),
        PREVIEW_RESTART_BUDGET_MS,
        'preview resume',
      );
    } catch (error) {
      clearPreview(restore.state);
      console.warn(
        '[resume:workspace] preview restart failed:',
        error instanceof Error ? error.message : error,
      );
      preview = {};
    }
  }

  try {
    await persistWorkspace(context, conversationId, restore.state);
  } catch {
    // Non-fatal — the files payload is already on screen.
  }

  return preview;
}

async function runWorkspaceRestoreBody(context: AgentContext, conversationId: string) {
  const restore = await restoreWorkspaceFiles(context, conversationId);
  return {
    ...workspaceFilesPayload(conversationId, restore),
    preview: await restoreWorkspacePreview(context, conversationId, restore),
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
    const restore = await timeStage('session:prep', { mode, stage: 'workspace' }, () => withTimeout(
      restoreWorkspaceFiles(context, conversationId),
      WORKSPACE_RESUME_BUDGET_MS,
      'workspace resume',
    ));
    if (signal?.aborted) return;

    // Files land first and close the workspace stage, so the Code tab stops
    // waiting on a preview that a cold sandbox can spend minutes rebuilding.
    const files = workspaceFilesPayload(conversationId, restore);
    yield sseEvent({ type: 'resume_workspace', data: files });
    yield sessionPrepSse(mode, 'workspace', 'done');

    const paths = files.files.items.filter((item) => item.type === 'file').map((item) => item.path);
    if (!signal?.aborted && paths.length > 0) {
      yield sseEvent({ type: 'file_changed', data: { paths } });
    }

    if (signal?.aborted) return;
    if (!willRestorePreview(restore)) return;
    yield sessionPrepSse(mode, 'preview', 'running');
    const preview = await restoreWorkspacePreview(context, conversationId, restore);
    if (signal?.aborted) return;
    // Preview only: the tree already landed above, and re-sending it here would
    // remount the listing the user is reading.
    if (preview.url || preview.error) {
      yield sseEvent({
        type: 'resume_workspace',
        data: {
          ok: true,
          stage: 'workspace',
          conversation_id: conversationId,
          preview,
        },
      });
    }
    yield sessionPrepSse(mode, 'preview', preview.url ? 'done' : 'failed');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Workspace resume failed.';
    console.warn('[resume:stream]', message);
    if (!signal?.aborted) {
      yield sessionPrepSse(mode, 'workspace', 'failed');
      yield sessionPrepSse(mode, 'preview', 'failed');
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
    if (mode === 'create') {
      // The preference write no longer gates the sandbox and the CLI: the model
      // is handed to the warmup instead of being read back afterwards. Language
      // needs no hand-off — the prompt tells the model to follow the user's own
      // language, so the preference is a display concern only.
      yield* mergeSseGenerators([
        iterateConversationPrep(context, conversationId, { mode, model, language, signal }),
        iterateSandboxAndAgentPrep(context, conversationId, {
          mode,
          model,
          signal,
        }),
      ], signal);
      if (!signal?.aborted) yield sessionPrepSse(mode, 'ready', 'done');
      return;
    }

    yield* iterateConversationPrep(context, conversationId, { mode, model, language, signal });
    if (signal?.aborted) return;

    // The warmup needs the model before the transcript parse finishes, and the
    // record carries it, so the two now run side by side.
    const record = await getConversationRecord(context, conversationId);
    const historyPromise = timeStage(
      'session:prep',
      { mode, stage: 'history' },
      () => loadProjectResumeHistory(context, conversationId),
    );
    async function* iterateHistoryEvent(): AsyncGenerator<string> {
      const loaded = await historyPromise;
      if (signal?.aborted) return;
      yield sseEvent({ type: 'resume_history', data: loaded });
    }

    yield* mergeSseGenerators([
      iterateSandboxAndAgentPrep(context, conversationId, {
        mode,
        model: model || (record.modelPreference || '').trim(),
        signal,
      }),
      iterateHistoryEvent(),
    ], signal);
    if (signal?.aborted) return;

    // Restarting the preview can cost minutes of npm install and dev server
    // polling. The client unblocks here and shows local loading for the file
    // tree and the preview, so neither holds the first screen.
    yield sessionPrepSse(mode, 'ready', 'done');

    const history = await historyPromise;
    if (history.needsWorkspace) {
      yield* iterateWorkspaceResumeEvents(context, conversationId, mode, signal);
    }
    if (signal?.aborted) return;

    const storedTask = await getChatTask(context, conversationId);
    if (isChatTaskActive(storedTask) && hasLiveChatTask(conversationId, storedTask.id)) {
      yield* iterateLiveChatTaskEvents(context, conversationId, storedTask, undefined, signal);
    }
  }, context?.request?.signal);
}
