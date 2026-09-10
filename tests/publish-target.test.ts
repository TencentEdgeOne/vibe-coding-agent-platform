import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveMakersPublishTarget } from '../shared/publish-target.ts';

test('international .dev sites use the global endpoint and overseas area', () => {
  assert.deepEqual(resolveMakersPublishTarget('edgeone.dev'), {
    region: 'global',
    area: 'overseas',
  });
});

test('china .cool sites use the china endpoint and global area', () => {
  assert.deepEqual(resolveMakersPublishTarget('edgeone.cool'), {
    region: 'china',
    area: 'global',
  });
});

test('non-dev hosts default to the china endpoint', () => {
  assert.deepEqual(resolveMakersPublishTarget(''), {
    region: 'china',
    area: 'global',
  });
  assert.deepEqual(resolveMakersPublishTarget('localhost'), {
    region: 'china',
    area: 'global',
  });
});
