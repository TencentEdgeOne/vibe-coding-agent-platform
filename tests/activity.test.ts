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

test('directory tools summarize as a path, not JSON', () => {
  assert.equal(summarizeToolInput('mcp__edgeone-sandbox__files_make_dir', { path: 'src/lib' }), 'src/lib');
});

test('Skill activity shows the skill name and drops the echoed launch line', () => {
  assert.equal(summarizeToolInput('Skill', { skill: 'edgeone-makers-tools' }), 'edgeone-makers-tools');
  assert.equal(summarizeToolOutput('Launching skill: edgeone-makers-tools', '', 'Skill'), '');
  assert.match(summarizeToolOutput('Skill not found: nope', '', 'Skill'), /Skill not found/);
});

test('specific Makers skill activity shows its reference and hides the document body', () => {
  const name = 'mcp__edgeone-sandbox__load_makers_skill';
  assert.equal(summarizeToolInput(name, { skill: 'makers-agents' }), 'makers-agents');
  assert.equal(summarizeToolOutput('---\nname: edgeone-makers-agents\n---\nGuide', '', name), '');
  assert.match(summarizeToolOutput('Unable to load Makers skill: missing', '', name), /Unable to load/);
});

test('tool output is capped at eight kilobytes', () => {
  const summary = summarizeToolOutput('x'.repeat(10_000));
  assert.ok(summary.length < 8_200);
  assert.match(summary, /truncated$/);
});
