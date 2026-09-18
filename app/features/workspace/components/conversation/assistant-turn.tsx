'use client';

import { memo, useMemo } from 'react';
import { CircleAlert } from 'lucide-react';
import {
  buildAssistantTimeline,
  lastTimelineText,
  trailingTimelineContent,
} from '@/app/lib/assistant-timeline';
import { withoutPlatformName } from '../../../../../shared/platform-name';
import { InfoBlock, ThinkingBlock, ToolBlock } from './activity-blocks';
import { Markdown } from './markdown';
import type { ConversationCopy, ConversationMessage } from './types';

export const AssistantTurn = memo(function AssistantTurn({ message, copy }: {
  message: ConversationMessage;
  copy: ConversationCopy;
}) {
  const activities = message.activities ?? [];
  const blocks = useMemo(() => buildAssistantTimeline(activities), [activities]);
  const lastText = lastTimelineText(blocks);
  const trailing = trailingTimelineContent(lastText?.content, message.content, message.status);
  const hasRunningTool = activities.some(
    (activity) => activity.kind === 'tool' && activity.status === 'running',
  );

  return (
    <section className="conversation-turn conversation-assistant-turn">
      <div className="conversation-body">
        {blocks.map((block) => {
          if (block.kind === 'text') {
            return <Markdown key={`text-${block.index}`} content={block.content} copy={copy} />;
          }
          if (block.kind === 'thinking') {
            return <ThinkingBlock key={`thinking-${block.index}`} content={block.content} copy={copy} />;
          }
          if (block.kind === 'info') {
            return <InfoBlock key={`info-${block.index}`} activity={block.activity} copy={copy} />;
          }
          return <ToolBlock key={block.activity.toolUseId || `tool-${block.index}`} activity={block.activity} copy={copy} />;
        })}
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
        {message.status === 'running' && !hasRunningTool && (
          <div className="agent-waiting" aria-label={copy.running}>
            <span />
            <span />
            <span />
          </div>
        )}
      </div>
    </section>
  );
});
