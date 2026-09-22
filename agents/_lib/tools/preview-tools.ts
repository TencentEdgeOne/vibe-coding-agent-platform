import { tool as defineClaudeTool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { ensurePreview } from '../project/readiness.ts';
import type { ClaudeMcpTool, PreviewKind, ProjectState } from '../types.ts';
import type { AgentContext } from '../runtime/context.ts';
import { stringifyToolResult } from '../utils/text.ts';

const startPreviewInputSchema = {
  restart: z.boolean().optional().describe(
    'Replace a dev server that is already running. Only needed after changing something it reads at startup, such as an environment variable — file edits are picked up on save.',
  ),
};

export type PreviewToolLifecycle = {
  context: AgentContext;
  conversationId: string;
  readonly state: ProjectState;
  onPreviewReady?: (preview: {
    url?: string;
    sandboxDebugUrl?: string;
    kind?: PreviewKind;
  }) => void;
};

/**
 * The preview, as something the agent can ask for by name.
 *
 * Before this, the only way the agent could bring a preview up was to run
 * `edgeone makers dev` through the shell tool and read the launcher's output,
 * which made the preview a side effect of a command rather than a step in the
 * task. With a tool, the URL and the verdict on the generated routes come back
 * in the tool result, so the agent can act on a project that does not serve —
 * and the same call is the one the client and the host make, so there is no
 * second code path for the agent to disagree with.
 */
export function buildStartPreviewTool(lifecycle: PreviewToolLifecycle) {
  return defineClaudeTool(
    'start_preview',
    'Bring up the live preview for the current project and return its public URL. Verifies that the pages and any generated API or agent routes actually answer, so use it to confirm the project runs before telling the user it is done. Safe to call more than once: a healthy dev server is reused rather than restarted.',
    startPreviewInputSchema,
    async (input) => {
      try {
        const options = input as { restart?: unknown };
        const preview = await ensurePreview(
          lifecycle.context,
          lifecycle.conversationId,
          lifecycle.state,
          {
            verifyRoutes: true,
            forceRestart: options.restart === true,
          },
        );
        lifecycle.onPreviewReady?.(preview);
        return {
          content: [{
            type: 'text' as const,
            text: stringifyToolResult({
              status: 'success',
              preview: {
                url: preview.url,
                kind: preview.kind,
              },
              restarted: preview.restarted,
              // The panel is already showing it, so repeating the link in the
              // reply only gives the user the same URL twice.
              note: 'The preview panel is already showing this URL. Do not put it in your reply to the user.',
            }),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: error instanceof Error ? error.message : String(error),
          }],
          isError: true,
        };
      }
    },
  ) as ClaudeMcpTool;
}
