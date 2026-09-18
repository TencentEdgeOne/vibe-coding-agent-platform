import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeToolInput, summarizeToolOutput } from '../shared/timeline.ts';

test('tool summaries redact secrets and project paths', () => {
  const summary = summarizeToolInput('mcp__edgeone__commands', {
    command: 'curl -H "Authorization: Bearer top-secret" /tmp/project/api?token=abc',
    apiKey: 'secret-key',
  }, '/tmp/project');

  assert.doesNotMatch(summary, /top-secret|secret-key|token=abc/);
  assert.match(summary, /\[REDACTED\]/);
  assert.match(summary, /<project>/);
});

test('file writes expose paths and sizes without source contents', () => {
  const summary = summarizeToolInput('write_project_file', {
    path: 'src/app.tsx',
    content: 'const privateValue = 42;',
  });

  assert.match(summary, /src\/app\.tsx/);
  assert.match(summary, /24 chars/);
  assert.doesNotMatch(summary, /privateValue/);
});

test('a streamed single-file call stays blank until its path arrives', () => {
  assert.equal(summarizeToolInput('write_project_file', {}), '');
});

test('directory tools keep the path in the dumped input', () => {
  assert.match(summarizeToolInput('mcp__edgeone-sandbox__files_make_dir', { path: 'src/lib' }), /src\/lib/);
});

test('Skill activity keeps the skill name and the tool output', () => {
  assert.match(summarizeToolInput('Skill', { skill: 'edgeone-makers-tools' }), /edgeone-makers-tools/);
  assert.match(summarizeToolOutput('Launching skill: edgeone-makers-tools', '', 'Skill'), /Launching skill/);
  assert.match(summarizeToolOutput('Skill not found: nope', '', 'Skill'), /Skill not found/);
});

test('specific Makers skill activity keeps the document body', () => {
  const name = 'mcp__edgeone-sandbox__load_makers_skill';
  assert.match(summarizeToolInput(name, { skill: 'makers-agents' }), /makers-agents/);
  assert.match(summarizeToolOutput('---\nname: edgeone-makers-agents\n---\nGuide', '', name), /makers-agents/);
  assert.match(summarizeToolOutput('Unable to load Makers skill: missing', '', name), /Unable to load/);
});

test('glob and skill inputs keep every field instead of a short label', () => {
  const glob = summarizeToolInput('Glob', { pattern: '**/*', path: 'src' });
  assert.match(glob, /pattern/);
  assert.match(glob, /\*\*\/\*/);
  assert.match(glob, /"path": "src"/);

  const skill = summarizeToolInput('mcp__edgeone-sandbox__load_makers_skill', {
    skill: 'makers-agents',
    ref: 'platform/sse-protocol.md',
  });
  assert.match(skill, /makers-agents/);
  assert.match(skill, /platform\/sse-protocol\.md/);
});

test('tool output is capped at eight kilobytes', () => {
  const summary = summarizeToolOutput('x'.repeat(10_000));
  assert.ok(summary.length < 8_200);
  assert.match(summary, /truncated$/);
});
