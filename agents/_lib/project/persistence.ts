import type { ProjectState } from '../types.ts';
import { restoreProjectArchive } from './archive.ts';
import { runSandboxCommand } from './commands.ts';

export async function restorePersistedProject(
  context: any,
  conversationId: string,
  state: ProjectState,
  options: { installDependencies?: boolean } = {},
): Promise<{ restored: boolean; error?: string }> {
  try {
    const restored = await context.sandbox.restore({ path: state.appDir });
    if (restored?.restored) {
      if (options.installDependencies !== false) await installDependencies(context, state);
      return { restored: true };
    }
  } catch (error) {
    return { restored: false, error: error instanceof Error ? error.message : String(error) };
  }
  return { restored: false };
}

async function installDependencies(context: any, state: ProjectState) {
  if (!(await context.sandbox.files.exists(`${state.appDir}/package.json`))) return;
  if (await context.sandbox.files.exists(`${state.appDir}/node_modules`)) return;
  await runSandboxCommand(context, 'npm install --no-audit --no-fund', {
    cwd: state.appDir,
    timeout: 300,
  });
}

export { restoreProjectArchive };
