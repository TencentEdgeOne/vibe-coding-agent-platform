'use client';

import { memo, useEffect, useMemo, useRef } from 'react';
import { AssistantTurn } from './assistant-turn';
import { Composer } from './composer';
import { DeployOffer } from './deploy-offer';
import { GatewayPrompt } from './gateway-prompt';
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

  return (
    <div className={`agent-conversation min-w-0 w-full overflow-hidden ${compact ? 'agent-conversation-compact' : ''}`}>
      <div
        ref={scrollRef}
        className="conversation-scroll scroll-quiet"
        onScroll={(event) => {
          const node = event.currentTarget;
          followOutputRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 72;
        }}
      >
        <div className="conversation-stream">
          {messages.map((message) => message.role === 'user' ? (
            <section key={message.id} className="conversation-turn conversation-user-turn">
              <div className="conversation-body whitespace-pre-wrap">{message.content}</div>
            </section>
          ) : (
            <AssistantTurn key={message.id} message={message} copy={copy} />
          ))}
        </div>
      </div>
      <div className="conversation-composer-dock">
        <GatewayPrompt
          gatewayPrompt={gatewayPrompt}
          gatewayChip={gatewayChip}
          gatewaySaved={gatewaySaved}
          gatewayBusy={gatewayBusy}
          onGatewaySubmit={onGatewaySubmit}
          onGatewaySkip={onGatewaySkip}
          onGatewayReopen={onGatewayReopen}
        />
        {deployOffer && (
          <DeployOffer
            deployOffer={deployOffer}
            onDeployOffer={onDeployOffer}
            onDismissDeployOffer={onDismissDeployOffer}
          />
        )}
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
