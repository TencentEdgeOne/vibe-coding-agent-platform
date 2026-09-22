'use client';

import { useEffect, useState } from 'react';
import {
  resolveAgentElapsed,
  resolveAgentStatusBarPhase,
} from './agent-status-bar-phase';
import type { AgentTurnStatus, ConversationCopy, ConversationMessage } from './types';

export function AgentStatusBar({ status, preparing, sticky, copy, message }: {
  status: AgentTurnStatus;
  preparing: boolean;
  sticky: boolean;
  copy: ConversationCopy;
  message: Pick<ConversationMessage, 'status' | 'startedAt' | 'endedAt' | 'activities'>;
}) {
  const [now, setNow] = useState(() => Date.now());
  const active = status === 'running';
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);

  const state = resolveAgentStatusBarPhase(status, preparing);
  const label = state === 'preparing'
    ? copy.preparingAgent
    : state === 'running'
      ? copy.running
      : state === 'completed'
        ? copy.completed
        : state === 'failed'
          ? copy.failed
          : copy.stopped;
  const elapsed = resolveAgentElapsed(message, now);

  return (
    <div
      className={`agent-status-bar is-${state}${active ? ' is-active' : ''}${sticky ? ' is-sticky' : ''}`}
      role="status"
      aria-live="polite"
    >
      {active && (
        <span className="agent-status-bar-indicator" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      )}
      <span className="agent-status-bar-label">{label}</span>
      {elapsed && <span className="agent-status-bar-elapsed">{elapsed}</span>}
    </div>
  );
}
