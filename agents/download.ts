import { runProjectDownloadPipeline } from './_lib/project/download.ts';

export async function onRequest(context: any) {
  return runProjectDownloadPipeline(context);
}
