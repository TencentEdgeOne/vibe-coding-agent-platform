import { tool as defineClaudeTool } from '@anthropic-ai/claude-agent-sdk';
import { MAKERS_CLI_UNAVAILABLE_ERROR_CODE } from '../makers/tool-phase.ts';
import {
  DEPLOY_PARSE_FAILURE,
  describeMakersDeployment,
  readMakersDeployOutcome,
  redactSecret,
} from '../makers/cli-deploy.ts';
import {
  resolveConversationPublishArea,
  resolveMakersProjectName,
} from '../makers/project.ts';
import { prepareMakersSession } from '../makers/session.ts';
import { describeMissingMakersRuntimeToken } from '../makers/token.ts';
import { assertMakersProjectCompatible } from '../makers/compat/run.ts';
import { getFileTree } from '../project/fs.ts';
import { pauseForGatewayCredentialsIfNeeded } from '../project/gateway.ts';
import { ensureDependencies } from '../project/readiness.ts';
import { startPreviewServer } from '../project/preview.ts';
import { setDeployment } from '../project/workspace-store.ts';
import type { AgentContext } from '../runtime/context.ts';
import {
  DEPLOY_TIMEOUT_SECONDS,
  publishWithProgress,
} from '../turn/deploy.ts';
import type { ClaudeMcpTool, DeploymentInfo, ProjectState, StreamSend } from '../types.ts';
import { summarizeToolOutput } from '../../../shared/timeline.ts';
import { stringifyToolResult } from '../utils/text.ts';
import { commandCallId } from './command-stream.ts';

export const DEPLOY_PROJECT_TOOL_NAME = 'deploy_project';

export type DeployToolLifecycle = {
  context: AgentContext;
  conversationId: string;
  readonly state: ProjectState;
  send?: StreamSend;
  onDeploymentStatus?: (deployment: DeploymentInfo) => void;
};

function toolError(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    isError: true,
  };
}

/**
 * Publish, as something the agent can ask for by name.
 *
 * The button does not publish on its own. It sends a user turn that names this
 * tool, and the tool is what actually runs the CLI: credentials, project name,
 * and publish area stay with the host, the same way start_preview owns the
 * dev server. The system prompt does not teach this step, so a normal coding
 * turn has no reason to call it.
 */
export function buildDeployProjectTool(lifecycle: DeployToolLifecycle) {
  return defineClaudeTool(
    DEPLOY_PROJECT_TOOL_NAME,
    'Publish the current project to a live URL when the user asks to deploy. The host supplies credentials, the project name, and the publish area, and streams progress on this call. Do not run edgeone makers deploy yourself, and do not pass a project name.',
    {},
    async (_input, extra) => {
      const toolUseId = commandCallId(extra);
      const startedAt = Date.now();
      const publish = (deployment: DeploymentInfo) => {
        setDeployment(lifecycle.state, deployment);
        lifecycle.onDeploymentStatus?.(deployment);
      };

      const files = await getFileTree(lifecycle.context, lifecycle.state).catch(() => []);
      if (!files.some((item) => item.type === 'file')) {
        return toolError('There is no project to deploy yet. Generate one first.');
      }

      const pause = await pauseForGatewayCredentialsIfNeeded(
        lifecycle.context,
        lifecycle.state,
        { conversationId: lifecycle.conversationId, send: lifecycle.send },
      );
      if (pause) return toolError(pause);

      publish({ status: 'running', startedAt });

      let sandboxToken = '';
      let gatewayKey = '';
      let sandboxEnv: Record<string, string> = {};
      try {
        await assertMakersProjectCompatible(lifecycle.context, lifecycle.state);
        await ensureDependencies(lifecycle.context, lifecycle.state);
        const makers = await prepareMakersSession(lifecycle.context, lifecycle.state, { syncEnv: true });
        sandboxToken = makers.sandboxToken;
        sandboxEnv = makers.env;
        gatewayKey = makers.gatewayKey;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        publish({
          status: 'failed',
          startedAt,
          finishedAt: Date.now(),
          error: message,
        });
        return toolError(message);
      }

      let stdout = '';
      let commandError = '';
      let timedOut = false;
      try {
        ({ log: stdout, timedOut } = await publishWithProgress(
          lifecycle.context,
          {
            projectName: resolveMakersProjectName(lifecycle.context, lifecycle.state),
            appDir: lifecycle.state.appDir,
            env: sandboxEnv,
            area: resolveConversationPublishArea(lifecycle.state),
          },
          (tail) => {
            if (!toolUseId || !lifecycle.send) return;
            // Patches the row the agent loop already opened. Repeating the
            // tool name here would overwrite that row with this module's copy.
            lifecycle.send?.({
              type: 'tool_use',
              data: {
                id: toolUseId,
                outputSummary: summarizeToolOutput(
                  redactSecret(redactSecret(tail, sandboxToken), gatewayKey),
                ),
              },
            });
          },
        ));
      } catch (error) {
        commandError = redactSecret(
          redactSecret(error instanceof Error ? error.message : String(error), sandboxToken),
          gatewayKey,
        );
      }

      // The publish stopped the preview so the build would not share a
      // directory with it. Bring it back before the agent writes the reply.
      try {
        await startPreviewServer(lifecycle.context, lifecycle.state, {
          verifyRoutes: false,
          onProgress: (text) => {
            if (!toolUseId || !lifecycle.send) return;
            const summary = summarizeToolOutput(text);
            if (!summary) return;
            lifecycle.send({
              type: 'tool_use',
              data: { id: toolUseId, outputSummary: summary },
            });
          },
        });
      } catch {
        // A preview that does not come back is not a failed publish.
      }

      if (commandError) {
        publish({
          status: 'failed',
          startedAt,
          finishedAt: Date.now(),
          error: commandError,
        });
        return toolError(commandError);
      }

      const outcome = readMakersDeployOutcome(stdout, '', sandboxToken);
      if (outcome.status === 'cli-missing') {
        publish({
          status: 'failed',
          startedAt,
          finishedAt: Date.now(),
          error: outcome.error,
        });
        return toolError(JSON.stringify({
          status: 'error',
          errorCode: MAKERS_CLI_UNAVAILABLE_ERROR_CODE,
          retryable: false,
          error: outcome.error,
          instruction: 'Stop. Do not inspect PATH, install packages, use npx, or retry. Tell the user the sandbox image does not provide the CLI yet.',
        }));
      }
      if (outcome.status !== 'success') {
        const error = describeMissingMakersRuntimeToken(stdout)
          || (timedOut && outcome.error === DEPLOY_PARSE_FAILURE
            ? `Publishing did not finish within ${DEPLOY_TIMEOUT_SECONDS} seconds.`
            : outcome.error);
        publish({
          status: 'failed',
          startedAt,
          finishedAt: Date.now(),
          error,
        });
        return toolError(error);
      }

      publish(describeMakersDeployment(outcome, { startedAt }));
      return {
        content: [{
          type: 'text' as const,
          text: stringifyToolResult({
            status: 'published',
            url: outcome.url,
            note: 'The site is live. Tell the user in their language and write this complete URL, query string included, on its own line. The deployment card already shows it. A deployment never replaces the right-hand preview, so do not tell the user their live site opened there.',
          }),
        }],
      };
    },
  ) as ClaudeMcpTool;
}
