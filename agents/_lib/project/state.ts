import type { ProjectState } from '../types.ts';
import { requireSandbox, type SandboxCapable } from '../runtime/context.ts';
import { safeSegment } from '../utils/paths.ts';
import { runSandboxCommand } from './commands.ts';
import { resetWorkspaceFields } from './workspace-store.ts';

export { separateLegacyMakersDeployment } from './workspace-store.ts';

export function createProjectState(conversationId: string): ProjectState {
  const sessionDir = `projects/${safeSegment(conversationId)}`;
  return {
    created: false,
    sessionDir,
    appDir: `${sessionDir}/app`,
  };
}

export async function resetProjectWorkspace(
  context: SandboxCapable,
  state: ProjectState,
) {
  assertResettableProjectPath(state);

  const sandbox = requireSandbox(context);

  await sandbox.files.makeDir(state.sessionDir);

  const appDirExists = await sandbox.files.exists(state.appDir);
  if (appDirExists) {
    if (typeof sandbox.files.remove === 'function') {
      await sandbox.files.remove(state.appDir);
    } else {
      const result = await runSandboxCommand(context, 'rm -rf app', {
        cwd: state.sessionDir,
        timeout: 60,
      });
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || result.stdout || 'Failed to initialize the project workspace.');
      }
    }
  }

  await sandbox.files.makeDir(state.appDir);
  resetWorkspaceFields(state);
  return appDirExists;
}

export function assertResettableProjectPath(state: ProjectState) {
  if (state.appDir !== `${state.sessionDir}/app`) {
    throw new Error(`Refusing to operate on an unexpected project path: ${state.appDir}`);
  }
  if (!/^projects\/[a-zA-Z0-9_-]+$/.test(state.sessionDir)) {
    throw new Error(`Refusing to operate on an unexpected session path: ${state.sessionDir}`);
  }
  if (!/^projects\/[a-zA-Z0-9_-]+\/app$/.test(state.appDir)) {
    throw new Error(`Refusing to operate on an unexpected project path: ${state.appDir}`);
  }
}
