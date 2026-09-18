import type { AssistantActivity } from '../../../../../shared/protocol';
import type { ModelOption } from '../../../../../shared/models';

export type ConversationMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  activities?: AssistantActivity[];
  status?: 'running' | 'done' | 'error' | 'stopped';
};

export type ConversationCopy = {
  running: string;
  completed: string;
  failed: string;
  stopped: string;
  thinking: string;
  info: string;
  usage: string;
  compact: string;
  status: string;
  placeholder: string;
  send: string;
  stop: string;
  modelLabel: string;
  copyLink: string;
  linkCopied: string;
};

export type DeployOfferCopy = {
  prompt: string;
  deploy: string;
  dismiss: string;
};

export type GatewayPromptCopy = {
  title: string;
  description?: string;
  docs: string;
  docsUrl: string;
  apiKey: string;
  continue: string;
  skip: string;
};

export type { AssistantActivity, ModelOption };
