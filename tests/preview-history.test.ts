import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EMPTY_PREVIEW_HISTORY,
  PREVIEW_HISTORY_LIMIT,
  previewHistoryBack,
  previewHistoryForward,
  previewHistoryReset,
  previewHistoryVisit,
} from '../shared/preview-history.ts';
import { readFile } from 'node:fs/promises';

test('a visit pushes the previous route onto the back stack', () => {
  let history = previewHistoryReset('/preview/');
  history = previewHistoryVisit(history, '/preview/about');
  history = previewHistoryVisit(history, '/preview/blog');

  assert.equal(history.current, '/preview/blog');
  assert.deepEqual(history.back, ['/preview/', '/preview/about']);
  assert.deepEqual(history.forward, []);
});

test('back and forward move routes between the two stacks', () => {
  let history = previewHistoryVisit(
    previewHistoryVisit(previewHistoryReset('/preview/'), '/preview/about'),
    '/preview/blog',
  );

  const back = previewHistoryBack(history);
  assert.ok(back);
  assert.equal(back.target, '/preview/about');
  history = back.state;
  assert.deepEqual(history.back, ['/preview/']);
  assert.deepEqual(history.forward, ['/preview/blog']);

  const forward = previewHistoryForward(history);
  assert.ok(forward);
  assert.equal(forward.target, '/preview/blog');
  assert.deepEqual(forward.state.back, ['/preview/', '/preview/about']);
  assert.deepEqual(forward.state.forward, []);
});

// A browser drops everything ahead of the current entry as soon as it visits a
// new route; keeping it would make Forward jump into an abandoned branch.
test('a new visit after going back drops the forward stack', () => {
  const back = previewHistoryBack(previewHistoryVisit(
    previewHistoryVisit(previewHistoryReset('/preview/'), '/preview/about'),
    '/preview/blog',
  ));
  assert.ok(back);

  const visited = previewHistoryVisit(back.state, '/preview/pricing');
  assert.equal(visited.current, '/preview/pricing');
  assert.deepEqual(visited.back, ['/preview/', '/preview/about']);
  assert.deepEqual(visited.forward, []);
});

test('there is nowhere to go at either edge', () => {
  assert.equal(previewHistoryBack(EMPTY_PREVIEW_HISTORY), null);
  assert.equal(previewHistoryForward(EMPTY_PREVIEW_HISTORY), null);
  assert.equal(previewHistoryBack(previewHistoryReset('/preview/')), null);
  assert.equal(previewHistoryForward(previewHistoryReset('/preview/')), null);
});

// The tracker repeats the route it is already on — a replaceState, or the
// report that answers this pane's own navigation. That must not push a
// duplicate entry or clear Forward.
test('re-reporting the current route changes nothing', () => {
  let history = previewHistoryVisit(previewHistoryReset('/preview/'), '/preview/about');
  history = previewHistoryBack(history)?.state ?? history;
  const before = history;

  assert.equal(previewHistoryVisit(before, before.current), before);
  assert.deepEqual(before.forward, ['/preview/about']);
});

test('the back stack is capped so a long session cannot grow it forever', () => {
  let history = previewHistoryReset('/preview/');
  for (let index = 0; index < PREVIEW_HISTORY_LIMIT + 10; index += 1) {
    history = previewHistoryVisit(history, `/preview/page-${index}`);
  }
  assert.equal(history.back.length, PREVIEW_HISTORY_LIMIT);
  // The oldest entries are the ones dropped.
  assert.equal(history.back[0], '/preview/page-9');
});

// A route change is a document load in a cross-origin frame, so the parent has
// no load event to watch: the wait is a second of nothing after a selection.
// The bar reports it, and the tracker's report is what ends it — which is why
// the two ends have to agree on what "answered" means.
test('the navigating flag is raised on a route change and cleared by its report', async () => {
  const [hook, bar, css] = await Promise.all([
    readFile('app/features/workspace/hooks/use-preview-navigation.ts', 'utf8'),
    readFile('app/features/workspace/components/preview-address-bar.tsx', 'utf8'),
    readFile('app/styles/workspace.css', 'utf8'),
  ]);

  // Raised where the navigation is issued, from the route it is leaving.
  assert.match(hook, /beginNavigation\(from, path\)/);
  assert.match(hook, /pendingRef\.current = \{ from, target \}/);
  // Cleared by the tracker's report, and only by a report that is not the route
  // we started from — that one was already in flight and must not be mistaken
  // for an answer.
  assert.match(hook, /if \(display === pending\.from\) return;/);
  assert.match(hook, /clearNavigation\(\);/);
  // A bounded wait: an injected tracker is absent whenever the loaded document
  // is not one the proxy rewrote, and the track must not run forever.
  assert.match(hook, /PREVIEW_NAVIGATION_MAX_MS = 15_000/);
  assert.match(hook, /setTimeout\(clearNavigation, PREVIEW_NAVIGATION_MAX_MS\)/);
  // A remount ends it too, rather than leaving the bar claiming a stale wait.
  assert.match(hook, /const reset = useCallback\(\(path = ''\) => \{\s*clearNavigation\(\);/);

  // The bar renders the track only while the wait is open, and names it.
  assert.match(bar, /navigating && \(/);
  assert.match(bar, /className="workspace-address-progress"/);
  assert.match(bar, /role="progressbar"/);

  // The sweep is decorative: the accessible signal is the element appearing.
  assert.match(css, /\.workspace-address-progress \{[\s\S]*?position: absolute/);
  // Visible as a trough: a 2px hairline in a tinted colour read as a smudge.
  assert.match(css, /\.workspace-address-progress \{[\s\S]*?height: 3px/);
  assert.match(css, /\.workspace-address-progress \{[\s\S]*?background: var\(--n-200\)/);
  assert.match(css, /\.workspace-address-progress::after \{[\s\S]*?animation:/);
  // And it is the one piece of motion here, so it honours reduced motion.
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.workspace-address-progress::after \{[\s\S]*?animation: none/);
});
