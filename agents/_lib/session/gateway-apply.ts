import type { AgentContext } from '../runtime/context.ts';
import { applyUserGatewayDecision } from '../project/gateway.ts';
import {
  isPreviewServerReady,
  publishRunningPreview,
  startPreviewServer,
} from '../project/preview.ts';
import { persistWorkspace } from '../project/workspace-store.ts';
import { prepareProjectWorkspace } from '../project/workspace.ts';
import { getConversationId } from './task.ts';
import { getLiveWorkspace } from './live-workspace.ts';
import type { ProjectState, StreamSend } from '../types.ts';

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function restartOrStartPreview(
  context: AgentContext,
  conversationId: string,
  state: ProjectState,
  send: StreamSend | undefined,
  options: { forceRestart: boolean },
) {
  await startPreviewServer(context, state, {
    verifyRoutes: false,
    forceRestart: options.forceRestart,
  });
  const preview = await publishRunningPreview(context, state, { routesAlreadyVerified: true });
  await persistWorkspace(context, conversationId, state);
  const payload = {
    ...preview,
    restarted: options.forceRestart,
  };
  send?.({
    type: 'preview_ready',
    data: {
      preview: payload,
      download: { url: '/download', filename: 'source.zip' },
    },
  });
  return payload;
}

/**
 * Write a Models API key or skip without opening a coding-agent turn.
 * A live generation keeps running; its SSE gets `gateway_credentials: resolved`.
 */
export async function applyGatewayDecisionAndRespond(
  context: AgentContext,
  decision: { apiKey?: string; skip?: boolean },
) {
  const conversationId = getConversationId(context);
  if (!conversationId) {
    return jsonResponse({
      ok: false,
      error: 'Missing conversationId. The project workspace cannot be prepared.',
    }, 400);
  }

  const apiKey = (decision.apiKey || '').trim();
  if (!decision.skip && !apiKey) {
    return jsonResponse({
      ok: false,
      error: 'Provide an API key or skip.',
    }, 400);
  }

  try {
    const live = getLiveWorkspace(conversationId);
    const send = live?.send;
    const state = live?.state ?? await prepareProjectWorkspace(context, conversationId, send);
    const values = await applyUserGatewayDecision(
      context,
      state,
      conversationId,
      {
        ...(apiKey ? { apiKey } : {}),
        ...(decision.skip ? { skip: true } : {}),
      },
      send,
    );

    let preview: Awaited<ReturnType<typeof restartOrStartPreview>> | undefined;
    const destRunning = Boolean(state.previewUrl) || await isPreviewServerReady(context).catch(() => false);
    try {
      if (live) {
        if (!decision.skip && destRunning) {
          preview = await restartOrStartPreview(context, conversationId, state, send, {
            forceRestart: true,
          });
        }
      } else if (state.created) {
        preview = await restartOrStartPreview(context, conversationId, state, send, {
          forceRestart: destRunning && !decision.skip,
        });
      }
    } catch (error) {
      console.warn(
        '[gateway] preview after apply failed',
        error instanceof Error ? error.message : error,
      );
    }

    return jsonResponse({
      ok: true,
      conversation_id: conversationId,
      applied: true,
      live: Boolean(live),
      skipped: Boolean(decision.skip),
      configured: Boolean(values.AI_GATEWAY_API_KEY),
      ...(preview ? {
        preview,
        download: { url: '/download', filename: 'source.zip' },
      } : {}),
    });
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to apply the API key.',
    }, 500);
  }
}
