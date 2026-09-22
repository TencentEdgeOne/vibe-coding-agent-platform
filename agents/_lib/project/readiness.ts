/**
 * The readiness layer: what an entry point needs, not how to get there.
 *
 * Every route that touches a live project — GET /session, POST /prompt,
 * POST /preview, POST /deploy, and the agent's own tools — needs some prefix of
 * the same chain: a live sandbox, then project files in it, then dependencies,
 * then a dev server, then a public URL. Each of those used to be re-derived by
 * its callers, so "bring the preview back" was written five separate times with
 * five different fallback orders, and two of them disagreed about whether a
 * project with no package.json could have a preview at all.
 *
 * The functions below are that chain, one level per step. They are idempotent,
 * they are deduplicated for the life of a request, and each one calls the level
 * under it rather than trusting the caller to have done so. A caller declares
 * `ensurePreview` and is done; whether that ends up rotating a token or paying
 * for npm install and a dev server boot is not its problem.
 */
import { requireSandbox, type AgentContext } from '../runtime/context.ts';
import { PREVIEW_PUBLIC_PORT } from '../constants.ts';
import { isMakersDeployUrl } from '../../../shared/makers-url.ts';
import { getProjectState } from '../session/store.ts';
import type { FileTreeItem, ProjectState, StreamSend } from '../types.ts';
import type { PreviewKind } from '../../../shared/protocol.ts';
import { getFileTree } from './fs.ts';
import { runSandboxCommand } from './commands.ts';
import { repairNestedAppDirLayout } from './layout.ts';
import { restorePersistedProject } from './persistence.ts';
import { separateLegacyMakersDeployment } from './state.ts';
import { markCreated, persistWorkspace, publishPreview } from './workspace-store.ts';
import {
  assertPreviewServerReady,
  isPreviewServerReady,
  resolvePublicLinks,
  rewritePreviewAccessToken,
  startPreviewServer,
} from './preview.ts';
import { withTimeout } from '../utils/timeout.ts';
import { timeStage } from '../utils/timing.ts';

/**
 * One home for the budgets. They were spread across the callers, which made it
 * impossible to see that the preview budget has to leave room for the install
 * and the dev server boot that happen inside it.
 */
export const READINESS_BUDGET_MS = {
  /** A `find` against a sandbox that is up. Not a restore. */
  probe: 15_000,
  /** Pulling the Blob archive down and unpacking it. */
  restore: 45_000,
  /** npm install on a cold workspace. */
  dependencies: 300_000,
  /** Install plus dev server boot plus the route gates, worst case. */
  preview: 540_000,
  /** Everything a cold resume does before the panel has files and a preview. */
  workspace: 600_000,
} as const;

const SANDBOX_EXTENSION_SECONDS = 1800;

/**
 * In-flight work, scoped to the request object.
 *
 * A single chat turn asks for a preview from up to four places, and the last of
 * them used to carry a hand-rolled `hostPreviewInFlight` guard that the other
 * three did not. Keying on the request means every level inherits that guard,
 * and means the memo cannot outlive the request or leak across conversations —
 * the same reason the conversation record memo is a WeakMap on the context.
 *
 * Deliberately per-request: two concurrent requests hold two different
 * `ProjectState` objects, so sharing a promise between them would hand one
 * request's state to the other's persist.
 */
const inFlight = new WeakMap<object, Map<string, Promise<unknown>>>();

function trackerFor(context: object) {
  let pending = inFlight.get(context);
  if (!pending) {
    pending = new Map();
    inFlight.set(context, pending);
  }
  return pending;
}

/** Share concurrent work, then forget it, so the next caller re-checks. */
function once<T>(context: object, key: string, run: () => Promise<T>): Promise<T> {
  if (!context || typeof context !== 'object') return run();
  const pending = trackerFor(context);
  const existing = pending.get(key);
  if (existing) return existing as Promise<T>;
  const entry: { promise?: Promise<T> } = {};
  entry.promise = run().finally(() => {
    if (pending.get(key) === entry.promise) pending.delete(key);
  });
  pending.set(key, entry.promise);
  return entry.promise;
}

/**
 * Share the answer for the rest of the request.
 *
 * For the levels whose answer cannot stop being true once it is: a sandbox
 * whose timeout was extended and whose directories exist stays that way for the
 * few seconds a request lives. A rejection is dropped rather than kept, so a
 * failed level can be retried within the same request.
 */
function settled<T>(context: object, key: string, run: () => Promise<T>): Promise<T> {
  if (!context || typeof context !== 'object') return run();
  const pending = trackerFor(context);
  const existing = pending.get(key);
  if (existing) return existing as Promise<T>;
  const entry: { promise?: Promise<T> } = {};
  entry.promise = run().catch((error) => {
    if (pending.get(key) === entry.promise) pending.delete(key);
    throw error;
  });
  pending.set(key, entry.promise);
  return entry.promise;
}

/**
 * `GET /session?mode=create` already proved the workspace is empty and made its
 * directories, and the first `POST /prompt` lands on the same instance. The
 * entry is consumed on read, so a second restore — or anything that ran in
 * between — probes the sandbox again.
 */
const freshWorkspaces = new Map<string, { appDir: string; markedAt: number }>();

/** Long enough for a user to send their first message, short enough to expire an abandoned visit. */
const FRESH_WORKSPACE_TTL_MS = 5 * 60 * 1000;

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

/** A deployed preview is a Makers URL, not a sandbox process: nothing to start, no token to rotate. */
function isMakersPreviewState(state: ProjectState) {
  return state.previewKind === 'makers' || isMakersDeployUrl(state.previewUrl);
}

async function ensureWorkspaceDirectories(context: AgentContext, state: ProjectState) {
  const files = requireSandbox(context).files;
  await Promise.all([
    files.makeDir(state.sessionDir),
    files.makeDir(state.appDir),
  ]);
}

/**
 * Level 1 — a sandbox that will still be alive at the end of the turn, with the
 * project directories in place and the stored state migrated.
 *
 * Held for the whole request: every level above this one starts by asking for
 * it, and re-extending a timeout and re-making two directories that already
 * exist is two sandbox round trips for an answer that has not changed.
 */
export function ensureSandbox(
  context: AgentContext,
  conversationId: string,
  options: { markFresh?: boolean } = {},
): Promise<ProjectState> {
  return settled(context, `sandbox:${conversationId}`, async () => {
    await extendSandboxTimeout(context);
    const state = separateLegacyMakersDeployment(await getProjectState(context, conversationId));
    await ensureWorkspaceDirectories(context, state);
    // Only a create visit knows the workspace is empty; a restore may still
    // have a snapshot to pull down, so its first prompt must keep probing.
    if (options.markFresh && !state.created) {
      markFreshWorkspace(conversationId, state.appDir);
    }
    return state;
  });
}

export type WorkspaceReadiness = {
  state: ProjectState;
  hasFiles: boolean;
  restoreError?: string;
};

/**
 * Level 2 — project files on disk in the sandbox, pulled back from the Blob
 * archive if this sandbox is a fresh one.
 *
 * `installDependencies` is the one real difference between the callers that
 * used to be spelled `mode: 'prepare' | 'resume'`: a resume wants the file
 * listing on screen before it pays for npm install, and a turn about to run the
 * agent wants dependencies there already. Both still get dependencies before
 * anything that needs them, because level 3 asks for them by name.
 */
export function ensureWorkspace(
  context: AgentContext,
  conversationId: string,
  options: { send?: StreamSend; installDependencies?: boolean } = {},
): Promise<WorkspaceReadiness> {
  return once(context, `workspace:${conversationId}`, async () => {
    const state = await ensureSandbox(context, conversationId);
    if (takeFreshWorkspace(conversationId, state.appDir)) {
      return { state, hasFiles: false };
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
            installDependencies: options.installDependencies !== false,
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
      try {
        await persistWorkspace(context, conversationId, state);
      } catch {
        // The sandbox files are still the working copy for this turn.
      }
    }

    return { state, hasFiles, restoreError };
  });
}

/** The file listing, or an empty one — a tree read must never fail a restore. */
export async function ensureFileTree(
  context: AgentContext,
  state: ProjectState,
): Promise<FileTreeItem[]> {
  try {
    return await withTimeout(getFileTree(context, state), READINESS_BUDGET_MS.probe, 'file tree');
  } catch {
    return [];
  }
}

/**
 * Level 3 — every dependency this project declares is installed.
 *
 * Only installs when the sandbox actually came back empty: a restored snapshot
 * carries source without node_modules, and both the dev server and the Makers
 * build need dependencies present.
 *
 * A project with no package.json is ready, because it declares nothing to
 * install. The old spelling of this returned false there, which read as failure
 * and is why a resume of a static site used to refuse to rebuild its preview
 * while the same site previewed fine inside a chat turn — the turn did not ask.
 */
export function ensureDependencies(
  context: AgentContext,
  state: ProjectState,
): Promise<boolean> {
  // Keyed by the directory rather than the conversation: the install is a
  // property of the tree it runs in, and that is what two callers would collide
  // over.
  return once(context, `dependencies:${state.appDir}`, async () => {
    const files = requireSandbox(context).files;
    if (!(await files.exists(`${state.appDir}/package.json`))) return true;
    if (await files.exists(`${state.appDir}/node_modules`)) return true;
    const installed = await runSandboxCommand(context, 'npm install --no-audit --no-fund', {
      cwd: state.appDir,
      timeout: READINESS_BUDGET_MS.dependencies / 1000,
    });
    return installed.exitCode === 0;
  });
}

export type PreviewReadiness = {
  url?: string;
  sandboxDebugUrl?: string;
  kind?: PreviewKind;
  /** The dev server was (re)started, so an open iframe is pointing at a dead process. */
  restarted: boolean;
};

export type EnsurePreviewOptions = {
  /**
   * Re-run the generated-route gates even when the dev server is already up.
   *
   * A turn that just wrote code wants them — they are what catches an API route
   * that 500s on every request, and the preview would otherwise look fine until
   * the user clicked. A token refresh does not: the gates cost a real model call
   * against the generated agent, and nothing about the code changed since the
   * run that passed them.
   */
  verifyRoutes?: boolean;
  /** Take down a healthy process first. For the callers that know it is stale. */
  forceRestart?: boolean;
};

/**
 * Level 4 — a public preview URL that works right now.
 *
 * This is the function that used to be five functions. Its callers are a chat
 * turn (in four places), `GET /session`'s workspace stage, `POST /preview`, the
 * gateway-key apply, the agent's `makers dev` result, and the agent's own
 * `start_preview`. None of them needs to know whether the answer costs a string
 * rewrite or five minutes of npm install and a dev server boot, and the answer
 * is the same whoever asks first.
 *
 * `state` is passed in rather than read here, and that is deliberate.
 * `ProjectState` is a mutable object memoized per request, and a running turn
 * holds its own live copy that its SSE stream reports from. Re-deriving it here
 * would publish the preview onto a second copy that nobody is watching — which
 * is the question every one of those callers used to answer for itself.
 * Callers without a live copy get one from `ensureWorkspace` first.
 *
 * Throws when no URL can be produced — the URL is the whole point, so a caller
 * that gets a resolved value gets a usable link.
 */
export function ensurePreview(
  context: AgentContext,
  conversationId: string,
  state: ProjectState,
  options: EnsurePreviewOptions = {},
): Promise<PreviewReadiness> {
  return once(context, `preview:${conversationId}`, () => withTimeout(
    resolvePreview(context, conversationId, state, options),
    READINESS_BUDGET_MS.preview,
    'preview',
  ));
}

async function resolvePreview(
  context: AgentContext,
  conversationId: string,
  state: ProjectState,
  options: EnsurePreviewOptions,
): Promise<PreviewReadiness> {
  // A deployed preview is a Makers URL rather than a process in this sandbox,
  // so there is nothing here to start and no token on it to rotate.
  if (isMakersPreviewState(state) && state.previewUrl) {
    return {
      url: state.previewUrl,
      sandboxDebugUrl: state.sandboxDebugUrl,
      kind: 'makers',
      restarted: false,
    };
  }

  // The token-only path, and the reason the frontend no longer has to reason
  // about expiry: a live server just needs a URL minted from this request's own
  // envdAccessToken, which is current by construction.
  if (!options.forceRestart && !options.verifyRoutes && await isPreviewServerReady(context)) {
    const links = await mintPreviewLinks(context, state);
    if (links.url) {
      return publishReadyPreview(context, conversationId, state, links, false);
    }
  }

  if (!await timeStage(
    'readiness:preview',
    { phase: 'dependencies' },
    () => ensureDependencies(context, state),
  )) {
    throw new Error('Project dependencies are not available for the preview.');
  }

  // startPreviewServer owns the warm probe, the route gates and the decision to
  // restart a server that answers wrongly. Repeating any of that here is how
  // this function came to have five copies in the first place.
  const server = await timeStage(
    'readiness:preview',
    { phase: 'server' },
    () => startPreviewServer(context, state, { forceRestart: options.forceRestart }),
  );
  await assertPreviewServerReady(context, server.readyPath);

  const links = await mintPreviewLinks(context, state);
  if (!links.url) {
    throw new Error(`Makers dev is ready, but the sandbox did not return a public URL for port ${PREVIEW_PUBLIC_PORT}.`);
  }
  return publishReadyPreview(context, conversationId, state, links, server.restarted);
}

async function publishReadyPreview(
  context: AgentContext,
  conversationId: string,
  state: ProjectState,
  links: { url: string; sandboxDebugUrl?: string },
  restarted: boolean,
): Promise<PreviewReadiness> {
  publishPreview(state, {
    url: links.url,
    sandboxDebugUrl: links.sandboxDebugUrl,
    kind: 'sandbox',
  });
  try {
    await persistWorkspace(context, conversationId, state);
  } catch {
    // Non-fatal: the returned URL still works for this request, and the next
    // one mints a fresh link from the sandbox rather than from the record.
  }
  return {
    url: links.url,
    sandboxDebugUrl: links.sandboxDebugUrl,
    kind: 'sandbox',
    restarted,
  };
}

/**
 * Where the running dev server is reachable, with a token that is current.
 *
 * `getHost` is authoritative about the address, so it leads. Rewriting the
 * stored URL is the fallback: it is known only to have been right for some
 * earlier sandbox, which is enough when `getHost` comes back empty and not
 * enough to prefer.
 */
async function mintPreviewLinks(context: AgentContext, state: ProjectState) {
  const links = await resolvePublicLinks(context);
  if (links.previewUrl) {
    return { url: links.previewUrl, sandboxDebugUrl: links.sandboxDebugUrl };
  }
  const token = typeof context.sandbox?.envdAccessToken === 'string'
    ? context.sandbox.envdAccessToken
    : '';
  const rewritten = state.previewUrl && token
    ? rewritePreviewAccessToken(state.previewUrl, token)
    : undefined;
  return rewritten
    ? { url: rewritten, sandboxDebugUrl: links.sandboxDebugUrl || state.sandboxDebugUrl }
    : {};
}

async function probeSandboxHasFiles(context: AgentContext, state: ProjectState) {
  if (!(await requireSandbox(context).files.exists(state.appDir))) return false;
  const tree = await getFileTree(context, state);
  return tree.some((item) => item.type === 'file');
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
