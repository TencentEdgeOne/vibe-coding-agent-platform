'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  previewDisplayPathFromPath,
  previewTrackedPathFromDisplayPath,
} from '../../../../shared/preview-display-path';
import {
  previewHistoryBack,
  previewHistoryForward,
  previewHistoryReset,
  previewHistoryVisit,
  type PreviewHistoryState,
} from '../../../../shared/preview-history';

export type PreviewNavigate = (path: string) => void;

/**
 * Upper bound on how long the address bar may claim a navigation is in flight.
 *
 * The end of a navigation is a report from the frame's own tracker, which is
 * absent whenever the document that loads is not one the proxy injected into —
 * a download, a blocked frame, a response with no HTML. Without this the track
 * would sit there for the rest of the visit; with it, the bar admits it does not
 * know and stops claiming to.
 */
const PREVIEW_NAVIGATION_MAX_MS = 15_000;

/**
 * The address-bar half of the preview surface.
 *
 * The iframe is cross-origin, so its history cannot be read and `history.back()`
 * inside it is not reliably observable. The pane therefore keeps its own two
 * stacks here and drives the frame by navigation only: Back and Forward both
 * navigate to a route the pane already recorded, while a new visit truncates
 * the forward stack the way a browser does.
 */
export function usePreviewNavigation(options: {
  shareablePreviewUrl: string;
  pendingPreviewUrl: string;
  isPreviewMessageOrigin: (origin: string, previewUrls: readonly string[]) => boolean;
  activePreviewUrlRef: { current: string };
  navigate: PreviewNavigate;
}) {
  const [history, setHistory] = useState<PreviewHistoryState>(previewHistoryReset());
  const [navigating, setNavigating] = useState(false);
  const historyRef = useRef(history);
  const pendingRef = useRef<{ from: string; target: string } | null>(null);
  const timerRef = useRef(0);

  const commit = useCallback((next: PreviewHistoryState) => {
    historyRef.current = next;
    setHistory(next);
  }, []);

  /**
   * Ends the wait, whatever ended it. Called by the tracker's report, by the
   * safety timer, and by a remount — in every case the pending target stops
   * being something worth waiting for.
   */
  const clearNavigation = useCallback(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = 0;
    pendingRef.current = null;
    setNavigating(false);
  }, []);

  const reset = useCallback((path = '') => {
    clearNavigation();
    commit(previewHistoryReset(path));
  }, [clearNavigation, commit]);

  /**
   * `from` is passed rather than read from the ref: the callers commit the new
   * entry first — so the bar and the buttons move in the same tick as the click
   * — which would leave the ref already holding the target.
   */
  const beginNavigation = useCallback((from: string, target: string) => {
    pendingRef.current = { from, target };
    setNavigating(true);
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(clearNavigation, PREVIEW_NAVIGATION_MAX_MS);
  }, [clearNavigation]);

  /**
   * Entries are stored in display form — the route as the address bar shows it,
   * `/about` rather than `/preview/about?access_token=…`. A report from the
   * tracker that answers our own navigation normalises to the entry already at
   * the top, so it is a no-op: no duplicate entry, and Forward is kept.
   */
  const apply = useCallback((path: string) => {
    const display = previewDisplayPathFromPath(path);
    const pending = pendingRef.current;
    if (pending) {
      // A report naming the route we just left was already in flight when the
      // click happened. Applying it would push the old route back onto the
      // stack, so it is dropped rather than treated as a visit.
      if (display === pending.from) return;
      // Any other report is this navigation answering: the target we asked for,
      // or wherever a redirect actually landed.
      clearNavigation();
    }
    const next = previewHistoryVisit(historyRef.current, display);
    if (next !== historyRef.current) commit(next);
  }, [clearNavigation, commit]);

  useEffect(() => () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const payload = event.data;
      if (!payload || typeof payload !== 'object') return;
      const path = (payload as { __edgeonePreviewPath?: unknown }).__edgeonePreviewPath;
      if (typeof path !== 'string' || !path) return;
      if (!options.isPreviewMessageOrigin(event.origin, [
        options.activePreviewUrlRef.current,
        options.pendingPreviewUrl,
      ])) return;
      apply(path);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [apply, options.activePreviewUrlRef, options.isPreviewMessageOrigin, options.pendingPreviewUrl]);

  // A new iframe starts a new history: the old entries point at documents the
  // current frame has never served.
  useEffect(() => {
    if (options.pendingPreviewUrl) reset();
  }, [options.pendingPreviewUrl, reset]);

  const canGoBack = history.back.length > 0;
  const canGoForward = history.forward.length > 0;

  function goBack() {
    const step = previewHistoryBack(historyRef.current);
    if (!step) return;
    const from = historyRef.current.current;
    commit(step.state);
    beginNavigation(from, step.target);
    options.navigate(previewTrackedPathFromDisplayPath(step.target));
  }

  function goForward() {
    const step = previewHistoryForward(historyRef.current);
    if (!step) return;
    const from = historyRef.current.current;
    commit(step.state);
    beginNavigation(from, step.target);
    options.navigate(previewTrackedPathFromDisplayPath(step.target));
  }

  function selectRoute(path: string) {
    // Update the stacks before the frame reports back, so the address bar and
    // the buttons move in the same tick as the click.
    const from = historyRef.current.current;
    commit(previewHistoryVisit(historyRef.current, path));
    beginNavigation(from, path);
    options.navigate(previewTrackedPathFromDisplayPath(path));
  }

  return {
    path: history.current,
    // Idempotent for an entry already in display form, and it turns the initial
    // empty string into '/' so the bar never renders blank.
    displayPath: previewDisplayPathFromPath(history.current),
    canGoBack,
    canGoForward,
    navigating,
    reset,
    goBack,
    goForward,
    selectRoute,
  };
}
