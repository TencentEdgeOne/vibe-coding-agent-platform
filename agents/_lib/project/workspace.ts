import { requireSandbox, type AgentContext } from '../runtime/context.ts';
import { getProjectState } from '../session/store.ts';
import { getFileTree } from './fs.ts';
import { restorePersistedProject } from './persistence.ts';
import { separateLegacyMakersDeployment } from './state.ts';
import { markCreated, persistWorkspace } from './workspace-store.ts';
import { repairNestedAppDirLayout } from './layout.ts';
import type { ProjectState, StreamSend } from '../types.ts';
import { withTimeout } from '../turn/checkpoint.ts';
import { timeStage } from '../utils/timing.ts';

const SANDBOX_PROBE_MS = 15_000;
const RESTORE_BUDGET_MS = 45_000;
/** Long enough for a user to send their first message, short enough to expire an abandoned visit. */
const FRESH_WORKSPACE_TTL_MS = 5 * 60 * 1000;

/**
 * GET /session?mode=create already proved the workspace is empty and created
 * its directories, and the first POST /prompt lands on the same process. The
 * entry is consumed on read, so a second restore — or anything that ran in
 * between — probes the sandbox again.
 */
const freshWorkspaces = new Map<string, { appDir: string; markedAt: number }>();

export function markFreshWorkspace(conversationId: string, appDir: string) {
  const markedAt = Date.now();
  // An abandoned visit never comes back to consume its entry, so expire on write.
  for (const [key, entry] of freshWorkspaces) {
    if (markedAt - entry.markedAt >= FRESH_WORKSPACE_TTL_MS) freshWorkspaces.delete(key);
  }
  freshWorkspaces.set(conversationId, { appDir, markedAt });
}

function takeFreshWorkspace(conversationId: string, appDir: string) {
  const entry = freshWorkspaces.get(conversationId);
  if (!entry) return false;
  freshWorkspaces.delete(conversationId);
  return entry.appDir === appDir && Date.now() - entry.markedAt < FRESH_WORKSPACE_TTL_MS;
}

export async function ensureWorkspaceDirectories(context: AgentContext, state: ProjectState) {
  const files = requireSandbox(context).files;
  await Promise.all([
    files.makeDir(state.sessionDir),
    files.makeDir(state.appDir),
  ]);
}

async function probeSandboxHasFiles(context: AgentContext, state: ProjectState) {
  if (!(await requireSandbox(context).files.exists(state.appDir))) return false;
  const tree = await getFileTree(context, state);
  return tree.some((item) => item.type === 'file');
}

/**
 * Restore the volatile sandbox from Blob-backed persist, used both before a
 * prompt and when GET /session rebuilds the workspace.
 */
export async function restoreProjectWorkspace(
  context: AgentContext,
  conversationId: string,
  options: { send?: StreamSend; mode?: 'prepare' | 'resume' } = {},
): Promise<{ state: ProjectState; hasFiles: boolean; restoreError?: string }> {
  const state = separateLegacyMakersDeployment(await getProjectState(context, conversationId));
  if (takeFreshWorkspace(conversationId, state.appDir)) {
    return { state, hasFiles: false };
  }
  await repairNestedAppDirLayout(context, state);
  const send = options.send;
  let hasFiles = false;
  let restoreError: string | undefined;

  try {
    hasFiles = await timeStage('workspace:restore', { phase: 'probe' }, () => withTimeout(
      probeSandboxHasFiles(context, state),
      SANDBOX_PROBE_MS,
      'sandbox file probe',
    ));
  } catch (error) {
    hasFiles = false;
    restoreError = error instanceof Error ? error.message : 'Sandbox probe failed.';
  }

  if (!hasFiles) {
    try {
      const restored = await timeStage('workspace:restore', { phase: 'snapshot' }, () => withTimeout(
        restorePersistedProject(context, conversationId, state, {
          installDependencies: options.mode !== 'resume',
        }),
        RESTORE_BUDGET_MS,
        'snapshot restore',
      ));
      hasFiles = restored.restored;
      if (!restored.restored) restoreError = restored.error;
    } catch (error) {
      hasFiles = false;
      restoreError = error instanceof Error ? error.message : 'Snapshot restore failed.';
    }
  }

  try {
    await ensureWorkspaceDirectories(context, state);
  } catch (error) {
    send?.({
      type: 'error',
      error: error instanceof Error ? error.message : 'Workspace directory creation failed.',
    });
  }

  if (hasFiles) markCreated(state);
  if (hasFiles) {
    try {
      await persistWorkspace(context, conversationId, state);
    } catch {
      // The sandbox files are still the working copy for this turn.
    }
  }

  return { state, hasFiles, restoreError };
}

export async function prepareProjectWorkspace(
  context: AgentContext,
  conversationId: string,
  send?: StreamSend,
): Promise<ProjectState> {
  const restored = await restoreProjectWorkspace(context, conversationId, {
    send,
    mode: 'prepare',
  });
  return restored.state;
}
