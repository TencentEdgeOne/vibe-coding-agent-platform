import type { AgentContext } from './_lib/runtime/context.ts';
import { createChatTaskAndStreamResponse } from './_lib/session/task.ts';
import { resolveRequestedModel } from './_lib/models.ts';
import { getRequestBody } from './_lib/runtime/request.ts';

/** Submit a user message. Generation streams back as SSE. */
export async function onRequestPost(context: AgentContext) {
  const body = getRequestBody(context);
  const message = String(body.message || '').trim();
  if (!message) {
    return new Response(JSON.stringify({
      ok: false,
      error: 'Please describe the page or feature you want to build first.',
    }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  try {
    const apiKey = String(body.apiKey || '').trim();
    return await createChatTaskAndStreamResponse(context, message, {
      kind: 'prompt',
      turnId: String(body.turnId || '').trim() || undefined,
      model: resolveRequestedModel(context, body.model),
      language: String(body.language || '').trim() || undefined,
      ...(apiKey ? { apiKey } : {}),
      ...(body.gatewaySkip === true ? { gatewaySkip: true } : {}),
    });
  } catch (error) {
    return new Response(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to start the chat task.',
    }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
}
