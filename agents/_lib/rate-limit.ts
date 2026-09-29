import type { AgentContext } from './runtime/context.ts';

/**
 * Shared geo-daily counter for the hosted demo. A city and ISP share one
 * bucket, and the counter resets by date on the far side.
 *
 * The counter endpoint is not part of this repository. Set `RATE_LIMIT_URL`
 * on the hosted project only. A user's own deployment leaves it unset and
 * never calls the counter.
 */
const RATE_LIMIT_URL_ENV = 'RATE_LIMIT_URL';
const RATE_LIMIT_KEY = 'vibe-coding-platform';
const DAILY_PROMPT_LIMIT = 20;

type GeoRecord = Record<string, unknown>;

export type PromptQuota =
  | { allowed: true }
  | { allowed: false; error: string };

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

export function readRequestGeo(request: AgentContext['request']): GeoRecord | null {
  const eo = request && typeof request === 'object' ? (request as { eo?: unknown }).eo : undefined;
  if (!eo || typeof eo !== 'object') return null;
  const geo = (eo as { geo?: unknown }).geo;
  if (!geo || typeof geo !== 'object' || Array.isArray(geo)) return null;
  const record = geo as GeoRecord;
  if (Object.keys(record).length === 0) return null;
  return record;
}

function quotaMessage(language: string | undefined, current: number, limit: number) {
  const used = `${current}/${limit}`;
  if (language === 'zh') {
    return `今日体验额度已用完（${used}）。请明天再试，或部署一份自己的项目使用独立额度。`;
  }
  return `Today's trial quota has been used up (${used}). Try again tomorrow, or deploy your own project for a separate quota.`;
}

function rateLimitUrl(context: AgentContext): string {
  const value = context.env?.[RATE_LIMIT_URL_ENV];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Counts one prompt against the caller's geo. Every geo is counted the same
 * way. No endpoint configured, no geo, or a failed check allows the prompt:
 * a user's own deployment and a dead counter both leave the demo usable.
 */
export async function consumePromptQuota(
  context: AgentContext,
  language?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PromptQuota> {
  const endpoint = rateLimitUrl(context);
  const geo = readRequestGeo(context.request);
  if (!endpoint || !geo) return { allowed: true };

  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: RATE_LIMIT_KEY,
        limit: DAILY_PROMPT_LIMIT,
        geo: JSON.stringify(geo),
      }),
    });
    if (!response.ok) return { allowed: true };
    const result = await response.json() as { allowed?: unknown; current?: unknown; limit?: unknown };
    if (result.allowed !== false) return { allowed: true };
    const limit = asNumber(result.limit) ?? DAILY_PROMPT_LIMIT;
    const current = asNumber(result.current) ?? limit;
    return { allowed: false, error: quotaMessage(language, current, limit) };
  } catch (error) {
    console.warn('[rate-limit] check failed', error instanceof Error ? error.message : error);
    return { allowed: true };
  }
}
