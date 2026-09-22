import type { AgentTurnStatus, ConversationMessage } from './types';

export type AgentStatusBarPhase =
  | 'preparing'
  | 'running'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'stopped';

/** Thinking is live output, but it is still setup: the agent has not started
 *  touching the project or writing the reply yet. Keep the bar in its
 *  preparing state until the first tool call or visible text block arrives. */
export function isAgentPreparing(
  message: Pick<ConversationMessage, 'content' | 'activities'>,
) {
  if (message.content.length > 0) return false;
  return !(message.activities ?? []).some(
    (activity) => activity.kind === 'tool' || activity.kind === 'text',
  );
}

export function resolveAgentStatusBarPhase(
  status: AgentTurnStatus,
  preparing: boolean,
  stopping = false,
): AgentStatusBarPhase {
  if (stopping) return 'stopping' as const;
  if (status === 'done') return 'completed' as const;
  if (status === 'error') return 'failed' as const;
  if (status === 'running' && preparing) return 'preparing' as const;
  return status;
}

export function resolveAgentElapsed(
  message: Pick<ConversationMessage, 'status' | 'startedAt' | 'endedAt'>,
  now = Date.now(),
) {
  if (!message.startedAt) return '';
  const end = message.status === 'running' ? now : message.endedAt || now;
  if (end < message.startedAt) return '';
  const seconds = Math.floor((end - message.startedAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
