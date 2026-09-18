import type { AgentContext } from '../runtime/context.ts';
import { AUTO_FIX_MAX_ATTEMPTS } from '../constants.ts';
import { runCodingAgent } from '../session/live.ts';
import { runVerification } from '../project/scaffold.ts';
import { publishRunningPreview, startPreviewServer } from '../project/preview.ts';
import {
  bindSiteDomain,
  persistWorkspace,
  publishPreview,
  setDeployment,
  setLastBuild,
} from '../project/workspace-store.ts';
import type {
  AgentProgressEvent,
  DeploymentInfo,
  ScaffoldLog,
  StreamSend,
} from '../types.ts';
import { toAppRelPath } from '../utils/paths.ts';
import { sanitizeAssistantText } from '../../../shared/timeline.ts';
import { resolveConversationId, resolveRequestSiteDomain } from '../runtime/request.ts';
import {
  GATEWAY_CREDENTIALS_USER_REPLY,
  compactUserFacingReply,
  createFileTreePushController,
  createProjectCheckpointController,
  extendExistingSandboxTimeout,
  isGenericCompletionReply,
  previewLinkFromState,
  replyLocaleFor,
  resolveFinishedTurn,
  STOPPED_TURN_REPLY,
  stripReturnedPreviewLinks,
  withLiveDeploymentUrl,
  buildRequirementConclusionFallback,
} from './checkpoint.ts';
import { createTurnLifecycle } from './lifecycle.ts';
import { prepareProjectWorkspace } from '../project/workspace.ts';
import {
  applyUserGatewayDecision,
  isRequestGatewayCredentialsTool,
} from '../project/gateway.ts';
import { resolveGatewayUserTurn } from '../../../shared/gateway-secret.ts';
import { runAutoFixTurn } from './auto-fix.ts';
import { sendTurnResult } from './result.ts';
import type { ChatResponse } from '../../../shared/protocol.ts';
import type { ReplyLocale } from '../../../shared/user-facing-reply.ts';

function slimResult(
  conversationId: string,
  extra: Omit<ChatResponse, 'conversation_id'>,
): ChatResponse {
  return { conversation_id: conversationId, ...extra };
}

export async function runChatPipeline(
  context: AgentContext,
  message: string,
  send: StreamSend,
  options: {
    turnId?: string;
    /** Validated model for this turn; '' or absent runs the configured default. */
    model?: string;
    language?: ReplyLocale | string;
    /** Real Models API key from the card or a chat sentence; never persisted. */
    apiKey?: string;
    gatewaySkip?: boolean;
  } = {},
) {
  const { conversationId } = resolveConversationId(context);
  const abortSignal = context?.request?.signal as AbortSignal | undefined;
  const replyLocale = replyLocaleFor(message, options.language);

  if (!message) {
    sendTurnResult(send, slimResult(conversationId, {
      ok: false,
      reply: 'Please describe the page or feature you want to build first.',
    }));
    return;
  }

  if (!conversationId) {
    sendTurnResult(send, slimResult('', {
      ok: false,
      reply: 'Missing conversationId. The project workspace cannot be prepared.',
    }));
    return;
  }

  await extendExistingSandboxTimeout(context);

  const state = await prepareProjectWorkspace(
    context,
    conversationId,
    send,
  );
  if (bindSiteDomain(state, resolveRequestSiteDomain(context))) {
    await persistWorkspace(context, conversationId, state);
  }
  const inboundGateway = resolveGatewayUserTurn(message, options.apiKey);
  message = inboundGateway.message;
  if (inboundGateway.apiKey || options.gatewaySkip) {
    await applyUserGatewayDecision(
      context,
      state,
      conversationId,
      {
        ...(inboundGateway.apiKey ? { apiKey: inboundGateway.apiKey } : {}),
        ...(options.gatewaySkip ? { skip: true } : {}),
      },
      send,
    );
  }
  const isInitialProjectTurn = !state.created;
  const hiddenScaffoldToolUseIds = new Set<string>();
  const activityTurnId = options.turnId
    || String(context?.run_id || `${Date.now()}-${Math.random().toString(36).slice(2)}`);

  const checkpoint = createProjectCheckpointController(context, conversationId, state, (persistenceError) => {
    console.warn('[checkpoint]', persistenceError);
  });
  const turn = createTurnLifecycle({
    context,
    conversationId,
    message,
    turnId: activityTurnId,
    state,
    checkpoint,
  });
  const recordProgress = turn.recordProgress;
  const finalizeTurn = turn.finalize;

  const handleScaffoldLog = (_log: ScaffoldLog) => {};
  const forwardProgress = (event: AgentProgressEvent) => {
    if (event.type === 'tool_use') {
      const name = event.data?.name || '';
      const hideScaffold = !isInitialProjectTurn
        && (name === 'ensure_project_scaffold' || name.endsWith('__ensure_project_scaffold'));
      if (hideScaffold || isRequestGatewayCredentialsTool(name)) {
        hiddenScaffoldToolUseIds.add(event.data?.id || '');
        return;
      }
    }
    if (event.type === 'tool_result' && hiddenScaffoldToolUseIds.has(event.data?.id || '')) {
      return;
    }
    if (event.type === 'text_segment') {
      const text = state.previewUrl
        ? stripReturnedPreviewLinks(event.data?.text || '', state.previewUrl)
        : event.data?.text || '';
      if (text.length === 0) {
        return;
      }
      const narration = { ...event, data: { ...event.data, text } };
      recordProgress(narration);
      send(narration);
      return;
    }
    recordProgress(event);
    send(event);
  };
  const fileTreePush = createFileTreePushController(context, state, send);
  const handleProjectFilesChanged = async (file?: { path: string; content: string }) => {
    if (file) {
      const path = toAppRelPath(file.path, state.appDir) || file.path;
      send({ type: 'file_changed', data: { paths: [path] } });
    }
    fileTreePush.schedule();
    checkpoint.schedule();
  };

  const handlePreviewReady = async (preview: { url?: string; sandboxDebugUrl?: string; kind?: 'sandbox' | 'makers' }) => {
    const url = preview.url;
    if (!url) {
      return;
    }
    publishPreview(state, {
      url,
      sandboxDebugUrl: preview.sandboxDebugUrl,
      kind: preview.kind,
    });
    await persistWorkspace(context, conversationId, state);
    send({
      type: 'preview_ready',
      data: {
        preview: {
          url,
          sandboxDebugUrl: preview.sandboxDebugUrl,
          kind: state.previewKind,
        },
        download: { url: '/download', filename: 'source.zip' },
      },
    });
  };
  let hostPreviewInFlight: Promise<boolean> | null = null;
  const startHostPreview = async (reason: string) => {
    if (hostPreviewInFlight) return hostPreviewInFlight;
    hostPreviewInFlight = (async () => {
      try {
        await startPreviewServer(context, state);
        const preview = await publishRunningPreview(context, state, { routesAlreadyVerified: true });
        await handlePreviewReady(preview);
        return Boolean(state.previewUrl);
      } catch (error) {
        console.warn(
          reason,
          error instanceof Error ? error.message : error,
        );
        return false;
      } finally {
        hostPreviewInFlight = null;
      }
    })();
    return hostPreviewInFlight;
  };
  const handleDeploymentStatus = (deployment: DeploymentInfo) => {
    setDeployment(state, deployment);
    void persistWorkspace(context, conversationId, state);
    send({
      type: 'deployment_status',
      data: deployment,
    });
  };

  if (state.created) {
    void startHostPreview('[preview] workspace ready:');
  }

  const modelResult = await runCodingAgent({
    context,
    conversationId,
    userMessage: message,
    state,
    isNewProject: !state.created,
    onScaffoldLog: handleScaffoldLog,
    onProgress: forwardProgress,
    onProjectFilesChanged: handleProjectFilesChanged,
    onPreviewReady: handlePreviewReady,
    onDeploymentStatus: handleDeploymentStatus,
    onWorkspaceReady: () => {
      void startHostPreview('[preview] after scaffold:');
    },
    abortSignal,
    model: options.model,
    send,
  });

  if (modelResult.stopped || abortSignal?.aborted) {
    const stoppedReply = STOPPED_TURN_REPLY[replyLocale];
    await finalizeTurn(stoppedReply, 'stopped', {
      withSnapshot: modelResult.projectTouched,
    });
    sendTurnResult(send, slimResult(conversationId, {
      ok: false,
      stopped: true,
      reply: stoppedReply,
    }));
    return;
  }

  if (state.gatewayPromptPending) {
    const pauseReply = GATEWAY_CREDENTIALS_USER_REPLY[replyLocale];
    send({
      type: 'gateway_credentials',
      data: { status: 'needed' },
    });
    send({
      type: 'agent',
      data: {
        ok: true,
        reply: pauseReply,
      },
    });

    if (modelResult.projectTouched) {
      await fileTreePush.flush('Failed to read the file list.');
    }
    await finalizeTurn(pauseReply, 'completed', {
      withSnapshot: false,
    });
    sendTurnResult(send, slimResult(conversationId, {
      ok: true,
      reply: pauseReply,
    }));
    if (modelResult.projectTouched) {
      void checkpoint.flush();
    }
    return;
  }
  const sanitizedModelOutput = modelResult.success && modelResult.output
    ? sanitizeAssistantText(modelResult.output)
    : '';
  const modelOutput = sanitizedModelOutput && !isGenericCompletionReply(sanitizedModelOutput)
    ? sanitizedModelOutput
    : '';
  const fallbackReply = modelResult.success
    ? buildRequirementConclusionFallback(message, state.previewUrl ? 'ready' : 'pending')
    : (modelResult.error || 'An error occurred during processing. Please try again.');
  const rawAssistantReply = stripReturnedPreviewLinks(sanitizeAssistantText(
    modelOutput || fallbackReply
  ) || fallbackReply, state.previewUrl);
  const liveDeploymentUrl = modelResult.deploymentTouched
    && state.deployment?.status === 'success'
    ? state.deployment.url
    : undefined;
  const assistantReply = withLiveDeploymentUrl(
    modelResult.projectTouched
      ? compactUserFacingReply(rawAssistantReply, fallbackReply)
      : rawAssistantReply,
    liveDeploymentUrl,
  );

  send({
    type: 'agent',
    data: {
      ok: modelResult.success,
      reply: assistantReply,
      ...(modelResult.error ? { error: modelResult.error } : {}),
    },
  });

  if (modelResult.fatal) {
    await finalizeTurn(assistantReply, 'failed', {
      withSnapshot: modelResult.projectTouched,
    });
    sendTurnResult(send, slimResult(conversationId, {
      ok: false,
      reply: assistantReply,
      error: modelResult.error || undefined,
    }));
    return;
  }

  if (!modelResult.projectTouched) {
    // The model no longer launches preview. A finished project with no URL
    // still needs the host to start it — including Q&A turns after a write
    // that never set projectTouched, or a previous turn that skipped dest.
    if (state.created && !state.previewUrl) {
      await checkpoint.flush();
      await startHostPreview('[preview] host start failed:');
    } else if (modelResult.previewTouched && state.previewUrl) {
      send({
        type: 'preview_ready',
        data: {
          preview: previewLinkFromState(state),
        },
      });
    }

    const previewReady = !modelResult.previewTouched || Boolean(state.previewUrl);
    const deploymentReady = !modelResult.deploymentTouched
      || state.deployment?.status === 'success';
    const operationOk = modelResult.success && previewReady && deploymentReady;
    await finalizeTurn(assistantReply, operationOk ? 'completed' : 'failed', {
      withState: Boolean(state.previewUrl) || modelResult.deploymentTouched,
    });
    sendTurnResult(send, slimResult(conversationId, {
      ok: operationOk,
      reply: assistantReply,
    }));
    return;
  }

  await checkpoint.flush();

  let previewVerified = Boolean(state.previewUrl);
  if (!previewVerified) {
    previewVerified = await startHostPreview('[preview] host start failed:');
  }

  await fileTreePush.flush('Failed to read the file list.');
  let build = await runVerification(context, state, {
    previewVerified,
  });
  let autoFixAttempts = 0;
  let autoFixApplied = false;
  let autoFixReply = '';

  if (build.fatal) {
    setLastBuild(state, build);
    await persistWorkspace(context, conversationId, state);
    const fatalReply = build.stderr || 'The task failed, and the remaining workflow was stopped.';
    await finalizeTurn(fatalReply, 'failed', { withSnapshot: true });
    sendTurnResult(send, slimResult(conversationId, {
      ok: false,
      reply: fatalReply,
    }));
    return;
  }

  if (build.status === 'failed' && modelResult.success) {
    autoFixAttempts = AUTO_FIX_MAX_ATTEMPTS;
    autoFixApplied = true;
    const { result: autoFixResult } = await runAutoFixTurn({
      context,
      conversationId,
      message,
      state,
      assistantReply,
      build,
      onScaffoldLog: handleScaffoldLog,
      onProgress: forwardProgress,
      onProjectFilesChanged: handleProjectFilesChanged,
      onPreviewReady: handlePreviewReady,
      onDeploymentStatus: handleDeploymentStatus,
      abortSignal,
      model: options.model,
      send,
    });
    if (autoFixResult.stopped || abortSignal?.aborted) {
      const stoppedReply = STOPPED_TURN_REPLY[replyLocale];
      await finalizeTurn(stoppedReply, 'stopped', { withSnapshot: true });
      sendTurnResult(send, slimResult(conversationId, {
        ok: false,
        stopped: true,
        reply: stoppedReply,
      }));
      return;
    }
    const rawAutoFixReply = stripReturnedPreviewLinks(sanitizeAssistantText(
      autoFixResult.success && autoFixResult.output
        ? autoFixResult.output
        : autoFixResult.error || ''
    ), state.previewUrl);
    autoFixReply = autoFixResult.success
      ? compactUserFacingReply(
        rawAutoFixReply,
        buildRequirementConclusionFallback(message, state.previewUrl ? 'ready' : 'generated'),
      )
      : rawAutoFixReply;

    if (autoFixReply) {
      send({
        type: 'agent',
        data: {
          ok: autoFixResult.success,
          reply: autoFixReply,
          ...(autoFixResult.error ? { error: autoFixResult.error } : {}),
        },
      });
    }

    await fileTreePush.flush('Failed to read the file list after auto-fix.');
    build = await runVerification(context, state);
    if (build.fatal) {
      setLastBuild(state, build);
      await persistWorkspace(context, conversationId, state);
      const fatalReply = build.stderr || 'The task failed, and the remaining workflow was stopped.';
      await finalizeTurn(fatalReply, 'failed', { withSnapshot: true });
      sendTurnResult(send, slimResult(conversationId, {
        ok: false,
        reply: fatalReply,
      }));
      return;
    }

    if (!previewVerified) {
      previewVerified = await startHostPreview('[preview] host start after auto-fix failed:');
    }
  }

  build = {
    ...build,
    ...(autoFixAttempts > 0 ? { autoFixAttempts, autoFixApplied } : {}),
  };
  setLastBuild(state, build);
  await persistWorkspace(context, conversationId, state);

  if (state.previewUrl) {
    send({
      type: 'preview_ready',
      data: {
        preview: {
          ...previewLinkFromState(state),
          ...(modelResult.filesWritten ? { restarted: true } : {}),
        },
      },
    });
  }

  const isChinese = replyLocale === 'zh';
  const outcome = resolveFinishedTurn({
    filesWritten: modelResult.filesWritten !== false,
    previewUrl: state.previewUrl,
    buildFailed: build.status === 'failed',
    modelReply: stripReturnedPreviewLinks(
      autoFixReply || (modelOutput ? assistantReply : ''),
      state.previewUrl,
    ),
    fallbackReply: buildRequirementConclusionFallback(
      message,
      build.status !== 'failed' && state.previewUrl ? 'ready' : 'generated',
    ),
    failureReply: build.status === 'failed'
      ? (isChinese ? '项目已生成，但检查未通过，我还需要继续修复。' : 'The project was generated, but checks still fail and need another fix.')
      : (isChinese ? '项目已生成，但预览暂时不可用，请重试。' : 'The project was generated, but the preview is temporarily unavailable. Please retry.'),
  });
  const turnFailed = outcome.failed;
  const reply = withLiveDeploymentUrl(outcome.reply, liveDeploymentUrl);

  const turnOk = modelResult.success && !turnFailed;
  await finalizeTurn(reply, turnOk ? 'completed' : 'failed', { withSnapshot: true });

  sendTurnResult(send, slimResult(conversationId, {
    ok: turnOk,
    reply,
  }));
}
