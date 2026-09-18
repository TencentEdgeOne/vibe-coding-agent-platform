import type { ChatResponse } from '../../../shared/protocol.ts';
import type { StreamSend } from '../types.ts';

export function sendTurnResult(send: StreamSend, data: ChatResponse) {
  send({ type: 'result', data });
}
