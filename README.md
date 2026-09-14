# Vibe Coding Platform

[Vibe Coding Platform](https://github.com/TencentEdgeOne/vibe-coding-agent-platform) deeply integrates platform Skills. Use it to generate full-stack web apps and AI Agents from natural language — including SSR, ISR, and dynamic APIs. Developers can build a Vibe Coding platform with multi-tenant isolation, multi-framework adaptation, and one-click edge deploy.

## Quick start

1. Create an [API Token](https://write.woa.com/document/177158578199498752).

2. Start from the example template below.

<style>
        /* 基础重置 */
        body, h2, p {
            margin: 0;
            padding: 0;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            box-sizing: border-box; /* 确保 padding 和 border 不会增加元素的总宽度和高度 */
        }
        body {
            background-color: #f0f2f5;
            display: flex;
            justify-content: center;
            align-items: center; /* 垂直居中 */
            min-height: 100vh; /* 确保 body 至少和视口一样高 */
            padding: 20px;
        }

        .card {
            display: block; /* 使 a 标签表现为块级元素 */
            width: 100%;
            max-width: 280px; /* 最大宽度保持 280px */
            height: 270px; /* 固定卡片总高度 */
            border-radius: 8px;
            overflow: hidden;
            box-shadow: 0 4px 8px rgba(0,0,0,0.1);
            background-color: #ffffff;
            border: 1px solid #e1e4e8; /* 默认边框 */
            transition: border-color 0.2s ease-in-out, box-shadow 0.2s ease-in-out; /* 添加过渡效果 */
            cursor: pointer; /* 提示可交互 */
            text-decoration: none; /* 移除链接的下划线 */
        }

        .card:hover {
            border-color: #0366d6; /* hover 时的边框颜色 */
            box-shadow: 0 4px 12px rgba(3, 102, 214, 0.2); /* hover 时的阴影效果 */
        }
        
        .card-image {
            width: 100%;
            height: 157px; 
            object-fit: cover; 
            display: block; 
        }
        
        .content-section {
            padding: 16px; 
            height: 113px; /* 固定内容区域高度 (270px - 157px) */
        }

        .content-section h2 {
            font-size: 16px; 
            color: #0d1117; 
            margin-bottom: 8px;
            
            /* -- 以下是单行文本截断的关键样式 -- */
            white-space: nowrap; /* 强制文本不换行 */
            overflow: hidden; /* 超出部分隐藏 */
            text-overflow: ellipsis; /* 超出部分显示省略号 */
        }

        .content-section p {
            color: #57606a; 
            line-height: 1.5;
            font-size: 13px; 
            
            /* -- 以下是多行文本截断的关键样式 -- */
            overflow: hidden; 
            text-overflow: ellipsis; 
            display: -webkit-box;
            -webkit-line-clamp: 2; /* 限制为最多显示 2 行 */
            -webkit-box-orient: vertical;
        }
    </style>

    <a href="https://edgeone.ai/makers/new?template=ai-assistant&amp;from=within&amp;fromAgent=1&amp;agentLang=typescript" class="card" target="_blank">
        <img class="card-image" src="https://cdnstatic.tencentcs.com/edgeone/pages/assets/1781766068759-G7c5.png" />

        <div class="content-section">
            <h2>AI Assistant</h2>
            <p>
                An AI assistant you can embed on any website. Add a chat widget with one line of code. It understands the page and queries your backend APIs in real time through Function Calling. Supports custom API schemas, suggested questions, streaming responses, and more.
            </p>
        </div>
    </a>

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
