import { runCodingAgent } from '../agent.ts';
import { AUTO_FIX_MAX_ATTEMPTS } from '../constants.ts';
import { getHistory, saveProjectState } from '../memory.ts';
import { getFileTree, runVerification } from '../project/index.ts';
import type {
  AgentProgressEvent,
  BuildStatus,
  DeploymentInfo,
  FileTreeItem,
  ScaffoldLog,
  StreamSend,
} from '../types.ts';
import { buildAutoFixPrompt } from '../utils/build-errors.ts';
import { toAppRelPath } from '../utils/paths.ts';
import { sanitizeAssistantText } from '../utils/text.ts';
import { resolveConversationId } from '../utils/request.ts';
import {
  FILE_PUSH_MAX_BYTES,
  FILE_PUSH_TURN_BUDGET_BYTES,
  buildRequirementConclusionFallback,
  compactUserFacingReply,
  createFileTreePushController,
  createProjectCheckpointController,
  extendExistingSandboxTimeout,
  GATEWAY_CREDENTIALS_USER_REPLY,
  isGenericCompletionReply,
  previewLinkFromState,
  replyLocaleFor,
  resolveFinishedTurn,
  STOPPED_TURN_REPLY,
  stripReturnedPreviewLinks,
  utf8ByteLength,
  withLiveDeploymentUrl,
} from './helpers.ts';
import { createTurnLifecycle } from './turn-lifecycle.ts';
import { prepareProjectWorkspace } from './workspace.ts';
import { isMakersDeployUrl } from '../../../shared/makers-deploy.ts';
import {
  applyUserGatewayDecision,
  isRequestGatewayCredentialsTool,
} from '../project/gateway-prompt.ts';
import { resolveGatewayUserTurn } from '../../../shared/gateway-secret.ts';

export async function runChatPipeline(
  context: any,
  message: string,
  send: StreamSend,
  options: {
    resetProject?: boolean;
    turnId?: string;
    userMessagePersisted?: boolean;
    /** Validated model for this turn; '' or absent runs the configured default. */
    model?: string;
    siteDomain?: string;
    /** Real Models API key from the card or a chat sentence; never persisted. */
    apiKey?: string;
    gatewaySkip?: boolean;
  } = {},
) {
  const { conversationId } = resolveConversationId(context);
  const abortSignal = context?.request?.signal as AbortSignal | undefined;
  // Every reply this pipeline writes itself — stopped, failed, fallback — has to
  // answer in the language of the request, so the language is decided once here
  // rather than re-sniffed at each of the five places that needed it.
  const replyLocale = replyLocaleFor(message);

  if (!message) {
    send({
      type: 'result',
      data: {
        ok: false,
        conversation_id: conversationId,
        reply: 'Please describe the page or feature you want to build first.',
        build: { status: 'skipped' as BuildStatus },
        preview: {},
      },
    });
    return;
  }

  if (!conversationId) {
    send({
      type: 'result',
      data: {
        ok: false,
        conversation_id: '',
        reply: 'Missing conversationId. The project workspace cannot be prepared.',
        build: { status: 'skipped' as BuildStatus },
        preview: {},
      },
    });
    return;
  }

  await extendExistingSandboxTimeout(context);

  send({
    type: 'status',
    message: 'Running the agent workflow',
  });

  const shouldResetProject = options.resetProject === true;
  const state = await prepareProjectWorkspace(
    context,
    conversationId,
    shouldResetProject,
    send,
  );
  const siteDomain = String(options.siteDomain || '').trim();
  if (siteDomain && state.siteDomain !== siteDomain) {
    state.siteDomain = siteDomain;
    await saveProjectState(context, conversationId, state);
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
  const history = shouldResetProject
    ? []
    : await getHistory(context, conversationId, {
      excludeLatestUserMessage: options.userMessagePersisted ? message : undefined,
    });
  const isInitialProjectTurn = !state.created;
  const hiddenScaffoldToolUseIds = new Set<string>();
  const activityTurnId = options.turnId
    || String(context?.run_id || `${Date.now()}-${Math.random().toString(36).slice(2)}`);

  // Mid-turn debounced snapshots + exit-path flush so a recycled sandbox still
  // has a restorable workspace in project Blob storage.
  const checkpoint = createProjectCheckpointController(context, conversationId, state, (persistenceError) => {
    send({
      type: 'log',
      phase: 'agent',
      stream: 'stderr',
      message: persistenceError,
    });
  });
  const turn = createTurnLifecycle({
    context,
    conversationId,
    message,
    turnId: activityTurnId,
    userMessagePersisted: options.userMessagePersisted === true,
    state,
    checkpoint,
  });
  const recordProgress = turn.recordProgress;
  const finalizeTurn = turn.finalize;

  const handleScaffoldLog = (log: ScaffoldLog) => {
    if (!isInitialProjectTurn) {
      return;
    }
    send({
      type: 'log',
      phase: 'scaffold',
      stream: log.stream,
      message: log.content,
    });
  };
  const forwardProgress = (event: AgentProgressEvent) => {
    // Forward structured progress events directly; the frontend renders by type.
    if (event.type === 'tool_use') {
      const name = event.data.name || '';
      const hideScaffold = !isInitialProjectTurn
        && (name === 'ensure_project_scaffold' || name.endsWith('__ensure_project_scaffold'));
      if (hideScaffold || isRequestGatewayCredentialsTool(name)) {
        hiddenScaffoldToolUseIds.add(event.data.id);
        return;
      }
    }
    if (event.type === 'tool_result' && hiddenScaffoldToolUseIds.has(event.data.tool_use_id)) {
      return;
    }
    if (event.type === 'text_segment') {
      // Keep the model's step-by-step narration visible; only the final summary
      // is compacted. Preview links stay out of the chat.
      const text = state.previewUrl
        ? stripReturnedPreviewLinks(event.data.text, state.previewUrl)
        : event.data.text;
      if (text.length === 0) {
        return;
      }
      const narration = { ...event, data: { ...event.data, text } };
      recordProgress(narration);
      send(narration as unknown as Record<string, unknown>);
      return;
    }
    recordProgress(event);
    send(event as unknown as Record<string, unknown>);
  };
  const fileTreePush = createFileTreePushController(context, state, send);
  // The model already handed us the full text of every file it wrote, so stream it
  // to the frontend instead of making it fetch the file back over /file (which costs
  // a sandbox shell round trip per click). Bounded per file and per turn so a large
  // asset cannot bloat the stream or the in-process replay buffer — anything over
  // budget simply falls back to /file.
  let filePushBudgetBytes = FILE_PUSH_TURN_BUDGET_BYTES;
  const handleProjectFilesChanged = async (file?: { path: string; content: string }) => {
    if (file) {
      const bytes = utf8ByteLength(file.content);
      if (bytes <= FILE_PUSH_MAX_BYTES && bytes <= filePushBudgetBytes) {
        filePushBudgetBytes -= bytes;
        send({
          type: 'file_content',
          data: {
            path: toAppRelPath(file.path, state.appDir) || file.path,
            content: file.content,
            size: bytes,
          },
        });
      }
    }
    // The tree follows the content so the panel does not wait for the whole
    // turn, but debounced: a scaffold writes a dozen files at once and only the
    // last listing is the one anybody sees.
    fileTreePush.schedule();
    // Debounced store backup while the agent is still writing — covers the long
    // window where files live only in the volatile sandbox.
    checkpoint.schedule();
  };

  // Switch the iframe the moment a direct Makers CLI command returns a URL,
  // without waiting for verification or the finalize behind it, which can take
  // several more seconds.
  const handlePreviewReady = (preview: { url?: string; sandboxDebugUrl?: string; kind?: 'sandbox' | 'makers' }) => {
    if (!preview.url) {
      return;
    }
    state.previewUrl = preview.url;
    state.sandboxDebugUrl = preview.sandboxDebugUrl;
    state.previewKind = preview.kind || (isMakersDeployUrl(preview.url) ? 'makers' : 'sandbox');
    state.previewPublished = true;
    // Persist before the turn finishes so a refresh during verification still
    // resumes into the preview pane and restarts the live server.
    void saveProjectState(context, conversationId, state);
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
  const handleDeploymentStatus = (deployment: DeploymentInfo) => {
    state.deployment = deployment;
    // The final turn commit is authoritative. This eager save keeps a completed
    // deployment recoverable if the browser refreshes during later model output.
    void saveProjectState(context, conversationId, state);
    send({
      type: 'deployment_status',
      data: deployment,
    });
  };

  // The model handles creative code work; build and service steps remain deterministic.
  const modelResult = await runCodingAgent(
    context,
    conversationId,
    message,
    history,
    state,
    !state.created,
    handleScaffoldLog,
    forwardProgress,
    handleProjectFilesChanged,
    handlePreviewReady,
    handleDeploymentStatus,
    abortSignal,
    { model: options.model, send },
  );

  if (modelResult.stopped || abortSignal?.aborted) {
    const stoppedReply = STOPPED_TURN_REPLY[replyLocale];
    await finalizeTurn(stoppedReply, 'stopped', {
      withSnapshot: modelResult.projectTouched,
    });
    send({
      type: 'result',
      data: {
        ok: false,
        stopped: true,
        reply: stoppedReply,
        conversation_id: conversationId,
        build: { status: 'skipped' as BuildStatus },
        preview: previewLinkFromState(state),
        deployment: state.deployment,
      },
    });
    return;
  }

  // Dest was skipped so the user can type a key. That is not a missing preview
  // and not a failed build — running verification here would paint the model's
  // wrap-up as a red error and then wipe the input card when the turn ended.
  if (state.gatewayPromptPending) {
    const pauseReply = GATEWAY_CREDENTIALS_USER_REPLY[replyLocale];
    send({
      type: 'agent',
      data: {
        ok: true,
        reply: pauseReply,
      },
    });

    let fileTree: FileTreeItem[] = [];
    if (modelResult.projectTouched) {
      await checkpoint.flush();
      fileTree = await fileTreePush.flush('Failed to read the file list.');
    }
    await finalizeTurn(pauseReply, 'completed', {
      withSnapshot: modelResult.projectTouched,
    });
    send({
      type: 'result',
      data: {
        ok: true,
        reply: pauseReply,
        conversation_id: conversationId,
        gatewayNeeded: true,
        project: {
          dir: state.appDir,
          created: modelResult.wasCreated,
        },
        build: { status: 'skipped' as BuildStatus },
        files: {
          root: state.appDir,
          items: fileTree,
        },
        download: { url: '/download', filename: 'source.zip' },
        preview: previewLinkFromState(state),
        deployment: state.deployment,
      },
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
  // Only a deployment from this turn: state.deployment outlives the turn, and
  // re-appending yesterday's URL to every later reply would be worse than none.
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

    send({
      type: 'result',
      data: {
        ok: false,
        reply: assistantReply,
        conversation_id: conversationId,
        build: {
          status: 'skipped' as BuildStatus,
          stderr: modelResult.error || assistantReply,
        },
        preview: {},
        deployment: state.deployment,
      },
    });
    return;
  }

  if (
    !modelResult.projectTouched
    && (modelResult.previewTouched || modelResult.deploymentTouched)
  ) {
    if (modelResult.previewTouched && state.previewUrl) {
      send({
        type: 'preview_ready',
        data: {
          preview: {
            url: state.previewUrl,
            sandboxDebugUrl: state.sandboxDebugUrl,
            kind: state.previewKind,
          },
        },
      });
    }

    const previewReady = !modelResult.previewTouched || Boolean(state.previewUrl);
    const deploymentReady = !modelResult.deploymentTouched
      || state.deployment?.status === 'success';
    const operationOk = modelResult.success && previewReady && deploymentReady;
    await finalizeTurn(assistantReply, operationOk ? 'completed' : 'failed');

    send({
      type: 'result',
      data: {
        ok: operationOk,
        reply: assistantReply,
        conversation_id: conversationId,
        build: { status: 'skipped' as BuildStatus },
        preview: modelResult.previewTouched
          ? {
              url: state.previewUrl,
              sandboxDebugUrl: state.sandboxDebugUrl,
              kind: state.previewKind,
              ...(!state.previewUrl ? { error: 'The agent did not complete the Makers CLI preview.' } : {}),
            }
          : previewLinkFromState(state),
        deployment: state.deployment,
      },
    });
    return;
  }

  if (!modelResult.projectTouched) {
    await finalizeTurn(assistantReply, modelResult.success ? 'completed' : 'failed', {
      withState: false,
    });

    send({
      type: 'result',
      data: {
        ok: modelResult.success,
        reply: assistantReply,
        conversation_id: conversationId,
        build: { status: 'skipped' as BuildStatus },
        preview: {},
        deployment: state.deployment,
      },
    });
    return;
  }

  // Files are on disk now — flush before verification/auto-fix so that long
  // build window cannot recycle the sandbox with only an in-memory project.
  await checkpoint.flush();

  let fileTree = await fileTreePush.flush('Failed to read the file list.');
  // A preview that came up in this turn already compiled this turn's code and
  // answered its smoke tests, so the production build has nothing left to prove
  // here that publishing does not prove for real. Without one, the build is the
  // only evidence the project assembles at all, so it runs.
  let build = await runVerification(context, state, {
    previewVerified: modelResult.previewTouched && Boolean(state.previewUrl),
  });
  let autoFixAttempts = 0;
  let autoFixApplied = false;
  let autoFixReply = '';

  // The project has files on disk from here on, so expose a download link. The
  // archive is built on demand by /download; this is just a pointer (the
  // authoritative filename comes from the /download response).
  const downloadLink = { url: '/download', filename: 'source.zip' };

  if (build.fatal) {
    const fatalReply = build.stderr || 'The task failed, and the remaining workflow was stopped.';
    await finalizeTurn(fatalReply, 'failed', { withSnapshot: true });

    send({
      type: 'result',
      data: {
        ok: false,
        reply: fatalReply,
        conversation_id: conversationId,
        project: {
          dir: state.appDir,
          created: modelResult.wasCreated,
        },
        build,
        files: {
          root: state.appDir,
          items: fileTree,
        },
        download: downloadLink,
        preview: {},
        deployment: state.deployment,
      },
    });
    return;
  }

  if (build.status === 'failed' && modelResult.success) {
    autoFixAttempts = AUTO_FIX_MAX_ATTEMPTS;
    autoFixApplied = true;
    send({
      type: 'status',
      message: `Verification failed. Running auto-fix 1/${AUTO_FIX_MAX_ATTEMPTS}`,
    });

    const autoFixPrompt = buildAutoFixPrompt(
      message,
      assistantReply,
      build,
      1,
      AUTO_FIX_MAX_ATTEMPTS,
    );
    const autoFixResult = await runCodingAgent(
      context,
      conversationId,
      autoFixPrompt,
      [
        ...history,
        { role: 'user', content: message },
        { role: 'assistant', content: assistantReply },
      ],
      state,
      false,
      handleScaffoldLog,
      forwardProgress,
      handleProjectFilesChanged,
      handlePreviewReady,
      handleDeploymentStatus,
      abortSignal,
      // Repairing on a different model than the one that wrote the code would
      // make a failed build hard to attribute to either.
      { model: options.model, send },
    );
    if (autoFixResult.stopped || abortSignal?.aborted) {
      const stoppedReply = STOPPED_TURN_REPLY[replyLocale];
      await finalizeTurn(stoppedReply, 'stopped', { withSnapshot: true });
      send({
        type: 'result',
        data: {
          ok: false,
          stopped: true,
          reply: stoppedReply,
          conversation_id: conversationId,
          build: { status: 'skipped' as BuildStatus },
          preview: previewLinkFromState(state),
          deployment: state.deployment,
        },
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

    fileTree = await fileTreePush.flush('Failed to read the file list after auto-fix.');
    // Deliberately the full verification, preview or not: getting here means
    // something was already broken, and the repair is exactly when the cheaper
    // evidence is worth the least.
    build = await runVerification(context, state);
    if (build.fatal) {
      const fatalReply = build.stderr || 'The task failed, and the remaining workflow was stopped.';
      await finalizeTurn(fatalReply, 'failed', { withSnapshot: true });

      send({
        type: 'result',
        data: {
          ok: false,
          reply: fatalReply,
          conversation_id: conversationId,
          project: {
            dir: state.appDir,
            created: modelResult.wasCreated,
          },
          build,
          files: {
            root: state.appDir,
            items: fileTree,
          },
          download: downloadLink,
          preview: {},
          deployment: state.deployment,
        },
      });
      return;
    }
  }

  build = {
    ...build,
    ...(autoFixAttempts > 0 ? { autoFixAttempts, autoFixApplied } : {}),
  };

  // Makers dev owns preview state; deployments are streamed separately.
  if (state.previewUrl) {
    send({
      type: 'preview_ready',
      data: {
        preview: {
          url: state.previewUrl,
          sandboxDebugUrl: state.sandboxDebugUrl,
          kind: state.previewKind,
        },
      },
    });
  }

  const isChinese = replyLocale === 'zh';
  const outcome = resolveFinishedTurn({
    // Scaffolding sets projectTouched and the workflow asks for it every turn,
    // so it cannot stand in for this.
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
  const previewMissing = outcome.previewMissing;
  const turnFailed = outcome.failed;
  const reply = withLiveDeploymentUrl(outcome.reply, liveDeploymentUrl);

  // Code first, then state, then conversation — so a crash mid-finalize still
  // leaves a restorable workspace for resume after sandbox recycle.
  const turnOk = modelResult.success && !turnFailed;
  await finalizeTurn(reply, turnOk ? 'completed' : 'failed', { withSnapshot: true });

  send({
    type: 'result',
    data: {
      ok: turnOk,
      reply,
      conversation_id: conversationId,
      project: {
        dir: state.appDir,
        created: modelResult.wasCreated,
      },
      build,
      files: {
        root: state.appDir,
        items: fileTree,
      },
      download: downloadLink,
      preview: {
        url: state.previewUrl,
        sandboxDebugUrl: state.sandboxDebugUrl,
        kind: state.previewKind,
        ...(previewMissing ? { error: 'The agent did not complete the Makers CLI preview.' } : {}),
      },
      deployment: state.deployment,
    },
  });
}
