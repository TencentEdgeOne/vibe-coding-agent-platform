/**
 * One home for the budgets. The preview budget has to leave room for the
 * install and the dev server boot that happen inside it.
 */
export const READINESS_BUDGET_MS = {
  /** A `find` against a sandbox that is up. Not a restore. */
  probe: 15_000,
  /** Pulling the Blob archive down and unpacking it. */
  restore: 45_000,
  /** npm install on a cold workspace. */
  dependencies: 300_000,
  /** Install plus dev server boot plus the route gates, worst case. */
  preview: 540_000,
  /** Everything a cold resume does before the panel has files and a preview. */
  workspace: 600_000,
} as const;

export const SANDBOX_EXTENSION_SECONDS = 1800;
