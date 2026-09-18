import type { AgentContext } from './_lib/runtime/context.ts';
import { createChatTaskAndStreamResponse } from './_lib/session/task.ts';
import { getRequestBody } from './_lib/runtime/request.ts';

/** Publish the current project. Deterministic — does not call the model. */
export async function onRequestPost(context: AgentContext) {
  const body = getRequestBody(context);
  try {
    const apiKey = String(body.apiKey || '').trim();
    return await createChatTaskAndStreamResponse(context, String(body.message || '').trim(), {
      kind: 'deploy',
      turnId: String(body.turnId || '').trim() || undefined,
      language: String(body.language || '').trim() || undefined,
      ...(apiKey ? { apiKey } : {}),
      ...(body.gatewaySkip === true ? { gatewaySkip: true } : {}),
    });
  } catch (error) {
    return new Response(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to start the deploy task.',
    }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
}
