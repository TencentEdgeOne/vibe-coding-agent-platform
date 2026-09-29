import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentContext } from '../agents/_lib/runtime/context.ts';
import {
  consumePromptQuota,
  readRequestGeo,
} from '../agents/_lib/rate-limit.ts';

const SHENZHEN = {
  asn: 4816,
  countryName: 'China',
  countryCodeAlpha2: 'CN',
  countryCodeAlpha3: 'CHN',
  countryCodeNumeric: '156',
  regionName: 'Guangdong',
  regionCode: 'CN-GD',
  cityName: 'Shenzhen',
  continent: '',
  latitude: 22.555160522460938,
  longitude: 114.05387878417969,
  cisp: '中国电信',
};

const RATE_LIMIT_URL = 'https://rate-limit.example/check';

function contextWithGeo(
  geo: Record<string, unknown> | null,
  env: Record<string, string> = { RATE_LIMIT_URL },
): AgentContext {
  if (!geo) return { request: {}, env };
  return { request: { eo: { geo } }, env };
}

test('every geo, including Shenzhen Telecom, spends quota', async () => {
  let countedGeo = '';
  const result = await consumePromptQuota(contextWithGeo(SHENZHEN), 'zh', async (_input, init) => {
    countedGeo = JSON.parse(String(init?.body)).geo;
    return new Response(JSON.stringify({ allowed: true, current: 1, limit: 20 }), { status: 200 });
  });
  assert.equal(JSON.parse(countedGeo).cityName, 'Shenzhen');
  assert.equal(JSON.parse(countedGeo).cisp, '中国电信');
  assert.deepEqual(result, { allowed: true });
});

test('a geo over the daily limit is refused in the request language', async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(String(input), RATE_LIMIT_URL);
    const body = JSON.parse(String(init?.body)) as { key: string; limit: number; geo: string };
    assert.equal(body.key, 'vibe-coding-platform');
    assert.equal(body.limit, 20);
    assert.equal(JSON.parse(body.geo).cityName, 'San Jose');
    return new Response(JSON.stringify({ allowed: false, current: 20, limit: 20 }), { status: 200 });
  };
  const denied = await consumePromptQuota(
    contextWithGeo({ ...SHENZHEN, cityName: 'San Jose', regionName: 'California', asn: 1, cisp: 'Example' }),
    'en',
    fetchImpl,
  );
  assert.equal(denied.allowed, false);
  if (!denied.allowed) {
    assert.match(denied.error, /20\/20/);
    assert.match(denied.error, /trial quota/);
  }

  const deniedZh = await consumePromptQuota(
    contextWithGeo({ cityName: 'Chengdu', cisp: '中国电信', asn: 4134 }),
    'zh',
    async () => new Response(JSON.stringify({ allowed: false, current: 20, limit: 20 }), { status: 200 }),
  );
  assert.equal(deniedZh.allowed, false);
  if (!deniedZh.allowed) assert.match(deniedZh.error, /今日体验额度已用完/);
});

test('a passing check and a dead counter both allow the prompt', async () => {
  const allowed = await consumePromptQuota(
    contextWithGeo({ cityName: 'Tokyo', asn: 9 }),
    'en',
    async () => new Response(JSON.stringify({ allowed: true, current: 1, limit: 20 }), { status: 200 }),
  );
  assert.deepEqual(allowed, { allowed: true });

  const unavailable = await consumePromptQuota(
    contextWithGeo({ cityName: 'Tokyo', asn: 9 }),
    'en',
    async () => {
      throw new Error('network down');
    },
  );
  assert.deepEqual(unavailable, { allowed: true });
});

test('requests without edge geo or without a configured counter are not counted', async () => {
  assert.equal(readRequestGeo(undefined), null);
  assert.equal(readRequestGeo({ eo: { geo: {} } }), null);
  let called = false;
  const fetchImpl: typeof fetch = async () => {
    called = true;
    return new Response('no');
  };
  const missingGeo = await consumePromptQuota(contextWithGeo(null), 'en', fetchImpl);
  assert.equal(called, false);
  assert.deepEqual(missingGeo, { allowed: true });

  const unconfigured = await consumePromptQuota(
    contextWithGeo({ cityName: 'Tokyo', asn: 9 }, {}),
    'en',
    fetchImpl,
  );
  assert.equal(called, false);
  assert.deepEqual(unconfigured, { allowed: true });
});
