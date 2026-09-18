'use client';

import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { extractApiKeyFromUserText } from '../../../../shared/gateway-secret';
import { STOPPED_TURN_REPLY } from '../../../../shared/user-facing-reply';
import type { Locale } from '@/app/i18n';
import {
  cacheConversationId,
  createConversationId,
  createMessageId,
  getOrCreateCachedConversationId,
  markLastTurnStopped,
} from '@/app/lib/conversation';
import type {
  AssistantStatus,
  ChatMessage,
  SessionPrepStage,
} from '@/app/types/workspace';
import {
  startDeployTurn,
  startPromptTurn,
  stopChatTask,
} from '../workspace-api';
import type { PreviewSurfaceApi } from './use-preview-surface';
import type { WorkspaceStateApi } from './use-workspace-state';
import type { WorkspaceSnapshotApi } from './use-workspace-snapshot';
import { runCreateSessionPrep } from './live/session-prep';
import {
  attachChatStream as attachLiveChatStream,
  createLiveChatSession,
  type LiveChatSession,
} from './live/stream-handlers';
import { createApplyGateway } from './live/use-gateway';

type LiveCopy = {
  noDisplay: string;
  processingFailed: string;
  requestFailedPrefix: string;
  unknownError: string;
  agentFlowEnded: string;
};

export function useLiveTurn(options: {
  language: Locale;
  model: string;
  t: {
    response: LiveCopy;
    workspace: {
      deployRequest: string;
    };
  };
  workspace: WorkspaceStateApi;
  preview: PreviewSurfaceApi;
  snapshot: WorkspaceSnapshotApi;
  conversationId: string | null;
  setConversationId: (id: string | null) => void;
  conversationIdRef: MutableRefObject<string | null>;
  workspaceEpochRef: MutableRefObject<number>;
  loadingRef: MutableRefObject<boolean>;
}) {
  const {
    language,
    model,
    t,
    workspace,
    preview,
    snapshot,
    conversationId,
    setConversationId,
    conversationIdRef,
    workspaceEpochRef,
    loadingRef,
  } = options;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessionPreparing, setSessionPreparing] = useState(false);
  const [prepStage, setPrepStage] = useState<SessionPrepStage | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const modelRef = useRef(model);
  const chatAbortControllerRef = useRef<AbortController | null>(null);
  const activeTurnIdRef = useRef('');
  const stoppingRef = useRef(false);

  modelRef.current = model;

  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => () => {
    chatAbortControllerRef.current?.abort();
    chatAbortControllerRef.current = null;
  }, []);

  const startLiveChatSessionRef = useRef<(opts: {
    requestConversationId: string;
    assistantMessageId: string;
    abortController: AbortController;
  }) => Pick<LiveChatSession, 'handleStreamEvent' | 'finish'>>(() => ({
    handleStreamEvent: () => {},
    finish: () => {},
  }));

  function startLiveChatSession(sessionOptions: {
    requestConversationId: string;
    assistantMessageId: string;
    abortController: AbortController;
  }) {
    return createLiveChatSession({
      ...sessionOptions,
      workspaceEpoch: workspaceEpochRef.current,
      workspaceEpochRef,
      conversationIdRef,
      chatAbortControllerRef,
      stoppingRef,
      activeTurnIdRef,
      noDisplay: t.response.noDisplay,
      processingFailed: t.response.processingFailed,
      agentFlowEnded: t.response.agentFlowEnded,
      workspace,
      preview,
      snapshot,
      setConversationId,
      setMessages,
      setLoading,
    });
  }

  startLiveChatSessionRef.current = startLiveChatSession;

  async function sendMessage(message: string, sendOptions: {
    deploy?: boolean;
  } = {}) {
    const trimmed = message.trim();
    if (!trimmed || loading) return;

    const extractedKey = extractApiKeyFromUserText(trimmed);
    const inboundApiKey = extractedKey?.apiKey;
    const displayMessage = extractedKey?.maskedText || trimmed;

    const isDeploy = sendOptions.deploy === true;
    const isStartingFromHome = !isDeploy
      && messages.length === 0
      && !preview.preview
      && !workspace.deployment
      && !workspace.build
      && !workspace.fileTree;
    const requestConversationId = isStartingFromHome
      ? createConversationId()
      : conversationId || getOrCreateCachedConversationId();
    if (isStartingFromHome) {
      cacheConversationId(requestConversationId);
      setConversationId(requestConversationId);
      preview.resetPreview();
      workspace.resetWorkspace();
    } else if (!conversationId) {
      setConversationId(requestConversationId);
    }

    const userMessageId = createMessageId('user');
    const assistantMessageId = createMessageId('assistant');
    activeTurnIdRef.current = assistantMessageId;

    const turnMessages: ChatMessage[] = [
      { id: userMessageId, role: 'user', content: displayMessage },
      {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        activities: [],
        status: 'running',
      },
    ];
    if (!isStartingFromHome) {
      setMessages((current) => [...current, ...turnMessages]);
    }
    if (!isDeploy) {
      workspace.setFilesRefreshing(true);
      setInput('');
    }
    if (inboundApiKey) {
      workspace.setGatewayNeeded(false);
      workspace.setGatewayBusy(false);
    }
    setLoading(true);
    if (isStartingFromHome) setSessionPreparing(true);

    try {
      const requestAbortController = new AbortController();
      chatAbortControllerRef.current = requestAbortController;
      stoppingRef.current = false;
        if (isStartingFromHome) {
          await runCreateSessionPrep({
            conversationId: requestConversationId,
            signal: requestAbortController.signal,
            model: modelRef.current,
            language,
            setPrepStage,
            // `ready` can precede the end of the prep stream; drop the overlay there
            // instead of waiting for the remaining stages to close it.
            onReady: () => {
              setMessages(turnMessages);
              setSessionPreparing(false);
            },
          });
          setMessages(turnMessages);
          setSessionPreparing(false);
          setPrepStage(null);
        }
      const response = isDeploy
        ? await startDeployTurn({
            conversationId: requestConversationId,
            turnId: assistantMessageId,
            language,
            ...(inboundApiKey ? { apiKey: inboundApiKey } : {}),
            signal: requestAbortController.signal,
          })
        : await startPromptTurn({
            conversationId: requestConversationId,
            message: displayMessage,
            turnId: assistantMessageId,
            model: modelRef.current,
            language,
            ...(inboundApiKey ? { apiKey: inboundApiKey } : {}),
            signal: requestAbortController.signal,
          });
      await attachLiveChatStream({
        requestConversationId,
        assistantMessageId,
        response,
        abortController: requestAbortController,
        requestFailedPrefix: t.response.requestFailedPrefix,
        unknownError: t.response.unknownError,
        workspaceEpoch: workspaceEpochRef.current,
        workspaceEpochRef,
        conversationIdRef,
        chatAbortControllerRef,
        stoppingRef,
        activeTurnIdRef,
        noDisplay: t.response.noDisplay,
        processingFailed: t.response.processingFailed,
        agentFlowEnded: t.response.agentFlowEnded,
        workspace,
        preview,
        snapshot,
        setConversationId,
        setMessages,
        setLoading,
      });
    } catch (error) {
      if ((error instanceof Error && error.name === 'AbortError') || stoppingRef.current) {
        setSessionPreparing(false);
        setPrepStage(null);
        setLoading(false);
        workspace.setFilesRefreshing(false);
        chatAbortControllerRef.current = null;
        activeTurnIdRef.current = '';
        stoppingRef.current = false;
        return;
      }
      const msg = `${t.response.requestFailedPrefix}${error instanceof Error ? error.message : t.response.unknownError}`;
      setMessages((current) =>
        current.map((item) =>
          item.id === assistantMessageId
            ? {
                ...item,
                content: msg,
                status: 'error' as AssistantStatus,
              }
            : item,
        ),
      );
      setLoading(false);
      setSessionPreparing(false);
      setPrepStage(null);
      workspace.setFilesRefreshing(false);
      chatAbortControllerRef.current = null;
      activeTurnIdRef.current = '';
      stoppingRef.current = false;
    }
  }

  function stopCurrentTask(stopOptions: { discardProject?: boolean } = {}) {
    const cid = conversationIdRef.current || conversationId;
    if (!loadingRef.current || !cid || stoppingRef.current) return null;
    stoppingRef.current = true;
    const stoppedText = STOPPED_TURN_REPLY[language];
    const stopped = markLastTurnStopped(messagesRef.current, stoppedText);
    setMessages(stopped.messages);
    setLoading(false);
    setSessionPreparing(false);
    setPrepStage(null);
    workspace.setFilesRefreshing(false);
    workspace.setGatewayNeeded(false);
    workspace.setGatewayBusy(false);

    const stoppedTurn = {
      id: activeTurnIdRef.current,
      user: stopped.userContent,
      assistant: stoppedText,
      status: 'stopped' as const,
      createdAt: Date.now(),
      activities: stopped.activities,
    };

    const stopRequest = stopChatTask(cid, stoppedTurn, stopOptions).catch(() => null);
    chatAbortControllerRef.current?.abort();
    return stopRequest;
  }

  const applyGateway = createApplyGateway({
    workspace,
    preview,
    conversationId,
    conversationIdRef,
  });

  return {
    messages,
    setMessages,
    input,
    setInput,
    loading,
    setLoading,
    loadingRef,
    messagesRef,
    chatAbortControllerRef,
    activeTurnIdRef,
    stoppingRef,
    startLiveChatSessionRef,
    sendMessage,
    applyGateway,
    stopCurrentTask,
    sessionPreparing,
    setSessionPreparing,
    prepStage,
    setPrepStage,
  };
}

export type LiveTurnApi = ReturnType<typeof useLiveTurn>;
