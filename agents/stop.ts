import type { AgentContext } from './_lib/runtime/context.ts';
import { abortLiveChatTask, markChatTaskStopped } from './_lib/session/task.ts';
import { activateSandbox, sandboxWasActivated } from './_lib/lazy/sandbox.ts';
import { persistProjectSnapshot } from './_lib/turn/checkpoint.ts';
import { markCreated, persistWorkspace } from './_lib/project/workspace-store.ts';
import { getRequestBody } from './_lib/runtime/request.ts';

export async function onRequest(context: AgentContext) {
  const body = getRequestBody(context);
  const conversationId = String(body.conversation_id || '').trim();
  if (!conversationId) {
    return new Response(JSON.stringify({ ok: false, error: 'missing conversation_id' }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  try {
    const discardProject = body.discardProject === true;
    abortLiveChatTask(conversationId);
    await markChatTaskStopped(context, conversationId);
    const result = await context.utils?.abortActiveRun?.(conversationId);
    let persisted: boolean | undefined;
    if (!discardProject && sandboxWasActivated(conversationId)) {
      try {
        const { state } = await activateSandbox(context, conversationId);
        const saved = await persistProjectSnapshot(context, conversationId, state);
        persisted = saved;
        if (saved && !state.created) {
          markCreated(state);
          await persistWorkspace(context, conversationId, state);
        }
      } catch (error) {
        console.warn('[stop] project snapshot failed', error);
      }
    }
    return new Response(JSON.stringify({
      ok: true,
      conversation_id: conversationId,
      aborted: result?.aborted === true,
      ...(persisted !== undefined ? { persisted } : {}),
    }), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  } catch (error) {
    return new Response(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to stop the active run.',
    }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
}
