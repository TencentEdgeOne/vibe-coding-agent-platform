import type { AssistantActivity } from '../../shared/protocol';

export type {
  AssistantActivity,
  BuildInfo,
  ChatResponse,
  ChatStreamEvent,
  DeploymentInfo,
  FileTree,
  LinkInfo,
  ResumeData,
  ResumeStreamEvent,
  SessionPrepData,
  SessionPrepStage,
  SessionStreamEvent,
  WorkspaceSnapshot,
} from '../../shared/protocol';

export type AssistantStatus = 'running' | 'done' | 'error' | 'stopped';

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  activities?: AssistantActivity[];
  status?: AssistantStatus;
};
