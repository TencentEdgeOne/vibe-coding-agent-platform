import { resolveConversationId } from './utils/_request.ts';
import { submitGatewayDecision } from './project/_gateway-prompt.ts';

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/** Collect or skip AI Gateway values before preview/deploy writes a .env. */
export async function onRequestPost(context: any) {
  const body = context?.request?.body || {};
  const resolved = resolveConversationId(context);
  const conversationId = resolved.conversationId
    || String(body.conversation_id || '').trim();
  if (!conversationId) {
    return json({ ok: false, error: 'missing conversation_id' }, 400);
  }

  if (body.skip === true) {
    submitGatewayDecision(conversationId, { status: 'skipped' });
    return json({ ok: true, skipped: true, conversation_id: conversationId });
  }

  const apiKey = String(body.apiKey || '').trim();
  if (!apiKey) {
    submitGatewayDecision(conversationId, { status: 'skipped' });
    return json({ ok: true, skipped: true, conversation_id: conversationId });
  }

  submitGatewayDecision(conversationId, {
    status: 'provided',
    apiKey,
  });
  return json({ ok: true, skipped: false, conversation_id: conversationId });
}
