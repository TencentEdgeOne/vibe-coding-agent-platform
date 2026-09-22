'use client';

import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { extractApiKeyFromUserText } from '../../../../shared/gateway-secret';
import type { Locale } from '@/app/i18n';
import {
  cacheConversationId,
  createConversationId,
  createMessageId,
  getOrCreateCachedConversationId,
} from '@/app/lib/conversation';
import type { AssistantStatus, ChatMessage, SessionPrepStage } from '@/app/types/workspace';
import { startPromptTurn } from '../workspace-api';
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
import { beginStop } from './live/stop';
import { useStoppingState } from './live/use-stopping';

export function useLiveTurn(options: {
  language: Locale;
  model: string;
  t: {
    response: {
      noDisplay: string;
      processingFailed: string;
      requestFailedPrefix: string;
      unknownError: string;
      agentFlowEnded: string;
    };
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
  const stoppingState = useStoppingState();
  const { stopping, setStopping, stopInFlightRef, resetStopping } = stoppingState;
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
    /** Real key from the input card. The visible turn is the prompt, not the key. */
    apiKey?: string;
  } = {}) {
    const trimmed = message.trim();
    if (!trimmed || loading || stopping || stopInFlightRef.current) return;

    const providedKey = (sendOptions.apiKey || '').trim();
    const extractedKey = providedKey ? null : extractApiKeyFromUserText(trimmed);
    const inboundApiKey = providedKey || extractedKey?.apiKey;
    const displayMessage = extractedKey?.maskedText || trimmed;

    const isDeploy = sendOptions.deploy === true;
    const isStartingFromHome = !isDeploy
      && !providedKey
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
        startedAt: Date.now(),
      },
    ];
    if (!isStartingFromHome) {
      setMessages((current) => [...current, ...turnMessages]);
    }
    if (!isDeploy && !providedKey) {
      setInput('');
    }
    if (inboundApiKey) {
      workspace.setGatewayNeeded(false);
      workspace.setGatewayDeferred(false);
      workspace.setGatewayConfigured(true);
      workspace.setGatewaySavedVisible(false);
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
      // A deploy click and an API key card are ordinary user turns. The card's
      // message is the masked key; the system prompt says what to do with it.
      // The flags only keep this from touching the composer or opening a project.
      const response = await startPromptTurn({
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
        chatAbortControllerRef.current = null;
        activeTurnIdRef.current = '';
        stoppingRef.current = false;
        return;
      }
      if (providedKey) {
        workspace.setGatewayNeeded(true);
        workspace.setGatewayConfigured(false);
        workspace.setGatewaySavedVisible(false);
        workspace.setGatewayBusy(false);
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
      chatAbortControllerRef.current = null;
      activeTurnIdRef.current = '';
      stoppingRef.current = false;
    }
  }

  function stopCurrentTask(stopOptions: { discardProject?: boolean } = {}) {
    const cid = conversationIdRef.current || conversationId;
    if (!loadingRef.current || !cid || stoppingRef.current || stopInFlightRef.current) return null;
    stoppingRef.current = true;
    stopInFlightRef.current = true;
    setStopping(true);
    const workspaceEpoch = workspaceEpochRef.current;
    const stop = beginStop({
      conversationId: cid,
      messages: messagesRef.current,
      activeTurnId: activeTurnIdRef.current,
      stopOptions,
      workspaceEpoch,
      currentWorkspaceEpoch: () => workspaceEpochRef.current,
      onSettled: () => {
        stopInFlightRef.current = false;
        setStopping(false);
      },
    });
    setMessages(stop.messages);
    setLoading(false);
    setSessionPreparing(false);
    setPrepStage(null);
    workspace.setGatewayNeeded(false);
    workspace.setGatewayBusy(false);
    workspace.setGatewaySavedVisible(false);
    chatAbortControllerRef.current?.abort();
    return stop.request;
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
    stopping,
    resetStopping,
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
