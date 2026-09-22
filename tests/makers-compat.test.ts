import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { MAKERS_SKILL_NAMES } from '../agents/_lib/constants.ts';
import {
  MAKERS_REFERENCE_SKILL_NAMES,
  resolveMakersSkillDirectory,
} from '../agents/_lib/tools/makers-skills.ts';
import { readCommandsWrapSource } from './helpers/fixtures.ts';
import { surface } from './helpers/source.ts';

const skillsRoot = '.claude/skills';

test('vendored Makers skills exist and match the SDK skill list', async () => {
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.deepEqual(dirs, [...MAKERS_SKILL_NAMES].sort());
  for (const name of MAKERS_SKILL_NAMES) {
    const skill = await readFile(path.join(skillsRoot, name, 'SKILL.md'), 'utf8');
    // Frontmatter must declare a name, but the upstream repo owns the key order
    // (it leads with SkillHub's `slug:`), so match the block, not the first line.
    const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(frontmatter, `${name}/SKILL.md must open with a YAML frontmatter block`);
    assert.match(frontmatter[1], /^name: /m);
    assert.doesNotMatch(skill, /edgeone login --/);
    assert.doesNotMatch(skill, /makers deploy -t /);
  }
});

test('official Makers router and progressive references are vendored unchanged in structure', async () => {
  const router = await readFile(path.join(skillsRoot, 'edgeone-makers-tools', 'SKILL.md'), 'utf8');
  // Folded YAML: upstream rewraps this description freely, so the line break lands
  // wherever the sentence happens to reach the margin.
  //
  // No version assertion. It moved on every upstream edit and said nothing about
  // what it was protecting; the check that matters is the `edgeone login --` ban
  // above, which is what catches a sync from the operating-contract branch.
  assert.match(router, /This SKILL is a\s+routing table/);
  assert.match(router, /references\/makers-agents\/SKILL\.md/);
  assert.match(router, /references\/makers-recipes\/SKILL\.md/);
  await readFile(path.join(
    skillsRoot,
    'edgeone-makers-tools',
    'references',
    'makers-agents',
    'references',
    'platform',
    'conversation-id.md',
  ));
});

// What the prompt actually says is asserted behaviourally in
// prompt-single-source.test.ts; this covers the SDK session wiring around it.
test('the SDK session is wired to the vendored skills and the extracted prompt', async () => {
  const source = await readFile('agents/_lib/session/live.ts', 'utf8');
  assert.match(source, /skills: \[\.\.\.MAKERS_SKILL_NAMES\]/);
  assert.match(source, /tools: \['Skill'\]/);
  assert.match(source, /buildPrompt\(/);
  assert.doesNotMatch(
    source,
    /Vite projects must support sandbox preview under/,
    'generated Vite apps must not be forced onto the sandbox /preview/ base',
  );
  assert.doesNotMatch(
    source,
    /basePath: process\.env\.EDGEONE_PREVIEW_BASE_PATH/,
    'generated Next.js apps must not require the sandbox preview basePath',
  );
});

test('package.json without scripts.build is not a thrown verification failure', async () => {
  const source = await readFile('agents/_lib/project/scaffold.ts', 'utf8');
  assert.doesNotMatch(source, /process\.exit\(p\.scripts && p\.scripts\.build \? 0 : 2\)/);
  assert.match(source, /buildFlag === 'yes'/);
});

test('direct sandbox CLI replaces custom tools while retaining relevant compatibility checks', async () => {
  const [agent, projectTools, commandTools, compatibility] = await Promise.all([
    readFile('agents/_lib/session/live.ts', 'utf8'),
    readFile('agents/_lib/tools/project-tools.ts', 'utf8'),
    readCommandsWrapSource(),
    readFile('agents/_lib/makers/compat/lint-script.ts', 'utf8'),
  ]);
  const paths = await readFile('agents/_lib/utils/paths.ts', 'utf8');
  assert.doesNotMatch(agent, /buildPublishPreviewTool|buildDeployToMakersTool/);
  assert.doesNotMatch(projectTools, /publish_preview|deploy_to_makers|get_preview_link/);
  assert.match(commandTools, /buildMakersDevBackgroundCommand/);
  assert.match(commandTools, /buildMakersDeployCommand/);
  // The CLI's own dev launch publishes through the readiness layer, which is
  // also what the host and the client call, so the agent's preview cannot come
  // from a code path of its own.
  assert.match(commandTools, /ensurePreview\(/);
  assert.match(commandTools, /assertMakersProjectCompatible/);
  assert.match(compatibility, /agents\.framework is required/);
  assert.match(compatibility, /must declare AI_GATEWAY_API_KEY/);
  assert.match(compatibility, /gpt-4o-mini is not a valid Makers default/);
  assert.match(compatibility, /sandbox \/preview\/ prefix is hard-coded/);
  assert.match(compatibility, /basePath makes the framework expect a prefix/);
  assert.match(paths, /runtime environment files must not be generated/);
});

test('specific Makers skill loader reads official references without changing them', async () => {
  const source = await readFile('agents/_lib/tools/makers-skills.ts', 'utf8');
  const agent = await readFile('agents/_lib/tools/assemble.ts', 'utf8');
  assert.match(source, /'load_makers_skill'/);
  assert.match(agent, /buildLoadMakersSkillTool/);
  assert.match(agent, /__load_makers_skill/);

  // Every name the tool accepts must land on a vendored document that is served
  // as-is, so the model reads official guidance rather than a paraphrase.
  for (const skill of MAKERS_REFERENCE_SKILL_NAMES) {
    const overview = await readFile(
      path.join(resolveMakersSkillDirectory(skill), 'SKILL.md'),
      'utf8',
    );
    assert.match(overview, /^---\nname:/);
  }
});

test('cold resume restores project dependencies without managing the sandbox CLI', async () => {
  const resume = await readFile('agents/_lib/session/resume.ts', 'utf8');
  const readiness = await readFile('agents/_lib/project/readiness.ts', 'utf8');
  const client = await surface('app/features/workspace/workspace-api.ts');
  // A cold resume gets its install from the level that needs it rather than by
  // asking for one itself, which is why resume no longer names dependencies.
  assert.match(readiness, /ensureDependencies\(context, state, \{/);
  assert.doesNotMatch(resume, /prewarmEdgeoneCli|npm install -g edgeone/);
  // The budgets live together so the preview's can be read against the install
  // and dev server boot that happen inside it.
  assert.match(readiness, /preview: 540_000/);
  assert.match(readiness, /workspace: 600_000/);
  assert.match(client, /PREVIEW_CLIENT_TIMEOUT_MS = 620_000/);
});

test('official storage reference covers pages-blob', async () => {
  const skill = await readFile(path.join(
    skillsRoot,
    'edgeone-makers-tools',
    'references',
    'makers-storage',
    'SKILL.md',
  ), 'utf8');
  assert.match(skill, /@edgeone\/pages-blob/);
});

test('official makers-agents reference covers the agent contract', async () => {
  const skill = await readFile(path.join(
    skillsRoot,
    'edgeone-makers-tools',
    'references',
    'makers-agents',
    'SKILL.md',
  ), 'utf8');
  assert.match(skill, /export async function onRequest/);
  assert.match(skill, /makers-conversation-id/);
  assert.match(skill, /context\.request\.body/);
  assert.match(skill, /AI_GATEWAY_MODEL/);
});
