import { runProjectDownloadPipeline } from './_lib/pipelines/index.ts';

export async function onRequest(context: any) {
  return runProjectDownloadPipeline(context);
}
