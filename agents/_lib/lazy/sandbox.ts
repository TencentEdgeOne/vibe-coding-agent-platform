/**
 * The sandbox is a VM. Nothing may touch it until a real operation asks, and
 * the first touch is this function: extend the timeout, make the directories,
 * and pull code back when a previous visit left a snapshot.
 *
 * npm install starts here but is not awaited. Preview and deploy join
 * `dependenciesReady`; a coding turn must not sit behind it.
 */
import { requireSandbox, type AgentContext } from '../runtime/context.ts';
import { getProjectState } from '../session/store.ts';
import type { ProjectState, StreamSend } from '../types.ts';
import { runSandboxCommand } from '../project/commands.ts';
import { getFileTree } from '../project/fs.ts';
import { repairNestedAppDirLayout } from '../project/layout.ts';
import { restorePersistedProject } from '../project/persistence.ts';
import { separateLegacyMakersDeployment } from '../project/state.ts';
import { markCreated, persistWorkspace } from '../project/workspace-store.ts';
import { followSandboxLog, formatPreviewProgress } from '../project/preview.ts';
import { shellQuote } from '../utils/shell.ts';
import { withTimeout } from '../utils/timeout.ts';
import { timeStage } from '../utils/timing.ts';
import { READINESS_BUDGET_MS, SANDBOX_EXTENSION_SECONDS } from './budgets.ts';
import { once, settled } from './inflight.ts';

export type SandboxHandle = {
  state: ProjectState;
  hasFiles: boolean;
  restoreError?: string;
  /** Resolves when dependencies are installed, or immediately when there are none. */
  dependenciesReady: Promise<boolean>;
};

/**
 * Conversations whose sandbox this process has already booted.
 * Stop uses it to avoid persisting — and therefore booting — a sandbox that
 * was never started on this instance.
 */
const activatedConversations = new Set<string>();

export function sandboxWasActivated(conversationId: string) {
  return activatedConversations.has(conversationId);
}

/**
 * Files confirmed present for this sandbox object. A new VM is a new object,
 * so the next activation probes and restores again. The cached value is the
 * identity, not `ProjectState` — that object stays per request.
 */
const generations = new Map<string, { sandbox: object; appDir: string }>();

function sameGeneration(conversationId: string, sandbox: object, appDir: string) {
  const entry = generations.get(conversationId);
  return entry?.sandbox === sandbox && entry.appDir === appDir;
}

function rememberGeneration(conversationId: string, sandbox: object, appDir: string) {
  generations.set(conversationId, { sandbox, appDir });
}

/**
 * A chat task record is written before the first prompt touches the sandbox,
 * so "a blob row exists" is not evidence that code is waiting to be restored.
 * Only a project that was actually created, previewed, or deployed can have a
 * snapshot.
 */
function projectMayNeedRestore(state: ProjectState) {
  return Boolean(
    state.created
    || state.previewPublished
    || state.previewUrl
    || state.deployment,
  );
}

type InstallJob = {
  promise: Promise<boolean>;
  report?: (text: string) => void;
};

const installs = new Map<string, InstallJob>();

const NPM_INSTALL_LOG = '/tmp/edgeone-npm-install.log';

/**
 * Join the install this activation already started, or start one.
 * A second caller for the same project directory waits on the same promise
 * instead of running npm twice. Failure is dropped from the map so the next
 * caller can retry; success is dropped too, and the next call rechecks
 * `node_modules` rather than trusting a sandbox that may have been replaced.
 */
export function dependenciesReady(
  context: AgentContext,
  state: ProjectState,
  options: { onProgress?: (text: string) => void } = {},
): Promise<boolean> {
  const key = state.appDir;
  const existing = installs.get(key);
  if (existing) {
    if (options.onProgress) existing.report = options.onProgress;
    return existing.promise;
  }

  const job: InstallJob = {
    promise: Promise.resolve(true),
    report: options.onProgress,
  };
  job.promise = once(context, `dependencies:${key}`, () => installDependencies(context, state, job))
    .finally(() => {
      if (installs.get(key) === job) installs.delete(key);
    });
  installs.set(key, job);
  return job.promise;
}

async function installDependencies(
  context: AgentContext,
  state: ProjectState,
  job: InstallJob,
): Promise<boolean> {
  const files = requireSandbox(context).files;
  if (!(await files.exists(`${state.appDir}/package.json`))) return true;
  if (await files.exists(`${state.appDir}/node_modules`)) return true;

  const report = (text: string) => job.report?.(text);
  if (!job.report) {
    const installed = await runSandboxCommand(context, 'npm install --no-audit --no-fund', {
      cwd: state.appDir,
      timeout: READINESS_BUDGET_MS.dependencies / 1000,
    });
    return installed.exitCode === 0;
  }

  report(formatPreviewProgress('Installing dependencies'));
  let stopped = false;
  let detail = '';
  const following = followSandboxLog(context, NPM_INSTALL_LOG, () => stopped, (tail) => {
    detail = tail;
    report(formatPreviewProgress('Installing dependencies', tail));
  });
  let installed: Awaited<ReturnType<typeof runSandboxCommand>>;
  try {
    installed = await runSandboxCommand(
      context,
      `npm install --no-audit --no-fund > ${NPM_INSTALL_LOG} 2>&1`,
      {
        cwd: state.appDir,
        timeout: READINESS_BUDGET_MS.dependencies / 1000,
      },
    );
  } finally {
    stopped = true;
    await following;
  }
  if (installed.exitCode !== 0) {
    throw new Error(detail.trim() || 'npm install failed');
  }
  return true;
}

function directoryAlreadyExists(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '');
  return /file exists|\bEEXIST\b|already exists/i.test(message);
}

/**
 * `files.makeDir` walks every ancestor and treats an existing one as failure.
 * `/home/user/projects` is shared by every conversation on the VM, so creating
 * `projects/{id}/app` dies with "file exists" once that parent is there.
 * The two directories also cannot be created together: both calls mkdir the
 * same parent, and the loser gets that error.
 */
async function ensureDir(context: AgentContext, path: string) {
  const files = requireSandbox(context).files;
  try {
    await files.makeDir(path);
  } catch (error) {
    if (await files.exists(path).catch(() => false)) return;
    if (!directoryAlreadyExists(error)) throw error;
    const created = await runSandboxCommand(context, `mkdir -p ${shellQuote(path)}`, { timeout: 15 });
    if (created.exitCode === 0) return;
    if (await files.exists(path).catch(() => false)) return;
    throw error;
  }
}

async function ensureWorkspaceDirectories(context: AgentContext, state: ProjectState) {
  await ensureDir(context, state.sessionDir);
  await ensureDir(context, state.appDir);
}

async function extendSandboxTimeout(context: AgentContext) {
  const sandbox = context?.sandbox;
  if (!sandbox || typeof sandbox.extendTimeout !== 'function') return;
  try {
    await sandbox.extendTimeout(SANDBOX_EXTENSION_SECONDS);
  } catch (error) {
    console.warn('[sandbox]', {
      stage: 'extend-timeout-failed',
      seconds: SANDBOX_EXTENSION_SECONDS,
      error: error instanceof Error ? error.message : String(error || ''),
    });
  }
}

async function probeSandboxHasFiles(context: AgentContext, state: ProjectState) {
  if (!(await requireSandbox(context).files.exists(state.appDir))) return false;
  const tree = await getFileTree(context, state);
  return tree.some((item) => item.type === 'file');
}

export function activateSandbox(
  context: AgentContext,
  conversationId: string,
  options: { send?: StreamSend } = {},
): Promise<SandboxHandle> {
  return settled(context, `activate:${conversationId}`, () => timeStage(
    'sandbox:activate',
    { conversationId },
    () => activate(context, conversationId, options),
  ));
}

async function activate(
  context: AgentContext,
  conversationId: string,
  options: { send?: StreamSend },
): Promise<SandboxHandle> {
  activatedConversations.add(conversationId);
  const state = separateLegacyMakersDeployment(await getProjectState(context, conversationId));
  const sandbox = context.sandbox;
  if (sandbox && sameGeneration(conversationId, sandbox, state.appDir)) {
    await extendSandboxTimeout(context);
    return {
      state,
      hasFiles: true,
      dependenciesReady: dependenciesReady(context, state),
    };
  }

  await extendSandboxTimeout(context);
  await ensureWorkspaceDirectories(context, state);

  // A brand-new conversation has nothing to probe or unpack. The chat task
  // record may already exist; that is not a snapshot.
  if (!projectMayNeedRestore(state)) {
    return {
      state,
      hasFiles: false,
      dependenciesReady: Promise.resolve(true),
    };
  }

  await repairNestedAppDirLayout(context, state);

  let hasFiles = false;
  let restoreError: string | undefined;
  try {
    hasFiles = await timeStage('workspace:restore', { phase: 'probe' }, () => withTimeout(
      probeSandboxHasFiles(context, state),
      READINESS_BUDGET_MS.probe,
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
          installDependencies: false,
        }),
        READINESS_BUDGET_MS.restore,
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
    options.send?.({
      type: 'error',
      error: error instanceof Error ? error.message : 'Workspace directory creation failed.',
    });
  }

  if (hasFiles) {
    markCreated(state);
    if (sandbox) rememberGeneration(conversationId, sandbox, state.appDir);
    try {
      await persistWorkspace(context, conversationId, state);
    } catch {
      // The sandbox files are still the working copy for this turn.
    }
  }

  return {
    state,
    hasFiles,
    restoreError,
    dependenciesReady: hasFiles
      ? dependenciesReady(context, state)
      : Promise.resolve(true),
  };
}
