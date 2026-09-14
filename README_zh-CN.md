# Vibe Coding 平台模板

[Vibe Coding 平台模板](https://github.com/TencentEdgeOne/vibe-coding-agent-platform) 深度集成平台 Skills 能力，适用于根据自然语言快速生成 SSR、ISR 、动态接口等全栈 Web 应用及 AI Agent。开发者可基于该模板快速构建支持多租户隔离、多框架适配和边缘一键部署的 Vibe Coding 平台。

## 快速开始

1. 创建并获取 [API Token](https://write.woa.com/document/177158578199498752)。

2. 使用下面的示例模板直接开始部署。

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
                可嵌入任何网站的 AI 助手。一行代码添加聊天 Widget，自动理解页面内容，通过 Function Calling 实时查询你的后端 API。支持自定义 API Schema、推荐问题、流式响应,...
            </p>
        </div>
    </a>

3. 在部署配置页面，填写`API_TOKEN`环境变量。

4. 点击部署，等待 Makers 完成构建并生成访问地址。

## 模板核心能力

### Makers Skills 集成

- 模板在 `.claude/skills/` 内置 [Makers Skills](https://write.woa.com/document/205349902137049088)，为 Agent 提供框架约定、平台 API、目录规范和部署要求。

- Agent 根据任务使用对应 Skill，生成项目先通过 Makers 兼容性检查，框架适配器是否就位、平台声明文件是否完整、目录结构是否合规；失败时自动尝试一轮修复。

- 可通过执行 `npm run sync:skills` 更新平台最新 Skills，会替换 `.claude/skills/`目录。

### 启动预览

在沙箱内调用 EdgeOne CLI 启动项目预览。

```typescript
export function buildMakersDevLaunchCommand(port: number, projectName: string) {
  return `edgeone makers dev --port ${port} --skip-env-sync --name ${shellQuote(projectName)}`;
}
```

### 执行部署

在沙箱内调用 EdgeOne CLI 进行代码部署。

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

### 代码持久化

**保存工作区代码**

在每轮代码修改完成后调用 `persist()`：

```ts
try {
  const persist = await context.sandbox.persist({path: projectPath});//path 为项目目录
} catch (error) {
  // 保存失败不影响当前沙箱继续工作，可记录日志并稍后重试
  console.warn('Failed to save workspace:', error);
}
```

**恢复工作区代码**

新沙箱创建后，Agent 开始读写项目文件前调用 `restore()`：

```ts
const result = await context.sandbox.restore({path: projectPath});
```

**注意**：如果 `restore()` 返回 `failed`，本轮不要再调用 `persist()`，否则可能用不完整的工作区覆盖上一次可用快照。

## 本地调试和部署

### 启动本地开发调试

1. 进入项目根目录，安装 [EdgeOne CLI](https://write.woa.com/document/162228053883678720)：

   ```bash
   npm install -g edgeone
   ```

2. 执行登录，并关联前面使用模板部署的 Makers 项目：

   ```bash
   edgeone login
   edgeone makers link
   ```

   关联项目后会把控制台配置的 `API_TOKEN` 和调用 Models 所需的 API Key 自动同步到本地。

3. 启动 Makers 本地开发环境：

   ```bash
   edgeone makers dev
   ```

   启动成功后访问：

- Agent 应用：http://localhost:8088/

- 可观测链路追踪：http://localhost:8088/agent-metrics

### 部署项目

如果项目已关联 Git 仓库，推送代码即可触发 Makers 的 CI 构建与部署。也可以通过 CLI 直接部署：

```bash
# 部署至生产环境
edgeone makers deploy -n <项目名>
```

部署成功后点击 Console 的链接可以访问具体构建信息和部署后的 URL。
