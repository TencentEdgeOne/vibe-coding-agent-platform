/**
 * Transport contracts shared by the Makers agent runtime and the browser.
 *
 * Keep this module runtime-agnostic: no React, Next.js, or EdgeOne imports.
 */

export type BuildStatus = 'success' | 'failed' | 'skipped';

export type ActivityStatus = 'running' | 'completed' | 'failed' | 'stopped';

export type ProgressPhase = 'scaffold' | 'modify' | 'code' | 'install' | 'preview' | 'link';

/** Real startup milestones before the model produces its first visible output. */
export type PreparePhase = 'accepted' | 'workspace' | 'agent';

export type SystemInfoType = 'compact' | 'usage' | 'status' | 'system' | 'sdk';

export type AssistantActivity =
  | {
      kind: 'text';
      content: string;
    }
  | {
      kind: 'thinking';
      content: string;
      startedAt?: number;
      endedAt?: number;
    }
  | {
      kind: 'info';
      infoType: SystemInfoType;
      title: string;
      content: string;
    }
  | {
      kind: 'tool';
      toolUseId: string;
      name: string;
      status: ActivityStatus;
      command?: string;
      phaseHint?: ProgressPhase;
      fileCount?: number;
      inputSummary?: string;
      outputSummary?: string;
      startedAt?: number;
      endedAt?: number;
    };

export type PersistedActivityTurn = {
  id: string;
  user: string;
  assistant: string;
  status: 'completed' | 'failed' | 'stopped';
  createdAt: number;
  /** When the first user-visible agent output arrived; absent if it never did. */
  startedAt?: number;
  activities: AssistantActivity[];
};

export type BuildInfo = {
  status: BuildStatus;
  stdout?: string;
  stderr?: string;
  autoFixAttempts?: number;
  autoFixApplied?: boolean;
};

export type PreviewKind = 'sandbox' | 'makers';

export type DeploymentStatus = 'running' | 'success' | 'failed';

export type DeploymentInfo = {
  status: DeploymentStatus;
  startedAt: number;
  finishedAt?: number;
  url?: string;
  projectId?: string;
  deploymentId?: string;
  consoleUrl?: string;
  error?: string;
};

export type LinkInfo = {
  url?: string;
  sandboxDebugUrl?: string;
  filename?: string;
  error?: string;
  /** Preview resume restarted the server, invalidating an already loaded iframe. */
  restarted?: boolean;
  /** Makers deploy URLs skip sandbox envdAccessToken refresh. */
  kind?: PreviewKind;
};

export type FileTreeItem = {
  path: string;
  name: string;
  type: 'file' | 'directory';
  depth: number;
  mtime?: number;
  size?: number;
};

export type FileTree = {
  root: string;
  items: FileTreeItem[];
};

type ActiveChatTask = {
  id: string;
  message: string;
  status: 'queued' | 'running';
  createdAt?: number;
  startedAt?: number;
  preparePhase?: PreparePhase;
};

export type ResumeData = {
  ok?: boolean;
  stage?: 'history' | 'workspace' | 'preview';
  conversation_id?: string;
  messages?: { role: 'user' | 'assistant'; content: string }[];
  hasProject?: boolean;
  hasPreview?: boolean;
  needsWorkspace?: boolean;
  preview?: LinkInfo;
  deployment?: DeploymentInfo;
  files?: FileTree;
  download?: LinkInfo;
  activityHistory?: PersistedActivityTurn[];
  activeTask?: ActiveChatTask | null;
  /** Model chosen for this conversation; '' or absent means the deployment default. */
  model?: string;
  /** UI language chosen for this conversation. */
  language?: 'zh' | 'en';
  /** Resume should show the Models API key card. */
  gatewayNeeded?: boolean;
  /** User deferred the key; resume should show the reopen chip. */
  gatewaySkipped?: boolean;
  error?: string;
};

/** Workspace projection the frontend can fetch without the chat stream. */
export type WorkspaceSnapshot = {
  ok?: boolean;
  conversation_id?: string;
  files?: FileTree;
  preview?: LinkInfo;
  deployment?: DeploymentInfo;
  download?: LinkInfo;
  build?: BuildInfo;
};

/** Raw Claude JSONL for the Session tab. The file is the source of truth. */
export type TranscriptData = {
  ok?: boolean;
  conversation_id?: string;
  sessionId?: string;
  transcriptPath?: string;
  jsonl?: string;
  /** The live query still has a turn in flight; more snapshots may follow. */
  live?: boolean;
  error?: string;
};

export type ChatResponse = {
  ok?: boolean;
  reply?: string;
  conversation_id?: string;
  error?: string;
  stopped?: boolean;
};

export type ChatStreamEvent =
  | {
      type: 'task_started';
      data?: {
        runId?: string;
        conversation_id?: string;
        status?: 'queued' | 'running' | 'completed' | 'failed' | 'stopped';
        preparePhase?: PreparePhase;
      };
    }
  | { type: 'prepare_phase'; data?: { phase?: PreparePhase } }
  | { type: 'result'; data?: ChatResponse }
  | { type: 'agent'; data?: Pick<ChatResponse, 'ok' | 'reply' | 'error'> }
  | { type: 'workspace'; data?: WorkspaceSnapshot }
  | { type: 'file_tree'; data?: FileTree }
  | {
      type: 'file_changed';
      data?: { paths?: string[] };
    }
  | {
      type: 'preview_ready';
      data?: { preview?: LinkInfo; download?: LinkInfo };
    }
  | {
      type: 'deployment_status';
      data?: DeploymentInfo;
    }
  | {
      type: 'tool_use';
      data?: {
        id?: string;
        name?: string;
        command?: string;
        phaseHint?: ProgressPhase;
        fileCount?: number;
        inputSummary?: string;
        /**
         * Output from a call that has not finished. Re-sent with the same `id`
         * as the call goes on, which patches the row in place; a publish runs
         * for minutes and this is what it shows while it does.
         */
        outputSummary?: string;
        startedAt?: number;
      };
    }
  | {
      type: 'tool_result';
      data?: {
        id?: string;
        toolName?: string;
        command?: string;
        ok?: boolean;
        preview?: string;
        outputSummary?: string;
        status?: ActivityStatus;
        endedAt?: number;
      };
    }
  | { type: 'text_segment'; data?: { uuid?: string; text?: string } }
  | { type: 'thinking_segment'; data?: { uuid?: string; text?: string } }
  | {
      type: 'system_info';
      data?: {
        infoType?: SystemInfoType;
        title?: string;
        content?: string;
      };
    }
  | {
      type: 'gateway_credentials';
      data?: {
        status?: 'needed' | 'resolved';
        keys?: string[];
        skipped?: boolean;
      };
    }
  | { type: 'error'; error?: string }
  | { type: 'ping'; ts?: number };

export type ResumeStreamEvent =
  | { type: 'resume_history'; data?: ResumeData }
  | { type: 'resume_workspace'; data?: ResumeData }
  | { type: 'file_changed'; data?: { paths?: string[] } }
  | { type: 'error'; error?: string }
  | { type: 'ping'; ts?: number };

export type TranscriptStreamEvent =
  | { type: 'transcript'; data?: TranscriptData }
  | { type: 'error'; error?: string }
  | { type: 'ping'; ts?: number };

export type SessionStreamEvent = ChatStreamEvent | ResumeStreamEvent | TranscriptStreamEvent;
