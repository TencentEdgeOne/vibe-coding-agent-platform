import { runFileReadPipeline } from './_lib/project/read.ts';

export async function onRequest(context: any) {
  return runFileReadPipeline(context);
}
