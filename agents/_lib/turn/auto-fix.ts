import { AUTO_FIX_MAX_ATTEMPTS } from '../constants.ts';
import { runCodingAgent } from '../session/live.ts';
import type {
  AgentProgressEvent,
  BuildResult,
  CodingAgentResult,
  DeploymentInfo,
  PreviewKind,
  ProjectState,
  StreamSend,
} from '../types.ts';
import { buildAutoFixPrompt } from '../utils/build-errors.ts';
import type { AgentContext } from '../runtime/context.ts';

export type AutoFixTurnInput = {
  context: AgentContext;
  conversationId: string;
  message: string;
  state: ProjectState;
  assistantReply: string;
  build: BuildResult;
  onProgress: (event: AgentProgressEvent) => void;
  onProjectFilesChanged: (file?: { path: string; content: string }) => Promise<void>;
  onPreviewReady: (preview: {
    url?: string;
    sandboxDebugUrl?: string;
    kind?: PreviewKind;
  }) => void;
  onDeploymentStatus: (deployment: DeploymentInfo) => void;
  abortSignal?: AbortSignal;
  model?: string;
  send: StreamSend;
};

export async function runAutoFixTurn(input: AutoFixTurnInput): Promise<{
  result: CodingAgentResult;
  prompt: string;
}> {
  const prompt = buildAutoFixPrompt(
    input.message,
    input.assistantReply,
    input.build,
    1,
    AUTO_FIX_MAX_ATTEMPTS,
  );
  const result = await runCodingAgent({
    context: input.context,
    conversationId: input.conversationId,
    userMessage: prompt,
    state: input.state,
    onProgress: input.onProgress,
    onProjectFilesChanged: input.onProjectFilesChanged,
    onPreviewReady: input.onPreviewReady,
    onDeploymentStatus: input.onDeploymentStatus,
    abortSignal: input.abortSignal,
    model: input.model,
    send: input.send,
  });
  return { result, prompt };
}
