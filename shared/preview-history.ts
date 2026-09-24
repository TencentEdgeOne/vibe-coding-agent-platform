/**
 * Address-bar history for the preview pane, kept entirely in the parent.
 *
 * The preview runs in a cross-origin iframe, so its real history stack is not
 * readable and `history.back()` cannot be relied on to produce an observable
 * result. This module is the two stacks instead: `back` holds the routes the
 * pane came through, `forward` the ones it backed out of. Selecting a route and
 * following an in-app link are both a plain visit; Back and Forward move one
 * entry between the stacks.
 *
 * Keep it runtime-agnostic and side-effect free — the hook and the tests both
 * call it directly.
 */

export type PreviewHistoryState = {
  /** The route currently shown, in tracker form (`/preview/about?x=1`). */
  current: string;
  /** Oldest first; the last entry is where Back goes. */
  back: string[];
  /** Next entry first; the first entry is where Forward goes. */
  forward: string[];
};

/** Back and forward stay useful without growing a conversation-long list. */
export const PREVIEW_HISTORY_LIMIT = 100;

export const EMPTY_PREVIEW_HISTORY: PreviewHistoryState = {
  current: '',
  back: [],
  forward: [],
};

export function previewHistoryReset(path = ''): PreviewHistoryState {
  return path ? { current: path, back: [], forward: [] } : { ...EMPTY_PREVIEW_HISTORY };
}

function capBack(back: string[]) {
  return back.length > PREVIEW_HISTORY_LIMIT
    ? back.slice(back.length - PREVIEW_HISTORY_LIMIT)
    : back;
}

/**
 * A route the pane arrived at — a menu selection, an in-app link, a redirect.
 * Visiting a new route is where Forward is discarded, which is what a browser
 * does too.
 */
export function previewHistoryVisit(
  history: PreviewHistoryState,
  path: string,
): PreviewHistoryState {
  if (!path || path === history.current) return history;
  const back = history.current ? capBack([...history.back, history.current]) : history.back;
  return { current: path, back, forward: [] };
}

export function previewHistoryBack(history: PreviewHistoryState) {
  if (history.back.length === 0) return null;
  const target = history.back[history.back.length - 1];
  return {
    target,
    state: {
      current: target,
      back: history.back.slice(0, -1),
      forward: history.current
        ? [history.current, ...history.forward]
        : history.forward,
    } satisfies PreviewHistoryState,
  };
}

export function previewHistoryForward(history: PreviewHistoryState) {
  if (history.forward.length === 0) return null;
  const [target, ...rest] = history.forward;
  return {
    target,
    state: {
      current: target,
      back: history.current ? capBack([...history.back, history.current]) : history.back,
      forward: rest,
    } satisfies PreviewHistoryState,
  };
}
