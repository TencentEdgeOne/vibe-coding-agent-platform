'use client';

import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import {
  applyStreamEvent,
  dropTrailingSummaryEcho,
} from '../../../../shared/timeline';
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
  ChatResponse,
  ChatStreamEvent,
  SessionPrepStage,
  SessionStreamEvent,
} from '@/app/types/workspace';
import { consumeEventStream } from '../sse';
import {
  applyGatewayDecision,
  openSessionStream,
  startDeployTurn,
  startPromptTurn,
  stopChatTask,
} from '../workspace-api';
import type { PreviewSurfaceApi } from './use-preview-surface';
import type { WorkspaceStateApi } from './use-workspace-state';
import type { WorkspaceSnapshotApi } from './use-workspace-snapshot';
import type { PersistedActivityTurn } from '../../../../shared/protocol';

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
  }) => {
    handleStreamEvent: (event: ChatStreamEvent) => void;
    finish: () => void;
  }>(() => ({
    handleStreamEvent: () => {},
    finish: () => {},
  }));

  function startLiveChatSession(sessionOptions: {
    requestConversationId: string;
    assistantMessageId: string;
    abortController: AbortController;
  }) {
    const { assistantMessageId } = sessionOptions;
    const workspaceEpoch = workspaceEpochRef.current;
    const requestAbortController = sessionOptions.abortController;
    const activatedPreviewRevisions = new Map<string, number>();
    let sawProjectActivity = false;
    let openedFirstFile = false;
    let pendingFirstFilePath: string | null = null;

    const revealFirstFile = (path: string) => {
      if (openedFirstFile || !path) return;
      openedFirstFile = true;
      pendingFirstFilePath = null;
      workspace.setFilesFocusPath(path);
    };

    const patchAssistant = (patch: Partial<ChatMessage>) => {
      setMessages((current) =>
        current.map((item) =>
          item.id === assistantMessageId ? { ...item, ...patch } : item,
        ),
      );
    };

    const foldActivityEvent = (event: ChatStreamEvent) => {
      setMessages((current) =>
        current.map((item) => {
          if (item.id !== assistantMessageId) return item;
          const folded = applyStreamEvent({
            id: item.id,
            user: '',
            assistant: item.content,
            status: 'completed',
            createdAt: 0,
            activities: item.activities ?? [],
          } satisfies PersistedActivityTurn, event);
          return { ...item, activities: folded.activities };
        }),
      );
    };

    const finalizeAssistant = (
      finalContent: string,
      finalStatus: AssistantStatus,
    ) => {
      workspace.setGatewayBusy(false);
      setMessages((current) =>
        current.map((item) =>
          item.id === assistantMessageId
            ? {
                ...item,
                content: finalContent,
                activities: dropTrailingSummaryEcho(
                  item.activities ?? [],
                  finalContent,
                ).map((activity) =>
                  activity.kind === 'tool' && activity.status === 'running'
                    ? {
                        ...activity,
                        status: finalStatus === 'stopped'
                          ? 'stopped' as const
                          : finalStatus === 'error'
                            ? 'failed' as const
                            : 'completed' as const,
                        endedAt: Date.now(),
                      }
                    : activity,
                ),
                status: finalStatus,
              }
            : item,
        ),
      );
    };

    const applyResponse = (data: ChatResponse) => {
      if (data.conversation_id) {
        cacheConversationId(data.conversation_id);
        setConversationId(data.conversation_id);
      }
      workspace.setFilesRefreshing(false);

      const finalText = data.reply || data.error || t.response.noDisplay;
      const finalStatus: AssistantStatus = data.stopped ? 'stopped' : data.ok === false ? 'error' : 'done';
      finalizeAssistant(finalText, finalStatus);
      const cid = data.conversation_id || sessionOptions.requestConversationId;
      if (cid) void snapshot.refresh(cid);
    };

    const handleStreamEvent = (event: ChatStreamEvent) => {
      if (workspaceEpoch !== workspaceEpochRef.current) return;
      if (event.type === 'task_started') {
        if (event.data?.conversation_id) {
          cacheConversationId(event.data.conversation_id);
          setConversationId(event.data.conversation_id);
        }
        return;
      }
      if (event.type === 'ping') return;
      if (event.type === 'gateway_credentials') {
        if (event.data?.status === 'needed') {
          workspace.setGatewayNeeded(true);
          workspace.setGatewayDeferred(false);
          workspace.setGatewayBusy(false);
        }
        if (event.data?.status === 'resolved') {
          workspace.setGatewayNeeded(false);
          workspace.setGatewayBusy(false);
          if (event.data.skipped) {
            workspace.setGatewayDeferred(true);
            workspace.setGatewayConfigured(false);
          } else {
            workspace.setGatewayDeferred(false);
            workspace.setGatewayConfigured(true);
            workspace.setGatewayPromptVariant('default');
          }
        }
        return;
      }
      if (event.type === 'result' && event.data) {
        applyResponse(event.data);
        setLoading(false);
        return;
      }
      if (event.type === 'agent' && event.data) {
        const agentData = event.data;
        const text = agentData.reply || agentData.error || t.response.noDisplay;
        if (!sawProjectActivity) {
          finalizeAssistant(text, agentData.ok === false ? 'error' : 'done');
          return;
        }
        patchAssistant({ content: text });
        return;
      }
      if (event.type === 'text_segment' || event.type === 'thinking_segment' || event.type === 'system_info' || event.type === 'tool_use' || event.type === 'tool_result') {
        if (event.type === 'tool_use' || event.type === 'tool_result') sawProjectActivity = true;
        foldActivityEvent(event);
        return;
      }
      if (event.type === 'file_changed' && event.data?.paths?.length) {
        sawProjectActivity = true;
        const paths = event.data.paths.filter(Boolean);
        const cid = conversationIdRef.current || sessionOptions.requestConversationId;
        if (cid && paths.length > 0) {
          void snapshot.pullFiles(cid, paths).then(() => {
            if (!openedFirstFile && paths[0]) revealFirstFile(paths[0]);
          });
        } else if (!openedFirstFile && paths[0]) {
          pendingFirstFilePath = paths[0];
        }
        return;
      }
      if (event.type === 'file_tree' && event.data) {
        sawProjectActivity = true;
        workspace.setFileTree(event.data);
        workspace.setFilesRefreshing(false);
        if (pendingFirstFilePath) {
          revealFirstFile(pendingFirstFilePath);
        }
        return;
      }
      if (event.type === 'deployment_status' && event.data) {
        sawProjectActivity = true;
        workspace.setDeployment(event.data);
        return;
      }
      if (event.type === 'preview_ready' && event.data) {
        sawProjectActivity = true;
        if (event.data.preview) {
          preview.activatePreview(event.data.preview, activatedPreviewRevisions);
        }
        if (event.data.download) {
          workspace.setDownload(event.data.download);
        }
        return;
      }
      if (event.type === 'error') {
        finalizeAssistant(event.error || t.response.processingFailed, 'error');
        setLoading(false);
      }
    };

    const finish = () => {
      const ownsActiveWorkspace = workspaceEpoch === workspaceEpochRef.current
        && chatAbortControllerRef.current === requestAbortController;
      if (ownsActiveWorkspace) {
        if (!stoppingRef.current) {
          setMessages((current) =>
            current.map((item) =>
              item.id === assistantMessageId && item.status === 'running'
                ? {
                    ...item,
                    status: 'done',
                    content: item.content || t.response.agentFlowEnded,
                  }
                : item,
            ),
          );
        }
        setLoading(false);
        workspace.setFilesRefreshing(false);
        chatAbortControllerRef.current = null;
        if (!stoppingRef.current) {
          activeTurnIdRef.current = '';
        }
        stoppingRef.current = false;
      }
    };

    return { handleStreamEvent, finish, applyResponse, finalizeAssistant };
  }

  startLiveChatSessionRef.current = startLiveChatSession;

  async function attachChatStream(attachOptions: {
    requestConversationId: string;
    assistantMessageId: string;
    response: Response;
    abortController: AbortController;
  }) {
    const session = startLiveChatSession(attachOptions);
    try {
      chatAbortControllerRef.current = attachOptions.abortController;
      stoppingRef.current = false;

      const contentType = attachOptions.response.headers.get('content-type') || '';
      if (!attachOptions.response.body || !contentType.includes('text/event-stream')) {
        session.applyResponse((await attachOptions.response.json().catch(() => ({
          ok: false,
          error: `${attachOptions.response.status}`,
        }))) as ChatResponse);
        return;
      }

      await consumeEventStream<ChatStreamEvent>(attachOptions.response, session.handleStreamEvent);
    } catch (error) {
      if ((error instanceof Error && error.name === 'AbortError') || stoppingRef.current) {
        return;
      }
      const msg = `${t.response.requestFailedPrefix}${error instanceof Error ? error.message : t.response.unknownError}`;
      session.finalizeAssistant(msg, 'error');
    } finally {
      session.finish();
    }
  }

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
          try {
            const resumeResponse = await openSessionStream(
              requestConversationId,
              requestAbortController.signal,
              {
                model: modelRef.current,
                language,
                mode: 'create',
              },
            );
            const resumeType = resumeResponse.headers.get('content-type') || '';
            if (
              resumeResponse.ok
              && resumeResponse.body
              && resumeType.includes('text/event-stream')
            ) {
              await consumeEventStream<SessionStreamEvent>(resumeResponse, (event) => {
                if (event.type !== 'session_prep' || !event.data?.stage) return;
                if (event.data.status === 'running' || event.data.stage === 'ready') {
                  setPrepStage(event.data.stage);
                }
              });
            }
          } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') throw error;
          }
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
      await attachChatStream({
        requestConversationId,
        assistantMessageId,
        response,
        abortController: requestAbortController,
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

  async function applyGateway(decision: { apiKey?: string; skip?: boolean }) {
    if (workspace.gatewayBusy) return;
    const cid = conversationIdRef.current || conversationId;
    if (!cid) return;
    const apiKey = (decision.apiKey || '').trim();
    if (!decision.skip && !apiKey) return;

    workspace.setGatewayBusy(true);
    try {
      const response = await applyGatewayDecision({
        conversationId: cid,
        ...(apiKey ? { apiKey } : {}),
        ...(decision.skip ? { gatewaySkip: true } : {}),
      });
      const data = await response.json().catch(() => null) as {
        ok?: boolean;
        live?: boolean;
        skipped?: boolean;
        configured?: boolean;
        preview?: {
          url?: string;
          sandboxDebugUrl?: string;
          kind?: 'sandbox' | 'makers';
          restarted?: boolean;
        };
        download?: { url?: string; filename?: string };
      } | null;
      if (!response.ok || !data?.ok) {
        workspace.setGatewayBusy(false);
        return;
      }
      if (decision.skip) {
        workspace.setGatewayNeeded(false);
        workspace.setGatewayDeferred(true);
        workspace.setGatewayConfigured(false);
      } else {
        workspace.setGatewayNeeded(false);
        workspace.setGatewayDeferred(false);
        workspace.setGatewayConfigured(true);
        workspace.setGatewayPromptVariant('default');
      }
      workspace.setGatewayBusy(false);
      if (data.preview && !data.live) {
        preview.activatePreview(data.preview, new Map());
      }
      if (data.download) {
        workspace.setDownload(data.download);
      }
      void snapshot.refresh(cid);
    } catch {
      workspace.setGatewayBusy(false);
    }
  }

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
