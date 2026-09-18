'use client';

import { useEffect, useState } from 'react';
import type { SessionPrepStage } from '@/app/types/workspace';
import { prepStageRange } from '../session-prep-progress';

function usePrepProgress(stage: SessionPrepStage | null) {
  const { floor, ceiling, durationMs } = prepStageRange(stage);
  const [value, setValue] = useState(floor);

  useEffect(() => {
    setValue((current) => Math.max(current, floor));
    if (durationMs <= 0 || ceiling <= floor) {
      setValue(ceiling);
      return;
    }

    const startedAt = Date.now();
    let frame = 0;
    const tick = () => {
      const t = Math.min(1, (Date.now() - startedAt) / durationMs);
      const eased = 1 - (1 - t) ** 2;
      setValue((current) => Math.max(current, floor + (ceiling - floor) * eased));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [stage, floor, ceiling, durationMs]);

  return value;
}

export function SessionPrepLoading(options: {
  stage: SessionPrepStage | null;
  title: string;
  stageLabel: string;
}) {
  const progress = usePrepProgress(options.stage);

  return (
    <main className="app-shell session-prep" aria-busy="true">
      <div className="session-prep-card">
        <h1 className="session-prep-title">{options.title}</h1>
        <div
          className="session-prep-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress)}
          aria-label={options.stageLabel}
        >
          <span className="session-prep-bar-fill" style={{ width: `${progress}%` }} />
        </div>
        <p className="session-prep-stage" aria-live="polite">{options.stageLabel}</p>
      </div>
    </main>
  );
}
