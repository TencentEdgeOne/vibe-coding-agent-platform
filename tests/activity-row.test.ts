import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { AssistantActivity, PersistedActivityTurn } from '../shared/protocol.ts';
import {
  applyStreamEvent,
  buildAssistantTimeline,
  groupTimelineBlocks,
  summarizeToolGroup,
  visibleRefinedBlocks,
  type AssistantTimelineToolBlock,
} from '../shared/timeline.ts';
import {
  autoOpenForStatus,
  formatActivityDuration,
  resolveDisclosure,
} from '../app/features/workspace/components/conversation/activity-disclosure.ts';

const CONVERSATION = 'app/features/workspace/components/conversation';

type ToolActivity = Extract<AssistantActivity, { kind: 'tool' }>;

function tool(overrides: Partial<ToolActivity> & { name: string }): ToolActivity {
  return {
    kind: 'tool',
    toolUseId: overrides.name,
    status: 'completed',
    ...overrides,
  };
}

const read = (id: string, path: string) => tool({
  name: 'read',
  toolUseId: id,
  inputSummary: JSON.stringify({ path }),
});

const write = (id: string, path: string, status: ToolActivity['status'] = 'completed') => tool({
  name: 'write_project_file',
  toolUseId: id,
  status,
  inputSummary: `${path} (120 chars)`,
});

const deploy = (id: string) => tool({
  name: 'commands',
  toolUseId: id,
  inputSummary: 'edgeone makers deploy',
});

function toolBlocks(activities: ToolActivity[]) {
  return buildAssistantTimeline(activities) as AssistantTimelineToolBlock[];
}

// ---- Disclosure ----------------------------------------------------------

test('a step is open while it runs and settles shut once it lands', () => {
  assert.equal(autoOpenForStatus('running'), true);
  assert.equal(autoOpenForStatus('completed'), false);
  assert.equal(autoOpenForStatus('stopped'), false);
});

test('a failed step stays open, because it is the only thing left to act on', () => {
  assert.equal(autoOpenForStatus('failed'), true);
});

// A row that shuts itself while someone is reading it loses them their place,
// so the reader's own choice has to outrank the automatic one.
test('what the reader opened stays open after the step finishes', () => {
  assert.equal(resolveDisclosure('completed', true), true);
  assert.equal(resolveDisclosure('running', false), false);
  assert.equal(resolveDisclosure('completed', null), false);
});

test('a finished step always reports how long it took', () => {
  assert.equal(formatActivityDuration(1_000, 1_400), '0.4s');
  assert.equal(formatActivityDuration(1_000, 2_500), '1.5s');
  assert.equal(formatActivityDuration(1_000, 67_000), '1m 6s');
  assert.equal(formatActivityDuration(undefined, 2_000), '');
});

// ---- Grouping ------------------------------------------------------------

test('a run of routine file work folds into a single row', () => {
  const grouped = groupTimelineBlocks(toolBlocks([
    read('a', 'app/page.tsx'),
    read('b', 'app/layout.tsx'),
    write('c', 'app/page.tsx'),
  ]));

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].kind, 'group');
});

test('a run too short to fold stays as the steps it is', () => {
  const grouped = groupTimelineBlocks(toolBlocks([
    read('a', 'app/page.tsx'),
    write('b', 'app/page.tsx'),
  ]));

  assert.equal(grouped.length, 2);
  assert.deepEqual(grouped.map((block) => block.kind), ['tool', 'tool']);
});

// A deploy is what the user is actually waiting on. Folding it in among the
// file bookkeeping would hide the one step they came to watch.
test('platform work always keeps a row of its own', () => {
  const grouped = groupTimelineBlocks(toolBlocks([
    read('a', 'app/page.tsx'),
    read('b', 'app/layout.tsx'),
    read('c', 'app/globals.css'),
    deploy('d'),
    write('e', 'app/page.tsx'),
    write('f', 'app/layout.tsx'),
    write('g', 'app/globals.css'),
  ]));

  assert.deepEqual(grouped.map((block) => block.kind), ['group', 'tool', 'group']);
});

// The row is named for the topic it went and read, and a fold speaks for the
// run with one generic label — which is exactly the label this row exists to
// replace.
test('a reference load is never folded into a run of file work', () => {
  const load = (id: string, skill: string) => tool({
    name: 'mcp__edgeone-sandbox__load_makers_skill',
    toolUseId: id,
    inputSummary: skill,
  });
  const grouped = groupTimelineBlocks(toolBlocks([
    read('a', 'app/page.tsx'),
    read('b', 'app/layout.tsx'),
    load('c', 'makers-storage'),
    write('d', 'app/page.tsx'),
  ]));

  assert.deepEqual(grouped.map((block) => block.kind), ['tool', 'tool', 'tool', 'tool']);
});

test('text between two runs of file work keeps them apart', () => {
  const grouped = groupTimelineBlocks(buildAssistantTimeline([
    read('a', 'app/page.tsx'),
    read('b', 'app/layout.tsx'),
    read('c', 'app/globals.css'),
    { kind: 'text', content: 'Now wiring the route.' },
    write('e', 'app/page.tsx'),
  ]));

  assert.deepEqual(grouped.map((block) => block.kind), ['group', 'text', 'tool']);
});

// ---- Group summary -------------------------------------------------------

test('a folded row speaks for the step still running', () => {
  const summary = summarizeToolGroup(toolBlocks([
    read('a', 'app/page.tsx'),
    write('b', 'app/layout.tsx', 'running'),
    read('c', 'app/globals.css'),
  ]));

  assert.equal(summary.status, 'running');
  assert.equal(summary.action, 'Write file');
  assert.equal(summary.count, 3);
});

// Otherwise a failure could hide behind whatever step happened to come after.
test('a failure inside a folded run speaks for the row', () => {
  const summary = summarizeToolGroup(toolBlocks([
    read('a', 'app/page.tsx'),
    write('b', 'app/layout.tsx', 'failed'),
    read('c', 'app/globals.css'),
  ]));

  assert.equal(summary.status, 'failed');
  assert.equal(summary.action, 'Write file');
});

test('a run where everything landed speaks for the step that landed last', () => {
  const summary = summarizeToolGroup(toolBlocks([
    read('a', 'app/page.tsx'),
    read('b', 'app/layout.tsx'),
    write('c', 'app/globals.css'),
  ]));

  assert.equal(summary.status, 'completed');
  assert.equal(summary.action, 'Write file');
  assert.equal(summary.target, 'app/globals.css');
});

test('the reading view hides SDK status, session, and usage rows', () => {
  const blocks = buildAssistantTimeline([
    { kind: 'thinking', content: 'Need a form.' },
    { kind: 'info', infoType: 'status', title: 'Status', content: 'compacting' },
    { kind: 'info', infoType: 'system', title: 'Session', content: 'model=claude' },
    { kind: 'info', infoType: 'usage', title: 'Usage', content: 'turns=1' },
    write('a', 'app/page.tsx'),
  ]);
  const visible = visibleRefinedBlocks(blocks);
  assert.deepEqual(visible.map((block) => block.kind), ['thinking', 'tool']);
});

test('the reading view hides thinking_tokens and stitches the thought back together', () => {
  const blocks = buildAssistantTimeline([
    { kind: 'thinking', content: 'Fix the typo first.', startedAt: 1_000, endedAt: 1_000 },
    {
      kind: 'info',
      infoType: 'sdk',
      title: 'thinking_tokens',
      content: '{"subtype":"thinking_tokens"}',
    },
    { kind: 'thinking', content: ' Then write the page.', startedAt: 1_001, endedAt: 1_400 },
    { kind: 'info', infoType: 'usage', title: 'Usage', content: 'turns=1' },
  ]);
  const visible = visibleRefinedBlocks(blocks);
  assert.deepEqual(visible.map((block) => block.kind), ['thinking']);
  assert.equal(visible[0]?.kind === 'thinking' && visible[0].content, 'Fix the typo first. Then write the page.');
  assert.equal(visible[0]?.kind === 'thinking' && visible[0].startedAt, 1_000);
  assert.equal(visible[0]?.kind === 'thinking' && visible[0].endedAt, 1_400);
});

test('thinking_tokens pings do not split a live thought into empty rows', () => {
  let turn: PersistedActivityTurn = {
    id: 't',
    user: '',
    assistant: '',
    status: 'completed',
    createdAt: 0,
    activities: [],
  };
  turn = applyStreamEvent(turn, { type: 'thinking_segment', data: { text: 'Fix the typo first.' } });
  turn = applyStreamEvent(turn, {
    type: 'system_info',
    data: { infoType: 'sdk', title: 'thinking_tokens', content: '{"output":12}' },
  });
  turn = applyStreamEvent(turn, { type: 'thinking_segment', data: { text: ' Then write the page.' } });

  assert.equal(turn.activities.length, 1);
  assert.equal(turn.activities[0]?.kind, 'thinking');
  assert.equal(
    turn.activities[0]?.kind === 'thinking' && turn.activities[0].content,
    'Fix the typo first. Then write the page.',
  );
  assert.equal(turn.activities[0]?.kind === 'thinking' && turn.activities[0].endedAt, undefined);
});

test('thinking records when it started and when the next step took over', () => {
  let turn: PersistedActivityTurn = {
    id: 't',
    user: '',
    assistant: '',
    status: 'completed',
    createdAt: 0,
    activities: [],
  };
  turn = applyStreamEvent(turn, { type: 'thinking_segment', data: { text: 'Need a form.' } });
  assert.equal(turn.activities[0]?.kind, 'thinking');
  assert.ok(turn.activities[0]?.kind === 'thinking' && turn.activities[0].startedAt);
  assert.equal(turn.activities[0]?.kind === 'thinking' && turn.activities[0].endedAt, undefined);

  turn = applyStreamEvent(turn, {
    type: 'tool_use',
    data: { id: 'g1', name: 'Glob', inputSummary: '{\n' },
  });
  assert.ok(turn.activities[0]?.kind === 'thinking' && turn.activities[0].endedAt);
});

// The raw projection is worth keeping for development, and worth keeping out
// of the product. Both halves of that have to stay true.
test('the raw activity view stays available behind the development switch', async () => {
  const [classic, stream, hook, conversation] = await Promise.all([
    readFile(`${CONVERSATION}/activity-blocks.tsx`, 'utf8'),
    readFile(`${CONVERSATION}/activity-stream.tsx`, 'utf8'),
    readFile('app/features/workspace/hooks/use-activity-style.ts', 'utf8'),
    readFile(`${CONVERSATION}/index.tsx`, 'utf8'),
  ]);

  assert.match(classic, /export function formatToolDump\(/);
  assert.match(classic, /<details open/);
  assert.match(stream, /visibleRefinedBlocks/);
  assert.match(stream, /style === 'classic'/);
  assert.match(hook, /process\.env\.NODE_ENV === 'development'/);
  assert.match(conversation, /SHOW_ACTIVITY_STYLE_TOGGLE && \(/);
});

test('production is handed one style, so the raw dump cannot reach a user', async () => {
  const hook = await readFile('app/features/workspace/hooks/use-activity-style.ts', 'utf8');

  assert.match(hook, /SHOW_ACTIVITY_STYLE_TOGGLE \? style : \('refined' as ActivityStyle\)/);
});

test('a tool row is named for what it did, not for the tool that did it', async () => {
  const toolBlock = await readFile(`${CONVERSATION}/tool-block.tsx`, 'utf8');

  assert.match(toolBlock, /copy\.toolActions\[presentation\.action\]/);
  assert.match(toolBlock, /copy\.referenceTopics\[presentation\.topic\]/);
  assert.doesNotMatch(toolBlock, /activity\.name/);
});

test('an open log follows new output until the reader scrolls it back', async () => {
  const [row, conversation, thinking] = await Promise.all([
    readFile(`${CONVERSATION}/activity-row.tsx`, 'utf8'),
    readFile(`${CONVERSATION}/index.tsx`, 'utf8'),
    readFile(`${CONVERSATION}/thinking-block.tsx`, 'utf8'),
  ]);

  assert.match(row, /export function FollowLog\(/);
  assert.match(row, /followRef\.current = node\.scrollHeight - node\.scrollTop - node\.clientHeight < 24/);
  assert.match(conversation, /followOutputRef\.current = nearBottom/);
  assert.match(thinking, /startedAt=\{startedAt\}/);
  assert.match(thinking, /<FollowLog /);
});
