import type { AssistantActivity, PersistedActivityTurn } from '../../../shared/protocol.ts';
import {
  appendNarrationChunk,
  sanitizeAssistantText,
  summarizeToolInput,
  summarizeToolOutput,
} from '../../../shared/timeline.ts';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' ? value as JsonRecord : {};
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return sanitizeAssistantText(content);
  if (!Array.isArray(content)) return '';
  return sanitizeAssistantText(
    content
      .map((block) => {
        const record = asRecord(block);
        return typeof record.text === 'string' ? record.text : '';
      })
      .join(''),
  );
}

function toolBlocks(content: unknown): JsonRecord[] {
  if (!Array.isArray(content)) return [];
  return content.filter((block) => {
    const record = asRecord(block);
    return record.type === 'tool_use' || record.type === 'mcp_tool_use' || record.type === 'tool_result';
  }).map(asRecord);
}

/**
 * Project a Claude Code JSONL transcript into the turns the workspace UI renders.
 * The file is the source of truth; this is a derived view.
 */
export function projectTranscript(jsonl: string, projectDir = ''): PersistedActivityTurn[] {
  const turns: PersistedActivityTurn[] = [];
  let current: PersistedActivityTurn | null = null;

  const openTurn = (user: string, createdAt: number) => {
    current = {
      id: `turn-${createdAt}-${turns.length}`,
      user,
      assistant: '',
      status: 'completed',
      createdAt,
      activities: [],
    };
    turns.push(current);
  };

  for (const rawLine of jsonl.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let entry: JsonRecord;
    try {
      entry = JSON.parse(line) as JsonRecord;
    } catch {
      continue;
    }
    const createdAt = Date.parse(String(entry.timestamp || '')) || Date.now();
    const message = asRecord(entry.message);
    const content = message.content;

    if (entry.type === 'user') {
      const tools = toolBlocks(content);
      const text = textFromContent(content);
      if (tools.some((block) => block.type === 'tool_result')) {
        if (!current) continue;
        for (const block of tools) {
          if (block.type !== 'tool_result') continue;
          const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
          const existing = current.activities.find(
            (activity): activity is Extract<AssistantActivity, { kind: 'tool' }> =>
              activity.kind === 'tool' && activity.toolUseId === id,
          );
          const output = typeof block.content === 'string'
            ? block.content
            : textFromContent(block.content);
          if (existing) {
            existing.status = block.is_error === true ? 'failed' : 'completed';
            existing.outputSummary = summarizeToolOutput(output, projectDir, existing.name);
            existing.endedAt = createdAt;
          }
        }
        continue;
      }
      if (text) openTurn(text, createdAt);
      continue;
    }

    if (entry.type === 'assistant' && current) {
      const text = textFromContent(content);
      if (text) {
        current.activities = appendNarrationChunk(current.activities, text);
        current.assistant = text;
      }
      for (const block of toolBlocks(content)) {
        if (block.type !== 'tool_use' && block.type !== 'mcp_tool_use') continue;
        const id = typeof block.id === 'string' ? block.id : '';
        const name = typeof block.name === 'string' ? block.name : 'tool';
        current.activities.push({
          kind: 'tool',
          toolUseId: id,
          name,
          status: 'completed',
          inputSummary: summarizeToolInput(name, block.input, projectDir),
          startedAt: createdAt,
        });
      }
    }
  }

  return turns;
}

export function turnsToMessages(turns: PersistedActivityTurn[]) {
  return turns.flatMap((turn) => [
    { role: 'user' as const, content: turn.user },
    { role: 'assistant' as const, content: turn.assistant },
  ]);
}
