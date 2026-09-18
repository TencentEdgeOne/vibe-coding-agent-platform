import {
  query,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  DEFAULT_PATH,
  GATEWAY_CONVERSATION_ID_HEADER_NAME,
  GATEWAY_QUOTA_BYPASS_HEADER,
  GATEWAY_QUOTA_PROMPT_HEADER,
  MAKERS_SKILL_NAMES,
  SANDBOX_MCP_SERVER_NAME,
} from '../constants.ts';
import {
  describeModelRun,
  resolveConfiguredModel,
  resolveRunningModelLabel,
} from '../models.ts';
import type { AgentContext } from '../runtime/context.ts';
import {
  assembleAgentTools,
  emptyCodingResult,
  type LiveSessionHandle,
  type LiveTurnCallbacks,
} from '../tools/assemble.ts';
import type {
  AgentProgressEvent,
  CodingAgentResult,
  ProjectState,
} from '../types.ts';
import { detectFatalToolError, truncateForStream } from '../utils/text.ts';
import { sanitizeAssistantText, summarizeToolOutput } from '../../../shared/timeline.ts';
import { parseEchoedExitCode } from '../makers/tool-phase.ts';
import { buildPrompt } from '../prompt.ts';
import { resolveMakersProjectName } from '../makers/project.ts';
import { getConversationRecord, getLanguagePreference, patchConversationRecord } from './store.ts';
import { downloadTranscript, resolveClaudeTranscriptPath, uploadTranscript } from './transcript.ts';
import { PromptQueue } from './prompt-queue.ts';
import {
  createProgressEmitter,
  describeSdkMessage,
  extractVisibleNarrationDelta,
  extractVisibleTextBlock,
  extractVisibleThinkingBlock,
  extractVisibleThinkingDelta,
  formatResultUsage,
  isThinkingContentBlock,
  isToolUseContentBlock,
  parseToolInputJson,
  type StreamingToolUseBlock,
} from './stream-projector.ts';

type TurnWaiter = {
  callbacks: LiveTurnCallbacks;
  onProgress?: (event: AgentProgressEvent) => void;
  resolve: (result: CodingAgentResult) => void;
};

type LiveQuerySession = LiveSessionHandle & {
  queue: PromptQueue;
  query: Query;
  sessionId?: string;
  transcriptPath?: string;
  model: string;
  turn?: TurnWaiter;
  state: ProjectState;
  pump: Promise<void>;
  idleTimer?: ReturnType<typeof setTimeout>;
};

/** Give up waiting for the CLI's SessionStart hook and let /prompt reuse the process. */
export const WARM_LIVE_QUERY_BUDGET_MS = 20_000;
/** Close a warmed process that never received a turn, so abandoned visits do not leak one. */
export const LIVE_QUERY_IDLE_MS = 5 * 60 * 1000;

const liveQueries = new Map<string, LiveQuerySession>();

export type StartLiveQueryOptions = {
  context: AgentContext;
  conversationId: string;
  state: ProjectState;
  isNewProject: boolean;
  abortSignal?: AbortSignal;
  model?: string;
};

export type RunCodingAgentOptions = StartLiveQueryOptions & {
  userMessage: string;
  onProgress?: (event: AgentProgressEvent) => void;
  onProjectFilesChanged?: LiveTurnCallbacks['onProjectFilesChanged'];
  onPreviewReady?: LiveTurnCallbacks['onPreviewReady'];
  onDeploymentStatus?: LiveTurnCallbacks['onDeploymentStatus'];
  send?: LiveTurnCallbacks['send'];
};

function pickEnvValue(context: AgentContext, key: string) {
  const value = context?.env?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizeHeaderValue(value: string) {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function buildAnthropicCustomHeaders(customHeaders: string, conversationId: string) {
  const safeConversationId = sanitizeHeaderValue(conversationId);
  return [
    customHeaders,
    GATEWAY_QUOTA_BYPASS_HEADER,
    GATEWAY_QUOTA_PROMPT_HEADER,
    safeConversationId
      ? `${GATEWAY_CONVERSATION_ID_HEADER_NAME}: ${safeConversationId}`
      : '',
  ].filter(Boolean).join('\n');
}

function userMessage(content: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
  };
}

function flagsFrom(session: LiveQuerySession): Pick<
  CodingAgentResult,
  'projectTouched' | 'filesWritten' | 'previewTouched' | 'deploymentTouched' | 'wasCreated'
> {
  return {
    projectTouched: session.flags.projectTouched,
    filesWritten: session.flags.filesWritten,
    previewTouched: session.flags.previewTouched,
    deploymentTouched: session.flags.deploymentTouched,
    wasCreated: false,
  };
}

function clearIdleTimer(session: LiveQuerySession) {
  if (!session.idleTimer) return;
  clearTimeout(session.idleTimer);
  session.idleTimer = undefined;
}

function scheduleIdleClose(session: LiveQuerySession) {
  clearIdleTimer(session);
  session.idleTimer = setTimeout(() => {
    if (session.turn) return;
    void disposeLiveQuery(session.conversationId);
  }, LIVE_QUERY_IDLE_MS);
}

function disposeLiveQuery(conversationId: string) {
  const session = liveQueries.get(conversationId);
  if (!session || session.turn) return false;
  clearIdleTimer(session);
  liveQueries.delete(conversationId);
  try {
    session.query.close();
  } catch (error) {
    console.warn('[agent] failed to close the idle SDK query', error);
  }
  session.queue.close();
  return true;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForLiveSessionId(
  session: LiveQuerySession,
  budgetMs: number,
  signal?: AbortSignal,
) {
  const startedAt = Date.now();
  while (!session.sessionId && Date.now() - startedAt < budgetMs) {
    if (signal?.aborted) return false;
    if (liveQueries.get(session.conversationId) !== session) return false;
    await sleep(50);
  }
  return Boolean(session.sessionId);
}

async function persistTranscript(session: LiveQuerySession) {
  if (!session.sessionId || !session.transcriptPath) return;
  await uploadTranscript({
    context: session.context,
    conversationId: session.conversationId,
    sessionId: session.sessionId,
    sourcePath: session.transcriptPath,
  });
}


async function pumpSession(session: LiveQuerySession) {
  const pendingToolUseBlocks = new Map<number, StreamingToolUseBlock>();
  const progress = createProgressEmitter({
    appDir: session.getState().appDir,
    onProgress: (event) => session.turn?.onProgress?.(event),
  });
  let fatalError: string | null = null;

  const finishTurn = async (result: CodingAgentResult) => {
    await persistTranscript(session).catch((error) => {
      console.warn('[transcript] upload failed', error);
    });
    const waiter = session.turn;
    session.turn = undefined;
    waiter?.resolve(result);
  };

  try {
    for await (const event of session.query as AsyncIterable<SDKMessage>) {
      const systemEvent = event as SDKMessage & { subtype?: string; session_id?: string };
      if (event.type === 'system' && systemEvent.subtype === 'compact_boundary') {
        await persistTranscript(session).catch((error) => {
          console.warn('[transcript] compaction upload failed', error);
        });
      }
      if (typeof systemEvent.session_id === 'string' && systemEvent.session_id) {
        session.sessionId = systemEvent.session_id;
        if (!session.transcriptPath) {
          session.transcriptPath = resolveClaudeTranscriptPath(systemEvent.session_id);
        }
      }

      if (!session.turn) continue;

      if (event.type === 'stream_event') {
        progress.emitNarration(
          extractVisibleNarrationDelta(event),
          typeof event.uuid === 'string' ? event.uuid : '',
          false,
        );
        progress.emitThinking(
          extractVisibleThinkingDelta(event),
          typeof event.uuid === 'string' ? event.uuid : '',
          false,
        );
        const streamEvent = (event as { event?: Record<string, any> }).event;
        if (streamEvent?.type === 'content_block_start') {
          const contentBlock = streamEvent.content_block;
          if (contentBlock?.type === 'text') {
            progress.beginTextBlock();
          }
          if (isThinkingContentBlock(contentBlock)) {
            progress.beginThinkingBlock();
            if (contentBlock?.type === 'redacted_thinking') {
              progress.emitThinking('(redacted)', typeof event.uuid === 'string' ? event.uuid : '', true);
            }
          }
          if (isToolUseContentBlock(contentBlock) && typeof streamEvent.index === 'number') {
            pendingToolUseBlocks.set(streamEvent.index, {
              id: typeof contentBlock.id === 'string' ? contentBlock.id : '',
              name: typeof contentBlock.name === 'string' ? contentBlock.name : '',
              inputJson: '',
              input: contentBlock.input,
            });
            progress.emitToolUseProgress({
              id: contentBlock.id,
              name: contentBlock.name,
              input: contentBlock.input,
            });
          }
        } else if (streamEvent?.type === 'content_block_delta') {
          const delta = streamEvent.delta;
          const pendingToolUse = typeof streamEvent.index === 'number'
            ? pendingToolUseBlocks.get(streamEvent.index)
            : undefined;
          if (pendingToolUse && delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            const previousLength = pendingToolUse.inputJson.length;
            pendingToolUse.inputJson += delta.partial_json;
            const parsed = parseToolInputJson(pendingToolUse.inputJson, pendingToolUse.input);
            const crossedChunk = Math.floor(previousLength / 120) !== Math.floor(pendingToolUse.inputJson.length / 120);
            if (crossedChunk || parsed !== pendingToolUse.input) {
              progress.emitToolUseProgress({
                id: pendingToolUse.id,
                name: pendingToolUse.name,
                input: parsed,
                inputJson: pendingToolUse.inputJson,
              });
            }
          }
        } else if (streamEvent?.type === 'content_block_stop') {
          const pendingToolUse = typeof streamEvent.index === 'number'
            ? pendingToolUseBlocks.get(streamEvent.index)
            : undefined;
          if (pendingToolUse) {
            pendingToolUseBlocks.delete(streamEvent.index);
            progress.emitToolUseProgress({
              id: pendingToolUse.id,
              name: pendingToolUse.name,
              input: parseToolInputJson(pendingToolUse.inputJson, pendingToolUse.input),
              inputJson: pendingToolUse.inputJson,
            });
          }
        }
        continue;
      }

      if (event.type === 'assistant') {
        const blocks = (event as { message?: { content?: unknown } }).message?.content;
        if (Array.isArray(blocks)) {
          for (const block of blocks) {
            progress.emitNarration(
              extractVisibleTextBlock(block),
              typeof event.uuid === 'string' ? event.uuid : '',
              true,
            );
            progress.emitThinking(
              extractVisibleThinkingBlock(block),
              typeof event.uuid === 'string' ? event.uuid : '',
              true,
            );
            if (isToolUseContentBlock(block)) {
              progress.emitToolUseProgress({ id: block.id, name: block.name, input: block.input });
            }
          }
        }
        continue;
      }

      if (event.type === 'user') {
        const blocks = (event as { message?: { content?: unknown } }).message?.content;
        if (Array.isArray(blocks)) {
          for (const block of blocks) {
            const record = block && typeof block === 'object' ? block as Record<string, unknown> : {};
            if (record.type !== 'tool_result') continue;
            const text = Array.isArray(record.content)
              ? record.content.map((item: any) => (typeof item?.text === 'string' ? item.text : '')).join(' ')
              : (typeof record.content === 'string' ? record.content : '');
            const toolUseId = typeof record.tool_use_id === 'string' ? record.tool_use_id : '';
            const toolContext = progress.toolContextById.get(toolUseId);
            const toolName = toolContext?.name || '<unknown>';
            const echoedExit = parseEchoedExitCode(text);
            const commandFailed = typeof echoedExit === 'number' && echoedExit !== 0;
            const toolFailed = record.is_error === true || commandFailed;
            session.turn?.onProgress?.({
              type: 'tool_result',
              data: {
                id: toolUseId,
                toolName,
                ...(toolContext?.command ? { command: toolContext.command } : {}),
                ok: !toolFailed,
                preview: truncateForStream(text, 8_000),
                outputSummary: summarizeToolOutput(text, session.getState().appDir, toolName),
                status: toolFailed ? 'failed' : 'completed',
                endedAt: Date.now(),
              },
            });
            if (record.is_error === true && !fatalError) {
              const fatal = detectFatalToolError(text);
              if (fatal) {
                fatalError = `${fatal} (tool=${toolName})`;
                console.warn('[fatal] aborting agent loop:', fatalError);
              }
            }
          }
        }
        if (fatalError) {
          await finishTurn(emptyCodingResult({
            error: fatalError,
            fatal: true,
            ...flagsFrom(session),
          }));
          fatalError = null;
        }
        continue;
      }

      if (event.type === 'tool_progress') {
        const progressEvent = event as SDKMessage & {
          tool_use_id?: string;
          tool_name?: string;
          elapsed_time_seconds?: number;
        };
        const toolUseId = typeof progressEvent.tool_use_id === 'string' ? progressEvent.tool_use_id : '';
        const toolContext = progress.toolContextById.get(toolUseId);
        const elapsed = typeof progressEvent.elapsed_time_seconds === 'number'
          ? Math.max(0, Math.round(progressEvent.elapsed_time_seconds))
          : 0;
        progress.emitToolUseProgress({
          id: toolUseId,
          name: progressEvent.tool_name || toolContext?.name || '<unknown>',
          outputSummary: elapsed ? `${elapsed}s` : 'running',
        });
        continue;
      }

      if (event.type === 'result') {
        const resultMessage = event as SDKResultMessage;
        progress.emitInfo({
          infoType: 'usage',
          title: 'Usage',
          content: formatResultUsage(resultMessage),
        });
        const modelRun = describeModelRun(session.model, resultMessage.modelUsage);
        if (modelRun.mismatch) {
          console.warn('[model]', `${modelRun.line} — the gateway served a model this turn did not request`);
        } else {
          console.info('[model]', modelRun.line);
        }
        if (resultMessage.subtype !== 'success') {
          await finishTurn(emptyCodingResult({
            error: Array.isArray(resultMessage.errors) && resultMessage.errors.length > 0
              ? resultMessage.errors[0]
              : 'Model execution failed.',
            ...flagsFrom(session),
          }));
        } else {
          await finishTurn({
            success: true,
            output: sanitizeAssistantText((resultMessage.result || '').trim()),
            error: null,
            ...flagsFrom(session),
          });
        }
        pendingToolUseBlocks.clear();
        progress.resetTurn();
        fatalError = null;
        continue;
      }

      const info = describeSdkMessage(event);
      if (info) progress.emitInfo(info);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const fatal = detectFatalToolError(message);
    if (session.turn) {
      await finishTurn(emptyCodingResult({
        error: fatal || message || 'Execution failed.',
        ...(fatal ? { fatal: true } : {}),
        ...flagsFrom(session),
      }));
    }
  } finally {
    if (session.turn) {
      await finishTurn(emptyCodingResult({
        error: 'The model stream ended without returning a result.',
        ...flagsFrom(session),
      }));
    }
    liveQueries.delete(session.conversationId);
    clearIdleTimer(session);
    try {
      session.query.close();
    } catch (error) {
      console.warn('[agent] failed to close the SDK query', error);
    }
    session.queue.close();
  }
}

async function startLiveQuery(options: StartLiveQueryOptions): Promise<LiveQuerySession | CodingAgentResult> {
  const { context, conversationId } = options;
  const apiKey = pickEnvValue(context, 'AI_GATEWAY_API_KEY')
    || pickEnvValue(context, 'ANTHROPIC_API_KEY')
    || pickEnvValue(context, 'DEEPSEEK_API_KEY');
  const authToken = pickEnvValue(context, 'ANTHROPIC_AUTH_TOKEN')
    || pickEnvValue(context, 'DEEPSEEK_API_KEY');
  const model = (options.model || '').trim() || resolveConfiguredModel(context);
  const baseURL = pickEnvValue(context, 'AI_GATEWAY_BASE_URL')
    || pickEnvValue(context, 'ANTHROPIC_BASE_URL')
    || pickEnvValue(context, 'DEEPSEEK_BASE_URL')
    || '';
  const customHeaders = pickEnvValue(context, 'ANTHROPIC_CUSTOM_HEADERS');
  const executablePath = pickEnvValue(context, 'CLAUDE_CODE_EXECUTABLE_PATH');

  if (!apiKey && !authToken) {
    return emptyCodingResult({
      error: 'Missing AI_GATEWAY_API_KEY / ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / DEEPSEEK_API_KEY. The agent cannot call the model.',
    });
  }
  if (!baseURL) {
    return emptyCodingResult({
      error: 'Missing AI_GATEWAY_BASE_URL / ANTHROPIC_BASE_URL / DEEPSEEK_BASE_URL. The agent cannot call the model.',
    });
  }

  const session = {
    conversationId,
    context,
    state: options.state,
    getState: () => session.state,
    getCallbacks: () => session.turn?.callbacks || {},
    flags: {
      projectTouched: false,
      filesWritten: false,
      previewTouched: false,
      deploymentTouched: false,
    },
    queue: new PromptQueue(),
    query: null as unknown as Query,
    model,
    pump: Promise.resolve(),
  } as LiveQuerySession;

  const assembled = assembleAgentTools(session);
  const sdkEnv: Record<string, string> = {
    ANTHROPIC_BASE_URL: baseURL,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_CUSTOM_HEADERS: buildAnthropicCustomHeaders(customHeaders, conversationId),
    PATH: pickEnvValue(context, 'PATH') || DEFAULT_PATH,
    HOME: pickEnvValue(context, 'HOME') || '/tmp',
    CLAUDE_CONFIG_DIR: pickEnvValue(context, 'CLAUDE_CONFIG_DIR') || '/tmp/.claude',
  };
  if (apiKey) sdkEnv.ANTHROPIC_API_KEY = apiKey;
  if (authToken) sdkEnv.ANTHROPIC_AUTH_TOKEN = authToken;
  if (!sdkEnv.ANTHROPIC_API_KEY && authToken) sdkEnv.ANTHROPIC_API_KEY = authToken;

  const record = await getConversationRecord(context, conversationId);
  if (record.claudeSessionId && record.transcriptPath) {
    const restored = await downloadTranscript({
      context,
      conversationId,
      sessionId: record.claudeSessionId,
      destPath: record.transcriptPath,
    });
    if (restored) {
      session.sessionId = record.claudeSessionId;
      session.transcriptPath = record.transcriptPath;
    }
  }

  const sdkOptions: Parameters<typeof query>[0]['options'] = {
    model,
    permissionMode: 'dontAsk',
    maxTurns: 100,
    tools: ['Skill'],
    skills: [...MAKERS_SKILL_NAMES],
    includePartialMessages: true,
    persistSession: true,
    mcpServers: {
      [assembled.mcpServerName]: assembled.sandboxMcpServer,
    },
    allowedTools: assembled.mcpAllowedTools,
    strictMcpConfig: true,
    systemPrompt: buildPrompt(
      session.getState(),
      options.isNewProject,
      SANDBOX_MCP_SERVER_NAME,
      resolveMakersProjectName(context, session.getState()),
      resolveRunningModelLabel(context, model),
      assembled.webSearchAvailable,
      await getLanguagePreference(context, conversationId),
    ),
    env: sdkEnv,
    cwd: process.cwd(),
    settingSources: ['project'],
    stderr: (data: string) => {
      console.warn('[claude-code]', data.trimEnd());
    },
    hooks: {
      SessionStart: [{
        hooks: [async (input) => {
          if (input.hook_event_name === 'SessionStart') {
            session.sessionId = input.session_id;
            session.transcriptPath = resolveClaudeTranscriptPath(input.session_id, {
              explicitPath: input.transcript_path,
            });
            // Remember the path now. Upload still waits for the turn to end;
            // the Session tab reads this local file while the agent is running.
            await patchConversationRecord(session.context, session.conversationId, {
              claudeSessionId: input.session_id,
              transcriptPath: session.transcriptPath,
            }).catch((error) => {
              console.warn('[transcript] session path persist failed', error);
            });
          }
          return {};
        }],
      }],
      PostCompact: [{
        hooks: [async () => {
          await persistTranscript(session).catch((error) => {
            console.warn('[transcript] post-compact upload failed', error);
          });
          return {};
        }],
      }],
    },
    ...(session.sessionId ? { resume: session.sessionId } : {}),
  };
  if (executablePath) sdkOptions.pathToClaudeCodeExecutable = executablePath;

  session.query = query({
    prompt: session.queue,
    options: sdkOptions,
  });
  session.pump = pumpSession(session);
  liveQueries.set(conversationId, session);
  return session;
}

export function getLiveQuery(conversationId: string) {
  return liveQueries.get(conversationId) || null;
}

export type WarmLiveQueryResult = {
  ok: boolean;
  reused: boolean;
  error?: string;
};

export async function warmLiveQuery(options: StartLiveQueryOptions): Promise<WarmLiveQueryResult> {
  if (options.abortSignal?.aborted) {
    return { ok: false, reused: false, error: 'aborted' };
  }

  let session = liveQueries.get(options.conversationId);
  const reused = Boolean(session);
  if (!session) {
    const started = await startLiveQuery(options);
    if (!('queue' in started)) {
      return {
        ok: false,
        reused: false,
        error: started.error || 'The coding agent could not start.',
      };
    }
    session = started;
  } else {
    session.context = options.context;
    session.state = options.state;
  }

  if (!session.turn) scheduleIdleClose(session);
  await waitForLiveSessionId(session, WARM_LIVE_QUERY_BUDGET_MS, options.abortSignal);
  if (options.abortSignal?.aborted) {
    return { ok: false, reused, error: 'aborted' };
  }
  return { ok: true, reused };
}

export async function interruptLiveQuery(conversationId: string) {
  const live = liveQueries.get(conversationId);
  if (!live) return false;
  try {
    await live.query.interrupt();
    return true;
  } catch (error) {
    console.warn('[agent] interrupt failed', error);
    return false;
  }
}

export async function setLiveQueryModel(conversationId: string, model: string) {
  const live = liveQueries.get(conversationId);
  if (!live) return false;
  live.model = model;
  try {
    await live.query.setModel(model);
    return true;
  } catch (error) {
    console.warn('[agent] setModel failed', error);
    return false;
  }
}

export async function runCodingAgent(options: RunCodingAgentOptions): Promise<CodingAgentResult> {
  if (options.abortSignal?.aborted) {
    return emptyCodingResult({ stopped: true });
  }

  const model = (options.model || '').trim() || resolveConfiguredModel(options.context);
  let session = liveQueries.get(options.conversationId);
  if (!session) {
    const started = await startLiveQuery(options);
    if (!('queue' in started)) return started;
    session = started;
  } else {
    session.context = options.context;
    session.state = options.state;
    if (model !== session.model) {
      await setLiveQueryModel(options.conversationId, model);
    }
  }

  session.flags.projectTouched = false;
  session.flags.filesWritten = false;
  session.flags.previewTouched = false;
  session.flags.deploymentTouched = false;
  clearIdleTimer(session);

  const abort = () => {
    void interruptLiveQuery(options.conversationId);
  };
  options.abortSignal?.addEventListener('abort', abort, { once: true });

  try {
    const result = await new Promise<CodingAgentResult>((resolve) => {
      session!.turn = {
        callbacks: {
          onProjectFilesChanged: options.onProjectFilesChanged,
          onPreviewReady: options.onPreviewReady,
          onDeploymentStatus: options.onDeploymentStatus,
          send: options.send,
          abortSignal: options.abortSignal,
        },
        onProgress: options.onProgress,
        resolve,
      };
      session!.queue.push(userMessage(options.userMessage));
    });
    if (options.abortSignal?.aborted) {
      return { ...result, success: false, stopped: true, error: null };
    }
    return result;
  } finally {
    options.abortSignal?.removeEventListener('abort', abort);
  }
}
