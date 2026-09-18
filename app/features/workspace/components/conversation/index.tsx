'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown } from 'lucide-react';
import { SHOW_ACTIVITY_STYLE_TOGGLE, useActivityStyle } from '../../hooks/use-activity-style';
import { AssistantTurn } from './assistant-turn';
import { Composer } from './composer';
import { DeployOffer } from './deploy-offer';
import { GatewayPrompt } from './gateway-prompt';
import { StyleToggle } from './style-toggle';
import { UserTurn } from './user-turn';
import type {
  ConversationCopy,
  ConversationMessage,
  DeployOfferCopy,
  GatewayPromptCopy,
  ModelOption,
} from './types';

export type { ConversationMessage, DeployOfferCopy, GatewayPromptCopy };

function messageSignature(message: ConversationMessage) {
  const activities = message.activities?.map((activity) => {
    if (activity.kind === 'text' || activity.kind === 'thinking') return activity.content;
    if (activity.kind === 'info') return `${activity.infoType}:${activity.content}`;
    return `${activity.toolUseId}:${activity.status}:${activity.inputSummary || ''}:${activity.outputSummary || ''}`;
  }).join('|');
  return [message.id, message.status, message.content, activities].join(':');
}

export const AgentConversation = memo(function AgentConversation({
  messages,
  input,
  loading,
  canSend,
  compact,
  copy,
  models,
  model,
  onModelChange,
  onInputChange,
  onSubmit,
  onStop,
  deployOffer,
  onDeployOffer,
  onDismissDeployOffer,
  gatewayPrompt,
  gatewayChip,
  gatewaySaved,
  gatewayBusy,
  onGatewaySubmit,
  onGatewaySkip,
  onGatewayReopen,
}: {
  messages: ConversationMessage[];
  input: string;
  loading: boolean;
  canSend: boolean;
  compact: boolean;
  copy: ConversationCopy;
  models: readonly ModelOption[];
  model: string;
  onModelChange: (model: string) => void;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  deployOffer?: DeployOfferCopy | null;
  onDeployOffer?: () => void;
  onDismissDeployOffer?: () => void;
  gatewayPrompt?: GatewayPromptCopy | null;
  gatewayChip?: string | null;
  gatewaySaved?: string | null;
  gatewayBusy?: boolean;
  onGatewaySubmit?: (values: { apiKey: string }) => void;
  onGatewaySkip?: () => void;
  onGatewayReopen?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followOutputRef = useRef(true);
  const [following, setFollowing] = useState(true);
  const { style, setStyle } = useActivityStyle();
  const signature = useMemo(() => {
    const last = messages[messages.length - 1];
    if (!last) return '0';
    if (last.status === 'running') {
      return `${messages.length}:${messageSignature(last)}`;
    }
    return `${messages.length}:${last.id}:${last.status}:${last.content.length}`;
  }, [messages]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node && followOutputRef.current) node.scrollTop = node.scrollHeight;
  }, [signature]);

  const scrollToLatest = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
    followOutputRef.current = true;
    setFollowing(true);
  }, []);

  return (
    <div className={`agent-conversation min-w-0 w-full overflow-hidden ${compact ? 'agent-conversation-compact' : ''}`}>
      {SHOW_ACTIVITY_STYLE_TOGGLE && (
        <StyleToggle style={style} copy={copy} onStyleChange={setStyle} />
      )}
      {/* The button anchors to the bottom of the stream rather than to the
          column, whose dock grows and shrinks with the offers above it. */}
      <div className="conversation-viewport">
        <div
          ref={scrollRef}
          className="conversation-scroll scroll-quiet"
          onScroll={(event) => {
            const node = event.currentTarget;
            const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 72;
            followOutputRef.current = nearBottom;
            setFollowing((current) => (current === nearBottom ? current : nearBottom));
          }}
        >
          <div className="conversation-stream">
            {messages.map((message) => message.role === 'user' ? (
              <UserTurn key={message.id} content={message.content} copy={copy} />
            ) : (
              <AssistantTurn key={message.id} message={message} style={style} copy={copy} />
            ))}
          </div>
        </div>
        {!following && (
          <button
            type="button"
            onClick={scrollToLatest}
            className="conversation-scroll-latest"
            aria-label={copy.scrollToLatest}
          >
            <ArrowDown aria-hidden="true" />
            <span>{copy.scrollToLatest}</span>
          </button>
        )}
      </div>
      <div className="conversation-composer-dock">
        <div className="conversation-card-stack">
          <GatewayPrompt
            gatewayPrompt={gatewayPrompt}
            gatewayChip={gatewayChip}
            gatewaySaved={gatewaySaved}
            gatewayBusy={gatewayBusy}
            onGatewaySubmit={onGatewaySubmit}
            onGatewaySkip={onGatewaySkip}
            onGatewayReopen={onGatewayReopen}
          />
          <DeployOffer
            deployOffer={deployOffer || null}
            onDeployOffer={onDeployOffer}
            onDismissDeployOffer={onDismissDeployOffer}
          />
        </div>
        <Composer
          input={input}
          loading={loading}
          canSend={canSend}
          copy={copy}
          models={models}
          model={model}
          onModelChange={onModelChange}
          onInputChange={onInputChange}
          onSubmit={onSubmit}
          onStop={onStop}
        />
      </div>
    </div>
  );
});
