import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type {
  ActivityStatus,
  BuildStatus,
  ChatStreamEvent,
  DeploymentInfo,
  PreviewKind,
} from '../../shared/protocol.ts';

export type {
  ActivityStatus,
  BuildStatus,
  DeploymentInfo,
  FileTreeItem,
  PreviewKind,
} from '../../shared/protocol.ts';

export type ProjectState = {
  created: boolean;
  sessionDir: string;
  appDir: string;
  /** Opaque, non-secret tenant ID used to mint short-lived Makers tokens for direct sandbox CLI calls. */
  makersTenantId?: string;
  /** Public site root (`edgeone.dev` / `edgeone.cool`) used to pick the publish acceleration area. */
  siteDomain?: string;
  /** Site the minted sandbox token belongs to. Injected as EDGEONE_PAGES_API_REGION so the CLI can pick a CAPI host. */
  makersApiRegion?: 'china' | 'global';
  previewUrl?: string;
  sandboxDebugUrl?: string;
  /** Latched once Makers dev succeeds so resume can restore the sandbox preview. */
  previewPublished?: boolean;
  previewKind?: PreviewKind;
  /** Latest live deployment, kept separate from the sandbox preview iframe. */
  deployment?: DeploymentInfo;
  /** The host is waiting for a Models API key in the next user turn. */
  gatewayPromptPending?: boolean;
  /** The user skipped the Models API key for this conversation. */
  gatewaySkipped?: boolean;
};

export type ChatTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'stopped';

/**
 * What the task slot is running. Publishing is a service step with one correct
 * command, so 'deploy' skips the model entirely — but it still occupies the
 * same slot, so it cannot race a generation over the same sandbox.
 */
export type ChatTaskKind = 'prompt' | 'deploy';

export type ChatTask = {
  id: string;
  message: string;
  kind?: ChatTaskKind;
  /** Public site root from the browser; picks overseas vs global acceleration. */
  siteDomain?: string;
  /** Model this turn runs on. Absent means the deployment's configured default. */
  model?: string;
  status: ChatTaskStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
};

export type PersistedActivity =
  | {
      kind: 'text';
      content: string;
    }
  | {
      kind: 'tool';
      toolUseId: string;
      name: string;
      status: ActivityStatus;
      inputSummary?: string;
      outputSummary?: string;
      startedAt: number;
      endedAt?: number;
    };

export type PersistedActivityTurn = {
  id: string;
  user: string;
  assistant: string;
  status: 'completed' | 'failed' | 'stopped';
  createdAt: number;
  activities: PersistedActivity[];
};

export type StreamSend = (event: ChatStreamEvent) => void;

export type ScaffoldLog = {
  stream: 'status' | 'stdout' | 'stderr';
  content: string;
};

export type CodingAgentResult = {
  success: boolean;
  output: string | null;
  error: string | null;
  projectTouched: boolean;
  /**
   * Whether this turn wrote a project file, as opposed to merely reaching the
   * project. Scaffolding sets projectTouched and the workflow asks for it on
   * every turn, so that flag cannot tell a build apart from a turn that only
   * answered a question — and answering one is not a build that failed.
   */
  filesWritten?: boolean;
  previewTouched?: boolean;
  deploymentTouched?: boolean;
  wasCreated: boolean;
  fatal?: boolean;
  stopped?: boolean;
};

export type BuildResult = {
  status: BuildStatus;
  stdout?: string;
  stderr?: string;
  autoFixAttempts?: number;
  autoFixApplied?: boolean;
  fatal?: boolean;
};

export type AgentProgressEvent = Extract<
  ChatStreamEvent,
  { type: 'tool_use' | 'tool_result' | 'text_segment' }
>;

export type ClaudeMcpTool = SdkMcpToolDefinition<any>;
