import { saveProjectState } from '../session/store.ts';
import type { AgentProgressEvent, ProjectState } from '../types.ts';
import type { ProjectCheckpointController } from './checkpoint.ts';
import { applyStreamEvent } from '../../../shared/timeline.ts';
import type { PersistedActivityTurn } from '../../../shared/protocol.ts';

type TurnStatus = 'completed' | 'failed' | 'stopped';

type TurnLifecycleOptions = {
  context: any;
  conversationId: string;
  message: string;
  turnId: string;
  state: ProjectState;
  checkpoint: ProjectCheckpointController;
};

/** Owns in-memory progress folding and the durable commit order for one turn. */
export function createTurnLifecycle(options: TurnLifecycleOptions) {
  let turn: PersistedActivityTurn = {
    id: options.turnId,
    user: options.message,
    assistant: '',
    status: 'completed',
    createdAt: Date.now(),
    activities: [],
  };

  const recordProgress = (event: AgentProgressEvent) => {
    turn = applyStreamEvent(turn, event);
  };

  const finalize = async (
    assistant: string,
    status: TurnStatus,
    finalizeOptions?: { withSnapshot?: boolean; withState?: boolean },
  ) => {
    turn = { ...turn, assistant, status };
    if (status === 'stopped') {
      turn = {
        ...turn,
        activities: turn.activities.map((activity) => (
          activity.kind === 'tool' && activity.status === 'running'
            ? { ...activity, status: 'stopped' as const, endedAt: Date.now() }
            : activity
        )),
      };
    }

    if (finalizeOptions?.withSnapshot === true) await options.checkpoint.flush();
    if (finalizeOptions?.withState !== false) {
      await saveProjectState(options.context, options.conversationId, options.state);
    }
  };

  return { recordProgress, finalize };
}
