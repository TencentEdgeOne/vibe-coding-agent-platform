import type { AgentContext } from '../runtime/context.ts';
import type {
  DeploymentInfo,
  PreviewKind,
  ProjectState,
  StreamSend,
} from '../types.ts';

export type MakersCommandLifecycle = {
  context: AgentContext;
  state: ProjectState;
  conversationId?: string;
  send?: StreamSend;
  signal?: AbortSignal;
  onPreviewReady?: (preview: {
    url?: string;
    sandboxDebugUrl?: string;
    kind?: PreviewKind;
  }) => void;
  onDeploymentStatus?: (deployment: DeploymentInfo) => void;
};
