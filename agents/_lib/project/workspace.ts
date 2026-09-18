import { getProjectState, saveProjectState } from '../session/store.ts';
import { getFileTree } from './fs.ts';
import { restorePersistedProject } from './persistence.ts';
import { separateLegacyMakersDeployment } from './state.ts';
import type { ProjectState, StreamSend } from '../types.ts';
import { withTimeout } from '../turn/checkpoint.ts';

const SANDBOX_PROBE_MS = 15_000;
const RESTORE_BUDGET_MS = 45_000;

async function ensureWorkspaceDirectories(context: any, state: ProjectState) {
  await context.sandbox.files.makeDir(state.sessionDir);
  await context.sandbox.files.makeDir(state.appDir);
}

async function probeSandboxHasFiles(context: any, state: ProjectState) {
  if (!(await context.sandbox.files.exists(state.appDir))) return false;
  const tree = await getFileTree(context, state);
  return tree.some((item) => item.type === 'file');
}

/**
 * Restore the volatile sandbox from Blob-backed persist, used both before a
 * prompt and when GET /session rebuilds the workspace.
 */
export async function restoreProjectWorkspace(
  context: any,
  conversationId: string,
  options: { send?: StreamSend; mode?: 'prepare' | 'resume' } = {},
): Promise<{ state: ProjectState; hasFiles: boolean; restoreError?: string }> {
  const state = separateLegacyMakersDeployment(await getProjectState(context, conversationId));
  const send = options.send;
  let hasFiles = false;
  let restoreError: string | undefined;

  try {
    hasFiles = await withTimeout(
      probeSandboxHasFiles(context, state),
      SANDBOX_PROBE_MS,
      'sandbox file probe',
    );
  } catch (error) {
    hasFiles = false;
    restoreError = error instanceof Error ? error.message : 'Sandbox probe failed.';
  }

  if (!hasFiles) {
    try {
      const restored = await withTimeout(
        restorePersistedProject(context, conversationId, state, {
          installDependencies: options.mode !== 'resume',
        }),
        RESTORE_BUDGET_MS,
        'snapshot restore',
      );
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

  if (hasFiles) state.created = true;
  if (hasFiles) {
    try {
      await saveProjectState(context, conversationId, state);
    } catch {
      // The sandbox files are still the working copy for this turn.
    }
  }

  return { state, hasFiles, restoreError };
}

export async function prepareProjectWorkspace(
  context: any,
  conversationId: string,
  send?: StreamSend,
): Promise<ProjectState> {
  const restored = await restoreProjectWorkspace(context, conversationId, {
    send,
    mode: 'prepare',
  });
  return restored.state;
}
