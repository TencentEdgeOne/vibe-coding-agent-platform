import { saveModelPreference } from './_lib/session/store.ts';
import { setLiveQueryModel } from './_lib/session/live.ts';
import { resolveRequestedModel } from './_lib/models.ts';
import { resolveConversationId } from './_lib/runtime/request.ts';

/** Persist the conversation's model preference, and hot-swap a live Query when one exists. */
export async function onRequestPost(context: any) {
  const { conversationId } = resolveConversationId(context);
  if (!conversationId) {
    return new Response(JSON.stringify({ ok: false, error: 'missing conversation_id' }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  const body = context?.request?.body || {};
  const model = resolveRequestedModel(context, body?.model);
  try {
    await saveModelPreference(context, conversationId, model);
    let applied = false;
    if (model) {
      applied = await setLiveQueryModel(conversationId, model);
    }
    return new Response(JSON.stringify({
      ok: true,
      conversation_id: conversationId,
      model,
      applied,
    }), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  } catch (error) {
    return new Response(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to update the session model.',
    }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
}
