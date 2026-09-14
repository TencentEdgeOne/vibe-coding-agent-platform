# Vibe Coding Platform

[Vibe Coding Platform](https://github.com/TencentEdgeOne/vibe-coding-agent-platform) deeply integrates platform Skills. Use it to generate full-stack web apps and AI Agents from natural language — including SSR, ISR, and dynamic APIs. Developers can build a Vibe Coding platform with multi-tenant isolation, multi-framework adaptation, and one-click edge deploy.

## Quick start

1. Create an [API Token](https://write.woa.com/document/177158578199498752).

2. Start from the example template below.

   [![Deploy to EdgeOne Makers](https://cdnstatic.tencentcs.com/edgeone/pages/deploy.svg)](https://edgeone.ai/makers/new?template=vibe-coding-agent-platform&from=within&fromAgent=1&agentLang=typescript)

3. On the deploy configuration page, set the `API_TOKEN` environment variable.

4. Click deploy and wait for Makers to finish the build and return a URL.

## Core capabilities

### Makers Skills

- The template vendors [Makers Skills](https://write.woa.com/document/205349902137049088) under `.claude/skills/`, so the agent has framework conventions, platform APIs, directory rules, and deploy requirements.

- The agent loads the Skill that matches the task. Generated projects go through a Makers compatibility check first: adapters in place, platform manifest complete, directory layout valid. On failure it attempts one automatic repair pass.

- Run `npm run sync:skills` to refresh Skills from the platform. This replaces `.claude/skills/`.

### Live preview

Preview starts inside the sandbox through the EdgeOne CLI.

```typescript
export function buildMakersDevLaunchCommand(port: number, projectName: string) {
  return `edgeone makers dev --port ${port} --skip-env-sync --name ${shellQuote(projectName)}`;
}
```

### Deploy

Deploy also runs the EdgeOne CLI inside the sandbox.

```typescript
function makersDeployLaunch(projectName: string, requestedCommand: string, area = 'global') {
  const previewEnvironment = /(?:^|\s)(?:-e|--environment)(?:\s+|=)preview(?:\s|$)/i
    .test(requestedCommand);
  return [
    'edgeone makers deploy',
    `-n ${shellQuote(projectName)}`,
    '--json',
    `--area ${area}`,
    previewEnvironment ? '-e preview' : '',
  ].filter(Boolean).join(' ');
}
```

### Workspace persistence

**Save the workspace**

Call `persist()` after each round of code changes:

```ts
try {
  const persist = await context.sandbox.persist({path: projectPath});//path is the project directory
} catch (error) {
  // A failed save does not stop the current sandbox. Log it and retry later.
  console.warn('Failed to save workspace:', error);
}
```

**Restore the workspace**

After a new sandbox is created, call `restore()` before the agent reads or writes project files:

```ts
const result = await context.sandbox.restore({path: projectPath});
```

**Note:** If `restore()` returns `failed`, do not call `persist()` in that turn. Doing so can overwrite the last good snapshot with an incomplete workspace.

## Local debug and deploy

### Start local development

1. From the project root, install the [EdgeOne CLI](https://write.woa.com/document/162228053883678720):

   ```bash
   npm install -g edgeone
   ```

2. Sign in and link the Makers project you deployed from this template:

   ```bash
   edgeone login
   edgeone makers link
   ```

   Linking syncs the console `API_TOKEN` and the Models API key to your local environment.

3. Start the Makers local development environment:

   ```bash
   edgeone makers dev
   ```

   After it starts, open:

- Agent app: http://localhost:8088/

- Observability traces: http://localhost:8088/agent-metrics

### Deploy the project

If the project is connected to a Git repository, pushing code triggers a Makers CI build and deploy. You can also deploy with the CLI:

```bash
# Deploy to production
edgeone makers deploy -n <project-name>
```

After a successful deploy, use the Console link to open the build details and the live URL.
