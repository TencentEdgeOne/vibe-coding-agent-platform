import type { AgentContext } from '../runtime/context.ts';
import { AUTO_FIX_MAX_ATTEMPTS } from '../constants.ts';
import { runCodingAgent } from '../session/live.ts';
import { runVerification } from '../project/scaffold.ts';
import { ensurePreview, ensureWorkspace } from '../project/readiness.ts';
import {
  bindSiteDomain,
  persistWorkspace,
  publishPreview,
  setDeployment,
  setLastBuild,
} from '../project/workspace-store.ts';
import { workspaceSnapshotFromState } from '../project/snapshot.ts';
import type {
  AgentProgressEvent,
  DeploymentInfo,
  FileTreeItem,
  PreviewKind,
  StreamSend,
} from '../types.ts';
import { toAppRelPath } from '../utils/paths.ts';
import { sanitizeAssistantText } from '../../../shared/timeline.ts';
import { resolveConversationId, resolveRequestSiteDomain } from '../runtime/request.ts';
import {
  compactUserFacingReply,
  createFileTreePushController,
  createProjectCheckpointController,
  isGenericCompletionReply,
  previewLinkFromState,
  replyLocaleFor,
  resolveFinishedTurn,
  STOPPED_TURN_REPLY,
  stripReturnedPreviewLinks,
  withLiveDeploymentUrl,
  buildRequirementConclusionFallback,
} from './checkpoint.ts';
import { bindLiveWorkspace } from '../session/live-workspace.ts';
import { createTurnLifecycle } from './lifecycle.ts';
import { applyUserGatewayDecision } from '../project/gateway.ts';
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

  const { state } = await ensureWorkspace(context, conversationId, { send });
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
  bindLiveWorkspace(conversationId, state, send);
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

  const forwardProgress = (event: AgentProgressEvent) => {
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
    if (event.type === 'thinking_segment' && !event.data?.text) {
      return;
    }
    if (event.type === 'system_info' && !event.data?.content && !event.data?.title) {
      return;
    }
    recordProgress(event);
    send(event);
  };
  const fileTreePush = createFileTreePushController(context, state, send);
  let flushedItems: FileTreeItem[] | undefined;
  const rememberTree = (items: FileTreeItem[]) => {
    if (items.length > 0) flushedItems = items;
  };
  const finishResult = (extra: Omit<ChatResponse, 'conversation_id'>) => {
    sendTurnResult(
      send,
      slimResult(conversationId, extra),
      workspaceSnapshotFromState(conversationId, state, flushedItems),
    );
  };
  const handleProjectFilesChanged = async (file?: { path: string; content: string }) => {
    if (file) {
      const path = toAppRelPath(file.path, state.appDir) || file.path;
      send({ type: 'file_changed', data: { paths: [path] } });
    }
    fileTreePush.schedule();
    checkpoint.schedule();
  };

  /** Announce a preview whose state is already written. */
  const announcePreview = (preview: { url?: string; sandboxDebugUrl?: string }) => {
    if (!preview.url) {
      return;
    }
    send({
      type: 'preview_ready',
      data: {
        preview: {
          url: preview.url,
          sandboxDebugUrl: preview.sandboxDebugUrl,
          kind: state.previewKind,
        },
        download: { url: '/download', filename: 'source.zip' },
      },
    });
  };

  /**
   * A preview the agent brought up itself by running the Makers CLI. Nothing
   * else has recorded that one, so this is where it enters the project state —
   * unlike the host's own path below, where ensurePreview has already written it.
   */
  const handlePreviewReady = async (preview: { url?: string; sandboxDebugUrl?: string; kind?: PreviewKind }) => {
    if (!preview.url) {
      return;
    }
    publishPreview(state, {
      url: preview.url,
      sandboxDebugUrl: preview.sandboxDebugUrl,
      kind: preview.kind,
    });
    await persistWorkspace(context, conversationId, state);
    announcePreview(preview);
  };
  /**
   * The preview, from wherever in this turn it is first noticed to be missing.
   *
   * There is no in-flight guard here any more: this turn asks four times, and
   * deduplicating those — along with choosing between a token mint and a dev
   * server boot — is ensurePreview's job. `verifyRoutes` is what makes this the
   * expensive caller: a turn that may have just written a broken API route has
   * to find that out here rather than let the user find it by clicking.
   */
  const startHostPreview = async (reason: string) => {
    try {
      announcePreview(await ensurePreview(context, conversationId, state, {
        verifyRoutes: true,
      }));
      return Boolean(state.previewUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(reason, message);
      send({
        type: 'preview_ready',
        data: {
          preview: { error: message },
        },
      });
      return false;
    }
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
    onProgress: forwardProgress,
    onProjectFilesChanged: handleProjectFilesChanged,
    onPreviewReady: handlePreviewReady,
    onDeploymentStatus: handleDeploymentStatus,
    abortSignal,
    model: options.model,
    send,
  });

  if (modelResult.stopped || abortSignal?.aborted) {
    const stoppedReply = STOPPED_TURN_REPLY[replyLocale];
    await finalizeTurn(stoppedReply, 'stopped', {
      withSnapshot: modelResult.projectTouched,
    });
    finishResult({
      ok: false,
      stopped: true,
      reply: stoppedReply,
    });
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
    finishResult({
      ok: false,
      reply: assistantReply,
      error: modelResult.error || undefined,
    });
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
    finishResult({
      ok: operationOk,
      reply: assistantReply,
    });
    return;
  }

  await checkpoint.flush();

  let previewVerified = Boolean(state.previewUrl);
  if (!previewVerified) {
    previewVerified = await startHostPreview('[preview] host start failed:');
  }

  rememberTree(await fileTreePush.flush('Failed to read the file list.'));
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
    finishResult({
      ok: false,
      reply: fatalReply,
    });
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
      finishResult({
        ok: false,
        stopped: true,
        reply: stoppedReply,
      });
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

    rememberTree(await fileTreePush.flush('Failed to read the file list after auto-fix.'));
    build = await runVerification(context, state);
    if (build.fatal) {
      setLastBuild(state, build);
      await persistWorkspace(context, conversationId, state);
      const fatalReply = build.stderr || 'The task failed, and the remaining workflow was stopped.';
      await finalizeTurn(fatalReply, 'failed', { withSnapshot: true });
      finishResult({
        ok: false,
        reply: fatalReply,
      });
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

  finishResult({
    ok: turnOk,
    reply,
  });
}
