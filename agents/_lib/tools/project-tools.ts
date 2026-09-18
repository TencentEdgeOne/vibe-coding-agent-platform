import { requireSandbox, type AgentContext } from '../runtime/context.ts';
import { tool as defineClaudeTool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { markCreated } from '../project/workspace-store.ts';
import { buildNpmWarmupCommand } from '../makers/npm-install.ts';
import {
  ensureMakersAgentDeclarations,
  ensureMakersFrameworkAdapter,
} from '../makers/declarations.ts';
import type { ClaudeMcpTool, ProjectState } from '../types.ts';
import { getBlockedProjectWriteReason, toAppRelPath } from '../utils/paths.ts';
import { stringifyToolResult } from '../utils/text.ts';

const writeProjectFileInputSchema = {
  path: z.string().describe(
    'Path relative to the project appDir only (e.g. package.json, src/App.tsx). Do not include the appDir prefix.',
  ),
  content: z.string().describe('Complete UTF-8 contents for that one file.'),
};

export function buildWriteProjectFileTool(
  context: AgentContext,
  state: ProjectState,
  // The content is handed back so the pipeline can push it straight to the
  // frontend, which then renders the file without a /file round trip.
  onResult?: (result: { written: string; content: string }) => void | Promise<void>,
) {
  return defineClaudeTool(
    'write_project_file',
    'Create or replace exactly one complete UTF-8 project file under appDir. Up to four calls may be issued together for files that do not depend on each other. Keep files modular and reasonably small — prefer multiple focused files over one giant HTML/JS blob so each write finishes faster for the user. Path must be relative to appDir itself (package.json, src/App.tsx) — never prefix with the appDir path.',
    writeProjectFileInputSchema,
    async (input) => {
      try {
        const file = input as { path?: unknown; content?: unknown };
        if (typeof file.path !== 'string' || typeof file.content !== 'string') {
          throw new Error('Call write_project_file with {"path":"src/App.tsx","content":"complete file contents"}.');
        }
        const relPath = toAppRelPath(file.path, state.appDir);
        if (!relPath) {
          throw new Error(
            `Invalid file path: ${file.path}. Use a path relative to ${state.appDir} (example: src/App.tsx), not ${state.appDir}/src/App.tsx.`,
          );
        }
        const blockedReason = getBlockedProjectWriteReason(relPath);
        if (blockedReason) {
          throw new Error(`Refusing to write ${relPath}: ${blockedReason}`);
        }

        const parent = relPath.split('/').slice(0, -1).join('/');
        if (parent) {
          await requireSandbox(context).files.makeDir(`${state.appDir}/${parent}`);
        }
        await requireSandbox(context).files.write(`${state.appDir}/${relPath}`, file.content);
        markCreated(state);
        await onResult?.({ written: relPath, content: file.content });
        // An agents/ project needs agents.framework and .env.example declared,
        // and meeting that at the preview gate instead costs the user a failed
        // attempt. Values for those keys are collected in a later user turn,
        // not written here. Best effort: the lint remains the authority, so a
        // failure here costs the old behaviour and nothing more.
        let adapterAdded = false;
        const declared = relPath.startsWith('agents/')
          ? await ensureMakersAgentDeclarations(context, state).catch(() => [])
          : [];
        // The dependencies are known the moment this file lands, and the
        // install needs nothing else in the project to exist. Starting it now
        // overlaps it with the files still being written instead of leaving
        // that stretch on the floor. Silent and best-effort: the model is not
        // told, it just finds its own install already done.
        if (relPath === 'package.json') {
          // Ordered ahead of the install rather than beside it: a framework
          // that cannot build without its platform adapter needs that package
          // in this install, not in a second one after the lint asks for it.
          const adapter = await ensureMakersFrameworkAdapter(context, state, file.content)
            .catch(() => undefined);
          if (adapter) {
            declared.push(adapter);
            adapterAdded = true;
          }
          await requireSandbox(context).commands
            .run(buildNpmWarmupCommand(), { cwd: state.appDir })
            .catch(() => undefined);
        }
        for (const declaration of declared) {
          await onResult?.({ written: declaration.path, content: declaration.content });
        }
        return {
          content: [{
            type: 'text' as const,
            text: stringifyToolResult({
              written: relPath,
              ...(declared.length > 0 ? {
                alsoWritten: declared.map((declaration) => declaration.path),
                note: adapterAdded
                  ? 'Platform declarations written for you, including the platform adapter this framework cannot build without — it is in dependencies and the install already has it. Wiring it into the framework config is still yours to do; makers-frameworks says where it goes. Edit a value that is wrong; do not write these files again from scratch.'
                  : 'Platform declarations an agents/ project requires, written for you. Edit a value that is wrong; do not write these files again from scratch.',
              } : {}),
            }),
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: message }],
          isError: true,
        };
      }
    },
  ) as ClaudeMcpTool;
}
