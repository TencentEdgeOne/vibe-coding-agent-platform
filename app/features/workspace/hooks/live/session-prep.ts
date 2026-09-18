import type { SessionPrepStage, SessionStreamEvent } from '@/app/types/workspace';
import { consumeEventStream } from '../../sse';
import { openSessionStream } from '../../workspace-api';
import type { Locale } from '@/app/i18n';

export async function runCreateSessionPrep(options: {
  conversationId: string;
  signal: AbortSignal;
  model: string;
  language: Locale;
  setPrepStage: (stage: SessionPrepStage | null) => void;
  onReady: () => void;
}) {
  try {
    const resumeResponse = await openSessionStream(
      options.conversationId,
      options.signal,
      {
        model: options.model,
        language: options.language,
        mode: 'create',
      },
    );
    const resumeType = resumeResponse.headers.get('content-type') || '';
    if (
      resumeResponse.ok
      && resumeResponse.body
      && resumeType.includes('text/event-stream')
    ) {
      await consumeEventStream<SessionStreamEvent>(resumeResponse, (event) => {
        if (event.type !== 'session_prep' || !event.data?.stage) return;
        if (event.data.stage === 'ready') {
          options.setPrepStage(null);
          options.onReady();
          return;
        }
        if (event.data.status === 'running') {
          options.setPrepStage(event.data.stage);
        }
      });
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
  }
}
