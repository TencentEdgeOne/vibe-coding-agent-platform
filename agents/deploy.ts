import { createChatTaskAndStreamResponse } from './_lib/session/task.ts';

/** Publish the current project. Deterministic — does not call the model. */
export async function onRequestPost(context: any) {
  const body = context?.request?.body || {};
  try {
    const apiKey = String(body?.apiKey || '').trim();
    return await createChatTaskAndStreamResponse(context, String(body?.message || '').trim(), {
      kind: 'deploy',
      turnId: String(body?.turnId || '').trim() || undefined,
      siteDomain: String(body?.siteDomain || '').trim() || undefined,
      ...(apiKey ? { apiKey } : {}),
      ...(body?.gatewaySkip === true ? { gatewaySkip: true } : {}),
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
