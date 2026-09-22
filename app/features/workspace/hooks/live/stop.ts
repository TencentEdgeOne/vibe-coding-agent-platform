import { markLastTurnStopped } from '@/app/lib/conversation';
import type { PersistedActivityTurn } from '../../../../../shared/protocol';
import type { ChatMessage } from '@/app/types/workspace';
import { stopChatTask } from '../../workspace-api';

function requestStop(
  conversationId: string,
  turn: PersistedActivityTurn,
  options: {
    discardProject?: boolean;
    workspaceEpoch: number;
    currentWorkspaceEpoch: () => number;
    onSettled: () => void;
  },
) {
  return stopChatTask(conversationId, turn, options)
    .catch(() => null)
    .finally(() => {
      if (options.currentWorkspaceEpoch() !== options.workspaceEpoch) return;
      options.onSettled();
    });
}

export function beginStop(options: {
  conversationId: string;
  messages: ChatMessage[];
  activeTurnId: string;
  stopOptions: { discardProject?: boolean };
  workspaceEpoch: number;
  currentWorkspaceEpoch: () => number;
  onSettled: () => void;
}) {
  const stopped = markLastTurnStopped(options.messages, '');
  const stoppedTurn = {
    id: options.activeTurnId,
    user: stopped.userContent,
    assistant: '',
    status: 'stopped' as const,
    createdAt: Date.now(),
    activities: stopped.activities,
  };

  return {
    messages: stopped.messages,
    request: requestStop(options.conversationId, stoppedTurn, {
      ...options.stopOptions,
      workspaceEpoch: options.workspaceEpoch,
      currentWorkspaceEpoch: options.currentWorkspaceEpoch,
      onSettled: options.onSettled,
    }),
  };
}
