import type { AgentContext } from './_lib/runtime/context.ts';
import { runProjectResumePreviewPipeline } from './_lib/session/resume.ts';
import { runPreviewStatusPipeline } from './_lib/project/snapshot.ts';

/** Current preview URL without restarting the server. */
export async function onRequestGet(context: AgentContext) {
  return runPreviewStatusPipeline(context);
}

/** Re-mint the public preview URL without restoring the full workspace. */
export async function onRequestPost(context: AgentContext) {
  return runProjectResumePreviewPipeline(context);
}
