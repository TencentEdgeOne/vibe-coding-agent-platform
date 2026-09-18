import type { SessionPrepStage } from '../../types/workspace';

const STAGE_RANGE: Record<SessionPrepStage, { floor: number; ceiling: number; durationMs: number }> = {
  conversation: { floor: 8, ceiling: 28, durationMs: 900 },
  sandbox: { floor: 32, ceiling: 52, durationMs: 2_400 },
  agent: { floor: 56, ceiling: 86, durationMs: 14_000 },
  workspace: { floor: 70, ceiling: 88, durationMs: 8_000 },
  preview: { floor: 88, ceiling: 96, durationMs: 4_000 },
  ready: { floor: 100, ceiling: 100, durationMs: 0 },
};

export function prepStageRange(stage: SessionPrepStage | null) {
  return STAGE_RANGE[stage || 'conversation'];
}
