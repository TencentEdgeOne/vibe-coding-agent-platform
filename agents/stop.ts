import { abortLiveChatTask, markChatTaskStopped } from './_lib/session/task.ts';
import { getProjectState, saveProjectState } from './_lib/session/store.ts';
import { persistProjectSnapshot } from './_lib/turn/checkpoint.ts';

export async function onRequest(context: any) {
  const conversationId = String(context?.request?.body?.conversation_id || '').trim();
  if (!conversationId) {
    return new Response(JSON.stringify({ ok: false, error: 'missing conversation_id' }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  try {
    const discardProject = context?.request?.body?.discardProject === true;
    abortLiveChatTask(conversationId);
    await markChatTaskStopped(context, conversationId);
    const result = await context.utils?.abortActiveRun?.(conversationId);
    let persisted: boolean | undefined;
    if (!discardProject) {
      try {
        const state = await getProjectState(context, conversationId);
        const saved = await persistProjectSnapshot(context, conversationId, state);
        persisted = saved;
        if (saved && !state.created) {
          state.created = true;
          await saveProjectState(context, conversationId, state);
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
