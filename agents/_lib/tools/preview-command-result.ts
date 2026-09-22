import { ensurePreview } from '../lazy/preview.ts';
import { describeMissingMakersRuntimeToken } from '../makers/token.ts';
import {
  MAKERS_DEV_PORT_DRIFT_EXIT,
  parseMakersDevExitCode,
} from '../makers/cli-dev.ts';
import { isEdgeoneCliUnavailable } from '../makers/tool-phase.ts';
import {
  appendText,
  withMakersCliUnavailableError,
  type ToolHandlerResult,
} from './command-text.ts';
import type { MakersCommandLifecycle } from './makers-lifecycle.ts';
import type { PreparedMakersCommand } from './makers-command.ts';

export async function handleDevCommandResult(
  lifecycle: MakersCommandLifecycle,
  makers: PreparedMakersCommand,
  result: ToolHandlerResult,
  makersOutput: string,
): Promise<ToolHandlerResult> {

  const missingRuntimeToken = describeMissingMakersRuntimeToken(makersOutput);
  if (missingRuntimeToken) {
    return {
      ...appendText(result, JSON.stringify({
        status: 'error',
        error: missingRuntimeToken,
      })),
      isError: true,
    };
  }
  const devExitCode = parseMakersDevExitCode(makersOutput);
  if (devExitCode != null && devExitCode !== 0) {
    if (isEdgeoneCliUnavailable(makersOutput)) {
      return withMakersCliUnavailableError(result, 'edgeone makers dev');
    }
    // The one launch failure that says nothing about the project: the
    // port was still held, so the CLI came up healthy somewhere the
    // proxy does not look. Launching again is the fix, and the launcher
    // now clears that port first, so the second attempt is not a repeat
    // of the first.
    if (devExitCode === MAKERS_DEV_PORT_DRIFT_EXIT) {
      return {
        ...appendText(result, JSON.stringify({
          status: 'error',
          errorCode: 'MAKERS_DEV_PORT_DRIFT',
          retryable: true,
          error: 'edgeone makers dev started on a port the preview proxy does not forward to, because the previous dev server still held the expected one.',
          instruction: 'Run the same preview command once more. Nothing in the generated project caused this, so do not change project files, and do not kill processes or free ports yourself — the launcher terminates the previous server before this next attempt.',
        })),
        isError: true,
      };
    }
    return {
      ...appendText(result, JSON.stringify({
        status: 'error',
        error: describeMissingMakersRuntimeToken(makersOutput)
          || `edgeone makers dev exited with code ${devExitCode}.`,
        exitCode: devExitCode,
      })),
      isError: true,
    };
  }
  try {
    // The CLI reported success, so this is the verification half: the route
    // gates, and a restart for a server that answers nothing. Both live in the
    // readiness layer now, so the agent's own launch cannot drift from the one
    // the host and the client get. `lifecycle.state` is the turn's live copy —
    // the preview has to land on that one to reach its SSE stream.
    const preview = await ensurePreview(
      lifecycle.context,
      lifecycle.conversationId,
      lifecycle.state,
      { verifyRoutes: true },
    );
    lifecycle.onPreviewReady?.(preview);
    return appendText(result, JSON.stringify({
      status: 'success',
      preview: {
        url: preview.url,
        kind: preview.kind,
      },
    }));
  } catch (error) {
    return {
      ...appendText(result, error instanceof Error ? error.message : String(error)),
      isError: true,
    };
  }
}
