import { createHash } from 'node:crypto';
import { ConflictError, Makers } from '@edgeone/makers-sdk';
import type { ProjectState } from '../_types.ts';
import { resolveMakersPublishTarget } from '../../shared/publish-target.ts';

// One project per conversation, for preview and deployment alike.
//
// Both CLI commands resolve a project by name and create it when the lookup
// misses, so the name decides which project the conversation owns. A name
// shared by every conversation cannot work: a tenant token only sees projects
// its own tenant created, so the lookup misses a project another tenant
// already holds, the create then collides with the existing name, and preview
// dies on "Failed to create pages project" before it starts. Deploy has the
// same shape with a worse ending — it would publish over someone else's live
// site.
//
// Being a pure function of the session directory, the name needs no storage:
// every turn of the same conversation resolves to the same project.
const PROJECT_NAME_PREFIX = 'vibe-coding';

function pickEnvValue(context: any, key: string) {
  const value = context?.env?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveMakersProjectName(context: any, state: ProjectState) {
  // An explicit name is an operator decision: honour it exactly, including the
  // consequence that every conversation then shares the one project.
  const pinned = pickEnvValue(context, 'MAKERS_DEPLOY_PROJECT_NAME');
  if (pinned) {
    return pinned;
  }

  // Hashed rather than embedded: the conversation ID ends up in a public
  // hostname once the project is deployed.
  const digest = createHash('sha256').update(state.sessionDir).digest('hex').slice(0, 10);
  return `${PROJECT_NAME_PREFIX}-${digest}`;
}

export function resolveConversationPublishArea(state: ProjectState) {
  return resolveMakersPublishTarget(state.siteDomain || '').area;
}

export type MakersPublishProjectClient = {
  projects: {
    list(options: { name: string; pageSize?: number }): Promise<{ items: Array<{ name: string }> }>;
    create(input: { name: string; area?: string }): Promise<unknown>;
  };
};

/**
 * Create the conversation's Makers project with the right acceleration area
 * before `makers dev` runs. The sandbox CLI's auto-link still hardcodes
 * Area=global, and `--area` on `makers dev` is ignored by CLIs that predate
 * that flag — so leaving creation to the CLI is how a .dev site still ships
 * a global project.
 */
export async function ensureMakersPublishProject(
  token: string,
  projectName: string,
  area: string,
  region?: ProjectState['makersApiRegion'],
  client?: MakersPublishProjectClient,
) {
  if (!token || !projectName) return;

  const publishArea = area === 'overseas' ? 'overseas' : 'global';
  const projects = (client ?? new Makers({
    token,
    ...(region === 'china' || region === 'global' ? { region } : {}),
  })).projects;

  try {
    const listed = await projects.list({ name: projectName, pageSize: 10 });
    if (listed.items.some((project) => project.name === projectName)) {
      return;
    }
  } catch {
    // Create below is what pins the area. A list failure must not skip it:
    // ConflictError is how a project that existed all along is recognised.
  }

  try {
    await projects.create({ name: projectName, area: publishArea });
  } catch (error) {
    if (error instanceof ConflictError) return;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create the Makers project before preview. ${detail}`);
  }
}
