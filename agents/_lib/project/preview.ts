import { requireSandbox, type AgentContext } from '../runtime/context.ts';
import {
  MAKERS_DEV_PORT,
  PREVIEW_ASSET_PREFIX_ENV,
  PREVIEW_PATH_PREFIX,
  PREVIEW_PUBLIC_PORT,
  PREVIEW_SERVER_PORT,
} from '../constants.ts';
import type { ProjectState } from '../types.ts';
import {
  MAKERS_DEV_LAUNCH_TIMEOUT_SECONDS,
  MAKERS_DEV_LOG_PATH,
  buildMakersDevBackgroundCommand,
  buildMakersDevLaunchCommand,
  parseMakersDevExitCode,
} from '../makers/cli-dev.ts';
import { redactSecret } from '../makers/cli-deploy.ts';
import { shellQuote } from '../utils/shell.ts';
import {
  MAKERS_CLI_UNAVAILABLE_ERROR_CODE,
  MAKERS_CLI_UNAVAILABLE_MESSAGE,
  isEdgeoneCliUnavailable,
} from '../makers/tool-phase.ts';
import { runCommandCapturingExit, runSandboxCommand } from './commands.ts';
import { assertMakersProjectCompatible } from '../makers/compat/run.ts';
import { prepareMakersSession } from '../makers/session.ts';
import { resolveMakersProjectName } from '../makers/project.ts';
import { describeMissingMakersRuntimeToken } from '../makers/token.ts';

export async function resolvePublicLinks(context: AgentContext) {
  const sandbox = requireSandbox(context);
  const previewHost = await Promise.resolve(sandbox.getHost?.(PREVIEW_PUBLIC_PORT));
  const accessToken = sandbox.envdAccessToken;
  const previewBaseUrl = normalizePublicUrl(previewHost);
  const sandboxDebugUrl = normalizePublicUrl(sandbox.browser?.liveUrl);

  const previewUrl = (previewBaseUrl && accessToken)
    ? buildPublicPreviewUrl(previewBaseUrl, accessToken)
    : undefined;

  return {
    previewUrl,
    sandboxDebugUrl,
  };
}

function normalizePublicUrl(value: unknown) {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function buildPublicPreviewUrl(baseUrl: string, token: string) {
  try {
    const parsed = new URL(baseUrl);
    parsed.pathname = PREVIEW_PATH_PREFIX;
    parsed.search = '';
    parsed.hash = '';
    return appendAccessToken(parsed.toString(), token);
  } catch {
    const trimmedBase = baseUrl.replace(/\/+$/, '');
    return appendAccessToken(`${trimmedBase}${PREVIEW_PATH_PREFIX}`, token);
  }
}

function appendAccessToken(url: string, token: string) {
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has('access_token')) {
      parsed.searchParams.set('access_token', token);
    }
    return parsed.toString();
  } catch {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}access_token=${encodeURIComponent(token)}`;
  }
}

/** Rotate envdAccessToken on an already-published preview URL (same host/path). */
export function rewritePreviewAccessToken(existingUrl: string, token: string) {
  try {
    const parsed = new URL(existingUrl);
    parsed.searchParams.set('access_token', token);
    return parsed.toString();
  } catch {
    return undefined;
  }
}

/** How often a running preview may repaint the log a person is watching. */
const PREVIEW_LOG_POLL_MS = 2000;

const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * The stage, then the log underneath it.
 *
 * The stage is what is happening before the log exists — an install that has
 * not printed yet, a server that has not opened its file. Once the log has
 * lines, they are the process, and the stage stays as the heading so a tail
 * of framework output still says which step it belongs to.
 */
export function formatPreviewProgress(stage: string, log = '') {
  const body = log.trim();
  return body ? `${stage}\n\n${body}` : stage;
}

/**
 * The tail of a file some other command is writing, until `stop` says the
 * command has finished.
 *
 * The launcher keeps the dev server's own output in a file and does not return
 * until the server answers, so awaiting that command is a blank row for as
 * long as the boot takes. Reading the file from a second command is what
 * makes the wait visible. A read that fails says nothing about the boot.
 */
export async function followSandboxLog(
  context: AgentContext,
  logPath: string,
  stop: () => boolean,
  onTail: (tail: string) => void,
) {
  let previous = '';
  while (!stop()) {
    await sleep(PREVIEW_LOG_POLL_MS);
    if (stop()) return;
    try {
      const poll = await runSandboxCommand(
        context,
        `tail -n 40 ${shellQuote(logPath)} 2>/dev/null || true`,
        { timeout: 15 },
      );
      const tail = poll.stdout.trim();
      if (tail && tail !== previous) {
        previous = tail;
        onTail(tail);
      }
    } catch {
      // A missed read is not a failed preview. The command writing the file
      // is still the thing that decides the outcome.
    }
  }
}

/**
 * Lint the project, prepare the Makers session, launch makers dev, and report
 * where it is listening. Whether the generated pages and routes actually answer
 * is the agent's question, asked through its own tools after it has the URL — a
 * preview must not turn a slow boot or a broken route into "no preview at all".
 */
export async function startPreviewServer(
  context: AgentContext,
  state: ProjectState,
  options: {
    forceRestart?: boolean;
    /** Live text for the row a person is watching. Absent callers stay quiet. */
    onProgress?: (text: string) => void;
  } = {},
) {
  await assertMakersProjectCompatible(context, state);
  const projectName = resolveMakersProjectName(context, state);
  const launchCommand = buildMakersDevLaunchCommand(MAKERS_DEV_PORT, projectName);
  let forceRestart = options.forceRestart === true;

  // makers-dev watches project files. On resume, keep a healthy process rather
  // than starting a second CLI instance on the same port.
  if (!forceRestart) {
    const warm = await runCommandCapturingExit(
      context,
      probePreviewReadyCommand(),
      { timeout: 5 },
    );
    if (warm.exitCode === 0) {
      return previewServerInfo(launchCommand, false);
    }
  }

  options.onProgress?.(formatPreviewProgress('Preparing the preview'));
  const makers = await prepareMakersSession(context, state);

  options.onProgress?.(formatPreviewProgress('Starting the preview server'));
  let launchStopped = false;
  let launchLog = '';
  const followingLaunch = options.onProgress
    ? followSandboxLog(context, MAKERS_DEV_LOG_PATH, () => launchStopped, (tail) => {
      launchLog = redactSecret(redactSecret(tail, makers.sandboxToken), makers.gatewayKey);
      options.onProgress?.(formatPreviewProgress('Starting the preview server', launchLog));
    })
    : Promise.resolve();
  let startResult: Awaited<ReturnType<typeof runSandboxCommand>>;
  try {
    startResult = await runSandboxCommand(
      context,
      buildMakersDevBackgroundCommand({
        makersPort: MAKERS_DEV_PORT,
        previewPort: PREVIEW_SERVER_PORT,
        previewPath: PREVIEW_PATH_PREFIX,
        projectName: makers.projectName,
        assetPrefixEnvName: PREVIEW_ASSET_PREFIX_ENV,
        forceRestart,
      }),
      {
        cwd: state.appDir,
        timeout: MAKERS_DEV_LAUNCH_TIMEOUT_SECONDS,
        env: makers.env,
      },
    );
  } finally {
    launchStopped = true;
    await followingLaunch;
  }
  const startOutput = [startResult.stdout, startResult.stderr].filter(Boolean).join('\n');
  const capturedExitCode = parseMakersDevExitCode(startOutput);
  if (
    startResult.exitCode !== 0
    || (capturedExitCode != null && capturedExitCode !== 0)
  ) {
    const failure = isEdgeoneCliUnavailable(startOutput)
      ? `${MAKERS_CLI_UNAVAILABLE_ERROR_CODE}: ${MAKERS_CLI_UNAVAILABLE_MESSAGE}`
      : describeMissingMakersRuntimeToken(startOutput)
        || startOutput
        || 'Failed to start edgeone makers dev.';
    throw new Error(
      redactSecret(
        failure,
        makers.sandboxToken,
      ),
    );
  }

  return previewServerInfo(launchCommand, true);
}

/**
 * `restarted` is for the iframe: a reused process is still serving the page the
 * client already has, and a fresh one is not, so only the second case has to
 * cost the user a remount.
 */
function previewServerInfo(launchCommand: string, restarted: boolean) {
  return {
    port: PREVIEW_SERVER_PORT,
    publicPort: PREVIEW_PUBLIC_PORT,
    makersDevPort: MAKERS_DEV_PORT,
    proxyPath: PREVIEW_PATH_PREFIX,
    framework: 'makers-dev',
    command: launchCommand,
    readyPath: PREVIEW_PATH_PREFIX,
    ready: true,
    restarted,
  };
}

export async function isPreviewServerReady(
  context: AgentContext,
  readyPath = PREVIEW_PATH_PREFIX,
) {
  const result = await runCommandCapturingExit(
    context,
    probePreviewReadyCommand(readyPath),
    { timeout: 5 },
  );
  return result.exitCode === 0;
}

export async function assertPreviewServerReady(
  context: AgentContext,
  readyPath = PREVIEW_PATH_PREFIX,
) {
  const result = await runCommandCapturingExit(
    context,
    probePreviewReadyCommand(readyPath),
    { timeout: 10 },
  );

  if (result.exitCode !== 0) {
    throw new Error(`Preview server is not ready on port ${PREVIEW_SERVER_PORT}${readyPath}.`);
  }
}

function probePreviewReadyCommand(readyPath = PREVIEW_PATH_PREFIX) {
  return [
    'set +e',
    `curl --noproxy '*' -fsS ${shellQuote(`http://127.0.0.1:${PREVIEW_SERVER_PORT}/__edgeone_preview_proxy_health`)} >/dev/null \\`,
    `  && curl --noproxy '*' -fsS ${shellQuote(`http://127.0.0.1:${PREVIEW_SERVER_PORT}${readyPath}`)} >/dev/null`,
    'echo EXIT:$?',
  ].join('\n');
}
