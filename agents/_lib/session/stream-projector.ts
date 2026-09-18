import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { SANDBOX_MCP_SERVER_NAME } from '../constants.ts';
import type { AgentProgressEvent } from '../types.ts';
import {
  resolveNarrationEmit,
  sanitizeNarrationText,
  summarizeToolInput,
  type NarrationEmitState,
} from '../../../shared/timeline.ts';
import {
  isInstallCommand,
  isMakersDeployCommand,
  isPreviewCommand,
  shortenToolName,
} from '../makers/tool-phase.ts';

export function extractSandboxCommand(input: unknown) {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const command = typeof record.command === 'string'
    ? record.command
    : typeof record.cmd === 'string'
      ? record.cmd
      : '';
  return command.trim();
}

export function extractVisibleNarrationDelta(event: SDKMessage) {
  if (event.type !== 'stream_event') return '';
  const streamEvent = (event as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
  if (streamEvent?.type !== 'content_block_delta') return '';
  const delta = streamEvent.delta;
  if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
    return sanitizeNarrationText(delta.text);
  }
  return '';
}

export type StreamingToolUseBlock = {
  id: string;
  name: string;
  inputJson: string;
  input?: unknown;
};

export function isToolUseContentBlock(block: unknown): block is {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
} {
  const record = block && typeof block === 'object' ? block as Record<string, unknown> : {};
  return record.type === 'tool_use' || record.type === 'mcp_tool_use';
}

export function extractVisibleTextBlock(block: unknown) {
  const record = block && typeof block === 'object' ? block as Record<string, unknown> : {};
  if (record.type !== 'text' || typeof record.text !== 'string') return '';
  return sanitizeNarrationText(record.text);
}

export function parseToolInputJson(rawJson: string, fallback: unknown) {
  if (!rawJson.trim()) return fallback ?? {};
  try {
    return JSON.parse(rawJson);
  } catch {
    return fallback ?? {};
  }
}

type ToolProgressPhase = 'scaffold' | 'code' | 'install' | 'preview' | 'link';

export function inferToolProgress(name: string, input: unknown): {
  phaseHint?: ToolProgressPhase;
  fileCount?: number;
} {
  const toolName = shortenToolName(name);
  if (toolName === 'ensure_project_scaffold') return { phaseHint: 'scaffold' };
  if (toolName === 'files_write' || toolName === 'write_files' || toolName === 'files_make_dir' || toolName === 'files_remove') {
    return { phaseHint: 'code' };
  }
  if (toolName === 'write_project_file') return { phaseHint: 'code', fileCount: 1 };
  if (toolName === 'commands') {
    const cmd = extractSandboxCommand(input);
    if (isInstallCommand(cmd)) return { phaseHint: 'install' };
    if (isPreviewCommand(cmd) || isMakersDeployCommand(cmd)) return { phaseHint: 'preview' };
  }
  return {};
}

export const SCAFFOLD_TOOL_NAME = `mcp__${SANDBOX_MCP_SERVER_NAME}__ensure_project_scaffold`;

export function createProgressEmitter(options: {
  appDir: string;
  onProgress?: (event: AgentProgressEvent) => void;
}) {
  const toolContextById = new Map<string, { name: string; command?: string }>();
  const toolStartedAtById = new Map<string, number>();
  const emittedToolUseProgress = new Map<string, string>();
  let narrationState: NarrationEmitState = { currentTextBlock: '', emittedNarration: '' };

  const emitNarration = (rawText: string, uuid: string, complete = false) => {
    const resolved = resolveNarrationEmit(narrationState, rawText, complete);
    narrationState = resolved.state;
    if (!resolved.text) return;
    options.onProgress?.({
      type: 'text_segment',
      data: { uuid, text: resolved.text },
    });
  };

  const emitToolUseProgress = (toolUse: { id?: string; name?: string; input?: unknown }) => {
    const toolName = typeof toolUse.name === 'string' ? toolUse.name : '<unknown>';
    const toolUseId = typeof toolUse.id === 'string' ? toolUse.id : '';
    const shortToolName = shortenToolName(toolName);
    const command = shortToolName === 'commands' ? extractSandboxCommand(toolUse.input) : '';
    const progress = typeof toolUse.name === 'string' ? inferToolProgress(toolName, toolUse.input) : {};
    const inputSummary = summarizeToolInput(toolName, toolUse.input, options.appDir);
    const progressSignature = JSON.stringify({
      name: toolName,
      command,
      phaseHint: progress.phaseHint || '',
      fileCount: progress.fileCount || 0,
      inputSummary,
    });
    if (toolUseId) {
      if (emittedToolUseProgress.get(toolUseId) === progressSignature) return;
      emittedToolUseProgress.set(toolUseId, progressSignature);
    }
    narrationState = { ...narrationState, currentTextBlock: '' };
    if (toolUseId && typeof toolUse.name === 'string') {
      toolContextById.set(toolUseId, { name: toolUse.name, ...(command ? { command } : {}) });
    }
    const startedAt = toolUseId ? toolStartedAtById.get(toolUseId) || Date.now() : Date.now();
    if (toolUseId) toolStartedAtById.set(toolUseId, startedAt);
    options.onProgress?.({
      type: 'tool_use',
      data: {
        id: toolUseId,
        name: toolName,
        ...(command ? { command } : {}),
        ...progress,
        inputSummary,
        startedAt,
      },
    });
  };

  return {
    toolContextById,
    toolStartedAtById,
    emitNarration,
    emitToolUseProgress,
    resetNarration() {
      narrationState = { currentTextBlock: '', emittedNarration: '' };
    },
    beginTextBlock() {
      narrationState = { ...narrationState, currentTextBlock: '' };
    },
    resetTurn() {
      toolContextById.clear();
      toolStartedAtById.clear();
      emittedToolUseProgress.clear();
      narrationState = { currentTextBlock: '', emittedNarration: '' };
    },
  };
}
