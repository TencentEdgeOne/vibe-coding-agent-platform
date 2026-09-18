'use client';

import { FormEvent, ReactNode, memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  Check,
  CircleAlert,
  Copy,
  Square,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  buildAssistantTimeline,
  lastTimelineText,
  trailingTimelineContent,
} from '../lib/assistant-timeline';
import { withoutPlatformName } from '../../shared/platform-name';
import { ModelPicker } from './model-picker';
import type { AssistantActivity } from '../../shared/protocol';
import type { ModelOption } from '../../shared/models';

export type ConversationMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  activities?: AssistantActivity[];
  status?: 'running' | 'done' | 'error' | 'stopped';
};

type ConversationCopy = {
  running: string;
  completed: string;
  failed: string;
  stopped: string;
  thinking: string;
  info: string;
  usage: string;
  compact: string;
  status: string;
  placeholder: string;
  send: string;
  stop: string;
  modelLabel: string;
  copyLink: string;
  linkCopied: string;
};

export type DeployOfferCopy = {
  prompt: string;
  deploy: string;
  dismiss: string;
};

export type GatewayPromptCopy = {
  title: string;
  docs: string;
  docsUrl: string;
  apiKey: string;
  continue: string;
  skip: string;
};

function infoLabel(
  infoType: Extract<AssistantActivity, { kind: 'info' }>['infoType'],
  copy: ConversationCopy,
) {
  if (infoType === 'usage') return copy.usage;
  if (infoType === 'compact') return copy.compact;
  if (infoType === 'status') return copy.status;
  return copy.info;
}

function statusLabel(status: Extract<AssistantActivity, { kind: 'tool' }>['status'], copy: ConversationCopy) {
  if (status === 'running') return copy.running;
  if (status === 'failed') return copy.failed;
  if (status === 'stopped') return copy.stopped;
  return copy.completed;
}

function formatTimestamp(value?: number) {
  if (!value) return '';
  try {
    return new Date(value).toISOString();
  } catch {
    return String(value);
  }
}

function maybeJson(value?: string) {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return value;
}

function formatToolDump(activity: Extract<AssistantActivity, { kind: 'tool' }>, copy: ConversationCopy) {
  return JSON.stringify({
    name: activity.name,
    id: activity.toolUseId,
    status: activity.status,
    statusLabel: statusLabel(activity.status, copy),
    command: activity.command || undefined,
    phaseHint: activity.phaseHint || undefined,
    fileCount: activity.fileCount,
    startedAt: formatTimestamp(activity.startedAt) || undefined,
    endedAt: formatTimestamp(activity.endedAt) || undefined,
    durationMs: activity.startedAt && activity.endedAt
      ? activity.endedAt - activity.startedAt
      : undefined,
    input: maybeJson(activity.inputSummary),
    output: maybeJson(activity.outputSummary),
  }, null, 2);
}

function ThinkingBlock({ content, copy }: { content: string; copy: ConversationCopy }) {
  return (
    <details open className="conversation-skeleton conversation-thinking">
      <summary>{copy.thinking}</summary>
      <pre>{content}</pre>
    </details>
  );
}

function InfoBlock({
  activity,
  copy,
}: {
  activity: Extract<AssistantActivity, { kind: 'info' }>;
  copy: ConversationCopy;
}) {
  const label = infoLabel(activity.infoType, copy);
  const title = activity.title && activity.title !== label ? `${label} · ${activity.title}` : label;
  return (
    <details open className="conversation-skeleton conversation-info">
      <summary>{title}</summary>
      {activity.content ? <pre>{activity.content}</pre> : null}
    </details>
  );
}

function ToolBlock({
  activity,
  copy,
}: {
  activity: Extract<AssistantActivity, { kind: 'tool' }>;
  copy: ConversationCopy;
}) {
  return (
    <details open className="conversation-skeleton conversation-tool">
      <summary>{activity.name} · {statusLabel(activity.status, copy)}</summary>
      <pre>{formatToolDump(activity, copy)}</pre>
    </details>
  );
}

function plainText(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(plainText).join('');
  return '';
}

function ConversationLink({ href, copy, children }: {
  href?: string;
  copy: ConversationCopy;
  children?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const url = href || '';
  // An address spelled out in full is something the user takes elsewhere. A link
  // behind words is meant to be followed, and a button beside it would only
  // crowd the sentence it sits in.
  const isAddress = Boolean(url) && plainText(children).trim() === url;

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const anchor = (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      dir={isAddress ? 'ltr' : undefined}
    >
      {children}
    </a>
  );

  if (!isAddress) {
    return anchor;
  }

  const label = copied ? copy.linkCopied : copy.copyLink;
  const handleCopy = async () => {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <span className="conversation-link">
      {anchor}
      <button
        type="button"
        onClick={() => void handleCopy()}
        className="conversation-link-copy"
        aria-label={label}
        title={label}
      >
        {copied ? <Check /> : <Copy />}
      </button>
    </span>
  );
}

function Markdown({ content, copy }: { content: string; copy: ConversationCopy }) {
  return (
    <div className="agent-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <ConversationLink href={href} copy={copy}>{children}</ConversationLink>
          ),
        }}
      >
        {withoutPlatformName(content)}
      </ReactMarkdown>
    </div>
  );
}

const AssistantTurn = memo(function AssistantTurn({ message, copy }: {
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

export function AgentConversation({
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
  gatewayBusy,
  onGatewaySubmit,
  onGatewaySkip,
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
  gatewayBusy?: boolean;
  onGatewaySubmit?: (values: { apiKey: string }) => void;
  onGatewaySkip?: () => void;
}) {
  const [gatewayApiKey, setGatewayApiKey] = useState('');
  const gatewayInputRef = useRef<HTMLInputElement | null>(null);
  const gatewayVisible = Boolean(gatewayPrompt);

  useEffect(() => {
    if (!gatewayVisible) {
      setGatewayApiKey('');
      return;
    }
    // The card mounts only after the assistant turn has finished, so focus
    // can land immediately instead of waiting on a disabled input.
    const node = gatewayInputRef.current;
    if (!node || node.disabled) return;
    node.focus();
  }, [gatewayVisible]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followOutputRef = useRef(true);
  const signature = messages.map((message) => [
    message.id,
    message.status,
    message.content,
    message.activities?.map((activity) => {
      if (activity.kind === 'text' || activity.kind === 'thinking') return activity.content;
      if (activity.kind === 'info') return `${activity.infoType}:${activity.content}`;
      return `${activity.toolUseId}:${activity.status}:${activity.inputSummary || ''}:${activity.outputSummary || ''}`;
    }).join('|'),
  ].join(':')).join('\n');

  useEffect(() => {
    const node = scrollRef.current;
    if (node && followOutputRef.current) node.scrollTop = node.scrollHeight;
  }, [signature]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };

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
        {gatewayPrompt && (
          <form
            className="gateway-prompt"
            onSubmit={(event) => {
              event.preventDefault();
              if (gatewayBusy) return;
              onGatewaySubmit?.({
                apiKey: gatewayApiKey.trim(),
              });
            }}
          >
            <div className="gateway-prompt-copy">
              <p className="gateway-prompt-title">{gatewayPrompt.title}</p>
              <p className="gateway-prompt-docs">
                <a
                  href={gatewayPrompt.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {gatewayPrompt.docs}
                </a>
              </p>
            </div>
            <label className="gateway-prompt-field">
              <span>{gatewayPrompt.apiKey}</span>
              <input
                ref={gatewayInputRef}
                type="password"
                autoComplete="off"
                autoFocus
                spellCheck={false}
                value={gatewayApiKey}
                disabled={gatewayBusy}
                onChange={(event) => setGatewayApiKey(event.target.value)}
              />
            </label>
            <div className="gateway-prompt-actions">
              <button
                type="button"
                className="deploy-offer-dismiss"
                disabled={gatewayBusy}
                onClick={onGatewaySkip}
              >
                {gatewayPrompt.skip}
              </button>
              <button
                type="submit"
                className="deploy-offer-accept"
                disabled={gatewayBusy || !gatewayApiKey.trim()}
              >
                {gatewayPrompt.continue}
              </button>
            </div>
          </form>
        )}
        {deployOffer && (
          <div className="deploy-offer" role="status">
            <span className="deploy-offer-copy">{deployOffer.prompt}</span>
            <div className="deploy-offer-actions">
              <button
                type="button"
                className="deploy-offer-dismiss"
                onClick={onDismissDeployOffer}
              >
                {deployOffer.dismiss}
              </button>
              <button
                type="button"
                className="deploy-offer-accept"
                onClick={onDeployOffer}
              >
                {deployOffer.deploy}
              </button>
            </div>
          </div>
        )}
      <form onSubmit={submit} className="conversation-composer">
        <textarea
          value={input}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (!loading && canSend) onSubmit();
            }
          }}
          placeholder={copy.placeholder}
          rows={1}
        />
        {/* Locked mid-run: the turn already went out on a model, and letting the
            control move would show one name while another was answering. */}
        <ModelPicker
          models={models}
          value={model}
          ariaLabel={copy.modelLabel}
          disabled={loading}
          onChange={onModelChange}
        />
        {loading ? (
          <button type="button" className="composer-stop" onClick={onStop} title={copy.stop} aria-label={copy.stop}>
            <Square className="size-3" fill="currentColor" />
          </button>
        ) : (
          <button type="submit" className="composer-send" disabled={!canSend} title={copy.send} aria-label={copy.send}>
            <ArrowUp className="size-4" />
          </button>
        )}
      </form>
      </div>
    </div>
  );
}
