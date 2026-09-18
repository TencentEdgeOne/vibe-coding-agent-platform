'use client';

import { memo, useMemo } from 'react';
import { CircleAlert } from 'lucide-react';
import {
  buildAssistantTimeline,
  lastTimelineText,
  trailingTimelineContent,
} from '@/app/lib/assistant-timeline';
import { withoutPlatformName } from '../../../../../shared/platform-name';
import type { ActivityStyle } from '../../hooks/use-activity-style';
import { ActivityStream } from './activity-stream';
import { Markdown } from './markdown';
import type { ConversationCopy, ConversationMessage } from './types';

export const AssistantTurn = memo(function AssistantTurn({ message, style, copy }: {
  message: ConversationMessage;
  style: ActivityStyle;
  copy: ConversationCopy;
}) {
  const activities = message.activities ?? [];
  const blocks = useMemo(() => buildAssistantTimeline(activities), [activities]);
  const lastText = lastTimelineText(blocks);
  const trailing = trailingTimelineContent(lastText?.content, message.content, message.status);
  const running = message.status === 'running';
  const hasRunningTool = activities.some(
    (activity) => activity.kind === 'tool' && activity.status === 'running',
  );
  // Only the block still being written into counts as live; the ones above it
  // are finished thoughts even though the turn as a whole is not.
  const liveIndex = running ? blocks[blocks.length - 1]?.index : undefined;

  return (
    <section className="conversation-turn conversation-assistant-turn">
      <div className="conversation-body">
        <ActivityStream blocks={blocks} style={style} liveIndex={liveIndex} copy={copy} />
        {trailing && (
          message.status === 'error' ? (
            <div className="assistant-error-message" role="status">
              <CircleAlert aria-hidden="true" />
              <span>{withoutPlatformName(trailing)}</span>
            </div>
          ) : (
            <Markdown content={trailing} copy={copy} />
          )
        )}
        {running && !hasRunningTool && (
          <p className="agent-waiting" role="status">{copy.running}</p>
        )}
      </div>
    </section>
  );
});
