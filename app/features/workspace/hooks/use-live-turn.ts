'use client';

import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import {
  appendNarrationChunk,
  dropTrailingSummaryEcho,
  sanitizeThinkingContent,
} from '../../../../shared/timeline';
import { extractApiKeyFromUserText } from '../../../../shared/gateway-secret';
import { STOPPED_TURN_REPLY } from '../../../../shared/user-facing-reply';
import type { Locale } from '@/app/i18n';
import {
  cacheConversationId,
  createConversationId,
  createMessageId,
  extractProjectName,
  getOrCreateCachedConversationId,
  markLastTurnStopped,
} from '@/app/lib/conversation';
import type { FileContentCache } from '@/app/hooks/use-file-content-cache';
import type {
  AssistantActivity,
  AssistantStatus,
  ChatMessage,
  ChatResponse,
  ChatStreamEvent,
} from '@/app/types/workspace';
import { consumeEventStream } from '../sse';
import {
  openSessionStream,
  startDeployTurn,
  startPromptTurn,
  stopChatTask,
} from '../workspace-api';
import type { PreviewSurfaceApi } from './use-preview-surface';
import type { WorkspaceStateApi } from './use-workspace-state';

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
  t: { response: LiveCopy; workspace: { deployRequest: string; gatewayPromptApiKey: string; gatewayPromptSkip: string } };
  fileCache: FileContentCache;
  workspace: WorkspaceStateApi;
  preview: PreviewSurfaceApi;
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
    fileCache,
    workspace,
    preview,
    conversationId,
    setConversationId,
    conversationIdRef,
    workspaceEpochRef,
    loadingRef,
  } = options;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const messagesRef = useRef<ChatMessage[]>([]);
  const chatAbortControllerRef = useRef<AbortController | null>(null);
  const activeTurnIdRef = useRef('');
  const stoppingRef = useRef(false);

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
      workspace.setSandboxTab('files');
      workspace.setResultPanelOpen(true);
    };

    const patchAssistant = (patch: Partial<ChatMessage>) => {
      setMessages((current) =>
        current.map((item) =>
          item.id === assistantMessageId ? { ...item, ...patch } : item,
        ),
      );
    };

    const appendTextActivity = (text: string) => {
      setMessages((current) =>
        current.map((item) => {
          if (item.id !== assistantMessageId) return item;
          const nextText = sanitizeThinkingContent(text);
          if (!nextText) return item;
          return {
            ...item,
            activities: appendNarrationChunk(item.activities ?? [], nextText),
          };
        }),
      );
    };

    const upsertToolActivity = (
      toolUseId: string,
      patch: Partial<Extract<AssistantActivity, { kind: 'tool' }>>,
    ) => {
      setMessages((current) => current.map((item) => {
        if (item.id !== assistantMessageId) return item;
        const activities = [...(item.activities ?? [])];
        const index = activities.findIndex(
          (activity) => activity.kind === 'tool' && activity.toolUseId === toolUseId,
        );
        if (index >= 0) {
          activities[index] = { ...activities[index], ...patch } as AssistantActivity;
        } else {
          activities.push({
            kind: 'tool',
            toolUseId,
            name: patch.name || '<unknown>',
            status: patch.status || 'running',
            inputSummary: patch.inputSummary,
            outputSummary: patch.outputSummary,
            startedAt: patch.startedAt || Date.now(),
            endedAt: patch.endedAt,
          });
        }
        return { ...item, activities };
      }));
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
      if (data.preview) {
        preview.activatePreview(data.preview, activatedPreviewRevisions);
        workspace.setSandboxTab('preview');
        workspace.setResultPanelOpen(true);
      }
      if (data.deployment) {
        workspace.setDeployment(data.deployment);
        workspace.setResultPanelOpen(true);
      }
      if (data.download) {
        workspace.setDownload(data.download);
      }
      if (data.build) {
        workspace.setBuild(data.build);
      }
      if (data.files) {
        workspace.setFileTree(data.files);
        if (data.files.items.some((item) => item.type === 'file')) {
          workspace.setResultPanelOpen(true);
        }
      }
      if (data.gatewayNeeded) {
        workspace.setGatewayNeeded(true);
      }
      workspace.setFilesRefreshing(false);

      const finalText = data.reply || data.error || t.response.noDisplay;
      const finalStatus: AssistantStatus = data.stopped ? 'stopped' : data.ok === false ? 'error' : 'done';
      finalizeAssistant(finalText, finalStatus);
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
          workspace.setGatewayBusy(false);
        }
        if (event.data?.status === 'resolved') {
          workspace.setGatewayNeeded(false);
          workspace.setGatewayBusy(false);
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
      if (event.type === 'text_segment' && event.data?.text) {
        appendTextActivity(event.data.text);
        return;
      }
      if (event.type === 'tool_use' && event.data) {
        sawProjectActivity = true;
        upsertToolActivity(event.data.id || '', {
          name: event.data.name || '<unknown>',
          status: 'running',
          inputSummary: event.data.inputSummary || event.data.command,
          ...(event.data.outputSummary ? { outputSummary: event.data.outputSummary } : {}),
          startedAt: event.data.startedAt,
        });
        return;
      }
      if (event.type === 'tool_result' && event.data) {
        sawProjectActivity = true;
        upsertToolActivity(event.data.id || '', {
          name: event.data.toolName || '<unknown>',
          status: event.data.status || (event.data.ok === false ? 'failed' : 'completed'),
          outputSummary: event.data.outputSummary || event.data.preview,
          endedAt: event.data.endedAt || Date.now(),
        });
        return;
      }
      if (event.type === 'file_content' && event.data?.path) {
        const content = event.data.content || '';
        fileCache.write(event.data.path, {
          content,
          size: typeof event.data.size === 'number' ? event.data.size : content.length,
          truncated: false,
        });
        if (!openedFirstFile) {
          pendingFirstFilePath = event.data.path;
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
        workspace.setResultPanelOpen(true);
        return;
      }
      if (event.type === 'preview_ready' && event.data) {
        sawProjectActivity = true;
        if (event.data.preview) {
          preview.activatePreview(event.data.preview, activatedPreviewRevisions);
          workspace.setSandboxTab('preview');
          workspace.setResultPanelOpen(true);
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
    apiKey?: string;
    gatewaySkip?: boolean;
  } = {}) {
    const trimmed = message.trim();
    if (!trimmed || loading) return;

    const extractedKey = sendOptions.apiKey
      ? undefined
      : extractApiKeyFromUserText(trimmed);
    const inboundApiKey = sendOptions.apiKey || extractedKey?.apiKey;
    const displayMessage = extractedKey?.maskedText || trimmed;

    const isDeploy = sendOptions.deploy === true;
    const isGatewayCard = Boolean(sendOptions.apiKey || sendOptions.gatewaySkip);
    const isGatewayContinue = Boolean(inboundApiKey || sendOptions.gatewaySkip);
    const isStartingFromHome = !isDeploy && !isGatewayCard
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

    setMessages((current) => [
      ...current,
      { id: userMessageId, role: 'user', content: displayMessage },
      {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        activities: [],
        status: 'running',
      },
    ]);
    if (!isDeploy) {
      workspace.setFilesRefreshing(true);
      if (!isGatewayCard) setInput('');
    }
    if (isGatewayContinue) {
      workspace.setGatewayNeeded(false);
      workspace.setGatewayBusy(false);
    }
    setLoading(true);

    try {
      const requestAbortController = new AbortController();
      chatAbortControllerRef.current = requestAbortController;
      stoppingRef.current = false;
      if (isStartingFromHome) {
        try {
          const resumeResponse = await openSessionStream(
            requestConversationId,
            requestAbortController.signal,
          );
          const resumeType = resumeResponse.headers.get('content-type') || '';
          if (
            resumeResponse.ok
            && resumeResponse.body
            && resumeType.includes('text/event-stream')
          ) {
            await consumeEventStream(resumeResponse, () => {});
          }
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') throw error;
        }
      }
      const response = isDeploy
        ? await startDeployTurn({
            conversationId: requestConversationId,
            turnId: assistantMessageId,
            ...(inboundApiKey ? { apiKey: inboundApiKey } : {}),
            ...(sendOptions.gatewaySkip ? { gatewaySkip: true } : {}),
            siteDomain: extractProjectName().domain,
            signal: requestAbortController.signal,
          })
        : await startPromptTurn({
            conversationId: requestConversationId,
            message: displayMessage,
            turnId: assistantMessageId,
            ...(inboundApiKey ? { apiKey: inboundApiKey } : {}),
            ...(sendOptions.gatewaySkip ? { gatewaySkip: true } : {}),
            ...(model ? { model } : {}),
            siteDomain: extractProjectName().domain,
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
    stopCurrentTask,
  };
}

export type LiveTurnApi = ReturnType<typeof useLiveTurn>;
