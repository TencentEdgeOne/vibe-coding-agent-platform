import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildPreviewProxyScript,
} from '../agents/_lib/makers/cli-dev.ts';
import { formatPreviewProgress } from '../agents/_lib/project/preview.ts';
import { previewDisplayPathFromPath } from '../shared/preview-display-path.ts';
import { readCommandsWrapSource } from './helpers/fixtures.ts';
import { LIVE_TURN, PREVIEW_SURFACE, WORKSPACE, surface } from './helpers/source.ts';

test('a preview that is still starting shows the stage and then the server log', () => {
  assert.equal(formatPreviewProgress('Starting the preview server'), 'Starting the preview server');
  assert.equal(
    formatPreviewProgress('Starting the preview server', 'Running at: http://localhost:8088\n'),
    'Starting the preview server\n\nRunning at: http://localhost:8088',
  );
});

test('start_preview paints the dev server log on its own row while it boots', async () => {
  const [tool, preview, live, deployTool] = await Promise.all([
    readFile('agents/_lib/tools/preview-tools.ts', 'utf8'),
    readFile('agents/_lib/project/preview.ts', 'utf8'),
    readFile('agents/_lib/session/live.ts', 'utf8'),
    readFile('agents/_lib/tools/deploy-tools.ts', 'utf8'),
  ]);
  assert.match(tool, /onProgress: report/);
  assert.match(preview, /followSandboxLog\(context, MAKERS_DEV_LOG_PATH/);
  assert.match(preview, /Installing dependencies|Starting the preview server/);
  assert.match(live, /keepPaintedLog/);
  assert.match(deployTool, /onProgress:/);
});

test('preview address bar shows the application route without the gateway prefix', async () => {
  const screen = await surface(WORKSPACE);

  // The address chip renders the mirrored route (previewDisplayPath) rather than
  // the raw shareablePreviewUrl host, so the sandbox domain is never shown.
  assert.match(screen, /previewDisplayPath/);
  assert.match(screen, /previewDisplayPathFromPath/);
  assert.doesNotMatch(
    screen,
    /shareablePreviewUrl\.replace/,
    'the address bar must not strip-and-display the sandbox host domain',
  );
});

test('preview address chip hides the gateway prefix and access_token', () => {
  assert.equal(previewDisplayPathFromPath(''), '/');
  assert.equal(previewDisplayPathFromPath('/preview/'), '/');
  assert.equal(
    previewDisplayPathFromPath('/preview/?access_token=sit_EopBYgXXf5X2fz2kx1gl0U5BEtTEzf240kR7BWuzCLQ'),
    '/',
  );
  assert.equal(
    previewDisplayPathFromPath('/?access_token=sit_secret'),
    '/',
  );
  assert.equal(
    previewDisplayPathFromPath('/preview/about?q=docs&access_token=sit_secret#intro'),
    '/about?q=docs#intro',
  );
  assert.equal(previewDisplayPathFromPath('/preview/blog/first-post'), '/blog/first-post');
});

// A listener is half a mirror. Asserting only that the parent subscribes let the
// sender go missing when the preview moved off Vite, and the address bar sat on
// the route the preview opened with for as long as the tests stayed green. So
// run the real proxy against a stub upstream and read what reaches the browser.
test('the preview proxy feeds the route mirror the parent listens for', async () => {
  const preview = await surface(PREVIEW_SURFACE);
  assert.match(preview, /__edgeonePreviewPath/);
  assert.match(preview, /addEventListener\('message'/);

  const upstream = http.createServer((req, res) => {
    if ((req.url || '').startsWith('/asset.js')) {
      res.writeHead(200, { 'content-type': 'application/javascript' }).end('console.log(1)');
      return;
    }
    if ((req.url || '').startsWith('/streaming')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.write('<!DOCTYPE html><html><head><title>s</title></head><body><p>shell</p>');
      setTimeout(() => res.end('<p>late</p></body></html>'), STREAM_GAP_MS);
      return;
    }
    const body = '<!DOCTYPE html><html><head><title>t</title></head><body>home</body></html>';
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    }).end(body);
  });

  const upstreamPort = await listenOnFreePort(upstream);
  const listenPort = await reserveFreePort();
  const directory = await mkdtemp(join(tmpdir(), 'preview-proxy-'));
  const scriptPath = join(directory, 'proxy.cjs');
  await writeFile(scriptPath, buildPreviewProxyScript(listenPort, upstreamPort, '/preview'));
  const proxy = spawn(process.execPath, [scriptPath], { stdio: 'ignore' });

  try {
    const base = `http://127.0.0.1:${listenPort}`;
    await waitForServer(`${base}/preview/`);

    const home = await fetch(`${base}/preview/`, { headers: { accept: 'text/html' } });
    const html = await home.text();
    assert.match(html, /__edgeonePreviewPath/, 'the document must carry the tracker');
    // Ahead of <head> the script would precede the doctype and trip quirks mode.
    assert.match(html, /<head><script data-edgeone-preview-tracker>/);
    assert.ok(html.startsWith('<!DOCTYPE html>'), 'the doctype must still lead');
    // The body grew, so a forwarded length would truncate the page.
    assert.equal(home.headers.get('content-length'), null);

    const asset = await fetch(`${base}/preview/asset.js`, { headers: { accept: '*/*' } });
    assert.equal(await asset.text(), 'console.log(1)', 'only HTML may be rewritten');

    // Buffering to find <head> must not swallow a body that arrives in pieces:
    // a page streaming from a Suspense boundary has to reach the browser as one.
    const streamed = await fetch(`${base}/preview/streaming`, { headers: { accept: 'text/html' } });
    assert.ok(streamed.body, 'the streamed response must carry a body');
    const reader = streamed.body.getReader();
    const arrivals: Array<{ at: number; text: string }> = [];
    const startedAt = Date.now();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arrivals.push({ at: Date.now() - startedAt, text: Buffer.from(value).toString() });
    }
    const shell = arrivals.find((arrival) => arrival.text.includes('shell'));
    const late = arrivals.find((arrival) => arrival.text.includes('late'));
    assert.ok(shell && late, 'both halves of the streamed page must arrive');
    assert.ok(
      late.at - shell.at > STREAM_GAP_MS / 2,
      `the shell was held back until the late chunk (shell ${shell.at}ms, late ${late.at}ms)`,
    );
    assert.match(arrivals.map((arrival) => arrival.text).join(''), /__edgeonePreviewPath/);
  } finally {
    proxy.kill();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

const STREAM_GAP_MS = 150;

function listenOnFreePort(server: http.Server) {
  return new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

// The proxy binds the port itself, so hand it one nothing else is holding.
function reserveFreePort() {
  return new Promise<number>((resolve) => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForServer(url: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fetch(url, { headers: { accept: 'text/html' } });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`preview proxy never came up at ${url}`);
}

test('sandbox preview strips the public prefix before forwarding to makers-dev', async () => {
  const preview = await readFile('agents/_lib/project/preview.ts', 'utf8');
  const makersDev = await readFile('agents/_lib/makers/cli-dev.ts', 'utf8');
  const proxySource = await readFile('agents/_lib/makers/preview-proxy-source.ts', 'utf8');
  assert.match(preview, /makers-dev/);
  assert.match(preview, /buildMakersDevLaunchCommand/);
  assert.match(preview, /assertMakersProjectCompatible/);
  assert.match(preview, /getHost\?\.\(PREVIEW_PUBLIC_PORT\)/);
  assert.match(makersDev, /edgeone makers dev/);
  assert.match(makersDev, /skip-env-sync/);
  assert.match(makersDev, /skip-ai-gateway-sync/);
  assert.match(makersDev, /buildPreviewProxyScript/);
  assert.match(proxySource, /server\.on\('upgrade'/);
  assert.match(preview, /PREVIEW_PATH_PREFIX/);
  assert.doesNotMatch(preview, /python3 -m http\.server/);
});

// The preview's contract is: start the dev server and hand back a URL. Route
// probing used to live here, and a slow boot or a broken route then surfaced to
// the user as "no preview at all". Verification is the agent's job now, against
// the local URL the tool returns.
test('preview publishes without probing generated routes', async () => {
  const [preview, readiness, previewTool, prompt] = await Promise.all([
    readFile('agents/_lib/project/preview.ts', 'utf8'),
    readFile('agents/_lib/lazy/preview.ts', 'utf8'),
    readFile('agents/_lib/tools/preview-tools.ts', 'utf8'),
    readFile('agents/_lib/prompt.ts', 'utf8'),
  ]);

  // No probe script, no route listing, no restart driven by a probe verdict.
  for (const source of [preview, readiness]) {
    assert.doesNotMatch(source, /assertGeneratedRoutesReady/);
    assert.doesNotMatch(source, /buildGenerated(Chat|Api)SmokeScript/);
    assert.doesNotMatch(source, /verifyRoutes/);
    assert.doesNotMatch(source, /previewFailureWarrantsRestart/);
  }
  assert.doesNotMatch(preview, /makersFileSemantic|CLOUD_FUNCTION_DIRECTORIES/);
  assert.doesNotMatch(preview, /smoke/i);

  // The tool hands the model the address it can actually request.
  assert.match(previewTool, /local_url/);
  assert.match(previewTool, /PREVIEW_SERVER_PORT/);
  assert.match(prompt, /verify the parts you changed yourself from inside the sandbox/);
});

// Healthy previews are still reused, and that reuse must stay a fast path: no
// probe, no model call, just the same URL minted again.
test('healthy makers-dev previews are reused on follow-up turns', async () => {
  const preview = await readFile('agents/_lib/project/preview.ts', 'utf8');
  const warmBranch = preview.match(/if \(warm\.exitCode === 0\) \{[\s\S]*?\n  \}/)?.[0] || '';

  assert.ok(warmBranch, 'the warm-probe branch must stay');
  // `false`: a reused process is still serving the page the client already has,
  // so the iframe must not be remounted for it.
  assert.match(warmBranch, /return previewServerInfo\(launchCommand, false\)/);
  assert.doesNotMatch(warmBranch, /assertGeneratedRoutesReady/);
  assert.match(preview, /forceRestart/);
});

test('the host does no preview work after the coding agent returns', async () => {
  const [chat, snapshot, live, apply, assemble, resume, preview, prompt] = await Promise.all([
    readFile('agents/_lib/turn/chat.ts', 'utf8'),
    readFile('agents/_lib/project/snapshot.ts', 'utf8'),
    surface(LIVE_TURN),
    surface('app/features/workspace/hooks/use-workspace-snapshot.ts'),
    readFile('agents/_lib/tools/assemble.ts', 'utf8'),
    readFile('agents/_lib/session/resume.ts', 'utf8'),
    surface(PREVIEW_SURFACE),
    readFile('agents/_lib/prompt.ts', 'utf8'),
  ]);

  // The model owns preview, verification, and fixing inside its turn. Once the
  // SDK result is back, the host answers and persists; it does not start work
  // that would leave the conversation reading "running" after the model stopped.
  assert.doesNotMatch(chat, /startHostPreview|ensurePreview\(/);
  assert.doesNotMatch(chat, /runVerification|runAutoFixTurn/);
  assert.doesNotMatch(chat, /setLastBuild|previewLinkFromState/);
  assert.doesNotMatch(chat, /createFileTreePushController|fileTreePush/);
  assert.match(chat, /const handlePreviewReady = async/);
  assert.match(chat, /await persistWorkspace\(context, conversationId, state\)/);
  assert.match(chat, /void checkpoint\.flush\(\)/);
  assert.doesNotMatch(assemble, /onWorkspaceReady/);
  const sessionOpen = resume.slice(resume.indexOf('export async function createProjectResumeStreamResponse'));
  assert.match(sessionOpen, /type: 'resume_history'/);
  assert.doesNotMatch(sessionOpen, /activateSandbox|ensurePreview|willRestorePreview|iterateWorkspaceResumeEvents/);
  assert.match(resume, /iterateLiveChatTaskEvents/);
  assert.doesNotMatch(resume, /&& hadPreview/);
  assert.match(preview, /revision === undefined \|\| nextPreview\.restarted/);
  assert.match(prompt, /keeps that dest server watching files/);
  assert.match(snapshot, /\.\.\.\(preview\.url \? \{ preview \} : \{\}\)/);
  assert.match(apply, /if \(data\.preview\?\.url\) preview\.applyResumedPreview\(data\.preview\)/);
  assert.match(
    live,
    /if \(event\.type === 'file_changed' && event\.data\?\.paths\?\.length\) \{\s*\n\s*sawProjectActivity = true;/,
  );
});
