'use client';

import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { dropTrailingSummaryEcho } from '../../../../shared/timeline';
import type { Locale } from '@/app/i18n';
import {
  clearCachedConversationId,
  createMessageId,
  getStoredConversationId,
} from '@/app/lib/conversation';
import type {
  AssistantStatus,
  ChatMessage,
  ChatStreamEvent,
  ResumeData,
  SessionPrepStage,
  SessionStreamEvent,
} from '@/app/types/workspace';
import { consumeEventStream } from '../sse';
import { openSessionStream } from '../workspace-api';
import type { LiveTurnApi } from './use-live-turn';
import type { WorkspaceStateApi } from './use-workspace-state';
import type { WorkspaceSnapshotApi } from './use-workspace-snapshot';

export function useSessionResume(options: {
  workspace: WorkspaceStateApi;
  live: LiveTurnApi;
  snapshot: WorkspaceSnapshotApi;
  setConversationId: (id: string | null) => void;
  setModel: (model: string) => void;
  setLanguage: (language: Locale) => void;
  conversationIdRef: MutableRefObject<string | null>;
  workspaceEpochRef: MutableRefObject<number>;
  workspaceRestoringRef: MutableRefObject<boolean>;
}) {
  const {
    workspace,
    live,
    snapshot,
    setConversationId,
    setModel,
    setLanguage,
    conversationIdRef,
    workspaceEpochRef,
    workspaceRestoringRef,
  } = options;

  const [resumeChecked, setResumeChecked] = useState(true);
  const [workspaceRestoring, setWorkspaceRestoring] = useState(false);
  const [prepStage, setPrepStage] = useState<SessionPrepStage | null>(null);
  const resumeAbortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    workspaceRestoringRef.current = workspaceRestoring;
  }, [workspaceRestoring, workspaceRestoringRef]);

  useEffect(() => {
    let cancelled = false;
    const workspaceEpoch = workspaceEpochRef.current;
    const existing = getStoredConversationId();
    if (!existing) {
      return;
    }

    setResumeChecked(false);
    setConversationId(existing);

    const applyHistory = (data: ResumeData): { restored: boolean; liveTaskId: string | null } => {
      const history = Array.isArray(data.messages) ? data.messages : [];
      const activeTask = data.activeTask;
      if (!data.hasProject && history.length === 0 && !activeTask && !data.deployment) {
        return { restored: false, liveTaskId: null };
      }
      if (data.conversation_id) {
        setConversationId(data.conversation_id);
      }
      if (data.model) {
        setModel(data.model);
      }
      if (data.language === 'zh' || data.language === 'en') {
        setLanguage(data.language);
      }
      const activityHistory = Array.isArray(data.activityHistory) ? data.activityHistory : [];
      let nextMessages: ChatMessage[] = activityHistory.length > 0
        ? activityHistory.flatMap((turn) => [
            {
              id: `${turn.id}-user`,
              role: 'user' as const,
              content: turn.user,
              status: 'done' as AssistantStatus,
            },
            {
              id: `${turn.id}-assistant`,
              role: 'assistant' as const,
              content: turn.assistant,
              activities: dropTrailingSummaryEcho(turn.activities ?? [], turn.assistant),
              status: turn.status === 'completed' ? 'done' as const : turn.status === 'failed' ? 'error' as const : 'stopped' as const,
            },
          ])
        : history.map((item) => ({
            id: createMessageId(item.role),
            role: item.role,
            content: item.content,
            status: 'done' as AssistantStatus,
          }));

      if (activeTask?.id && activeTask.message) {
        const persistedTurn = activityHistory.find((turn) => turn.id === activeTask.id);
        const turnAlreadyFinished = persistedTurn
          && (persistedTurn.status === 'stopped'
            || persistedTurn.status === 'completed'
            || persistedTurn.status === 'failed');

        if (!turnAlreadyFinished) {
          const assistantId = activeTask.id;
          const userId = `${activeTask.id}-user`;
          const last = nextMessages.at(-1);
          const hasRunningAssistant = nextMessages.some(
            (item) => item.role === 'assistant' && item.id === assistantId && item.status === 'running',
          );
          const hasUserForTurn = nextMessages.some((item) => item.id === userId);

          if (!hasRunningAssistant) {
            if (last?.role === 'user' && last.content === activeTask.message) {
              nextMessages = [
                ...nextMessages.slice(0, -1),
                { ...last, id: userId },
                {
                  id: assistantId,
                  role: 'assistant',
                  content: '',
                  activities: [],
                  status: 'running',
                },
              ];
            } else if (!hasUserForTurn && !(last?.role === 'assistant' && last.id === assistantId)) {
              nextMessages = [
                ...nextMessages,
                {
                  id: userId,
                  role: 'user',
                  content: activeTask.message,
                  status: 'done',
                },
                {
                  id: assistantId,
                  role: 'assistant',
                  content: '',
                  activities: [],
                  status: 'running',
                },
              ];
            }
          }
          live.activeTurnIdRef.current = assistantId;
          live.setLoading(true);
        }
      }

      const seenIds = new Set<string>();
      nextMessages = nextMessages.filter((item) => {
        if (seenIds.has(item.id)) return false;
        seenIds.add(item.id);
        return true;
      });

      live.setMessages(nextMessages);
      if (data.gatewayNeeded) {
        workspace.setGatewayNeeded(true);
        workspace.setGatewayDeferred(false);
      } else if (data.gatewaySkipped) {
        workspace.setGatewayNeeded(false);
        workspace.setGatewayDeferred(true);
      } else {
        workspace.setGatewayNeeded(false);
      }
      workspace.setDeployment(data.deployment ?? null);
      if (data.hasProject || data.needsWorkspace || activeTask) {
        if (data.hasProject || data.needsWorkspace) {
          setWorkspaceRestoring(true);
        }
      }
      const liveTaskId = activeTask?.id
        && nextMessages.some((item) => item.id === activeTask.id && item.status === 'running')
        ? activeTask.id
        : null;
      return { restored: true, liveTaskId };
    };

    const applyWorkspace = (data: ResumeData) => {
      if (data.gatewayNeeded) {
        workspace.setGatewayNeeded(true);
        workspace.setGatewayDeferred(false);
      } else if (data.gatewaySkipped) {
        workspace.setGatewayDeferred(true);
      }
      snapshot.applySnapshot(data);
    };

    const resumeController = new AbortController();
    resumeAbortControllerRef.current = resumeController;
    (async () => {
      const liveAttach = {
        session: null as {
          handleStreamEvent: (event: ChatStreamEvent) => void;
          finish: () => void;
        } | null,
      };
      try {
        const response = await openSessionStream(existing, resumeController.signal, {
          mode: 'restore',
        });
        const contentType = response.headers.get('content-type') || '';
        if (!response.ok || !response.body || !contentType.includes('text/event-stream')) {
          return;
        }

        await consumeEventStream<SessionStreamEvent>(response, (event) => {
          if (cancelled || workspaceEpoch !== workspaceEpochRef.current || event.type === 'ping') return;

          if (event.type === 'session_prep' && event.data?.stage) {
            if (event.data.stage === 'ready') {
              // Workspace and preview stages keep streaming after `ready`; the files and
              // preview panels carry their own loading state, so the full-screen loader
              // does not have to wait for the stream to close.
              setResumeChecked(true);
              setPrepStage(null);
              return;
            }
            if (event.data.status === 'running') {
              setPrepStage(event.data.stage);
            }
            return;
          }

          if (event.type === 'resume_history' && event.data?.ok) {
            const historyData = event.data;
            const { restored, liveTaskId } = applyHistory(historyData);
            if (!restored) {
              clearCachedConversationId();
              conversationIdRef.current = null;
              setConversationId(null);
              setResumeChecked(true);
              setPrepStage(null);
            }

            if (liveTaskId) {
              const conversationForRun = historyData.conversation_id || existing;
              liveAttach.session = live.startLiveChatSessionRef.current({
                requestConversationId: conversationForRun,
                assistantMessageId: liveTaskId,
                abortController: resumeController,
              });
              live.chatAbortControllerRef.current = resumeController;
            }
            return;
          }

          if (event.type === 'resume_workspace' && event.data?.ok) {
            applyWorkspace(event.data);
            return;
          }

          if (event.type === 'file_changed' && event.data?.paths?.length) {
            void snapshot.pullFiles(existing, event.data.paths.filter(Boolean));
            return;
          }

          liveAttach.session?.handleStreamEvent(event as ChatStreamEvent);
        });
      } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError')) {
          // Resume is best-effort.
        }
      } finally {
        if (!cancelled) {
          setResumeChecked(true);
          setPrepStage(null);
          if (workspaceEpoch === workspaceEpochRef.current) {
            setWorkspaceRestoring(false);
            liveAttach.session?.finish();
          }
        }
      }
    })();

    return () => {
      cancelled = true;
      resumeController.abort();
      if (resumeAbortControllerRef.current === resumeController) {
        resumeAbortControllerRef.current = null;
      }
    };
  }, []);

  return {
    resumeChecked,
    setResumeChecked,
    workspaceRestoring,
    setWorkspaceRestoring,
    prepStage,
    resumeAbortControllerRef,
  };
}

export type SessionResumeApi = ReturnType<typeof useSessionResume>;
