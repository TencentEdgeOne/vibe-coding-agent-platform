'use client';

import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { LinkInfo } from '@/app/types/workspace';
import { fetchPreviewRefresh } from '../workspace-api';
import { isSamePreviewTarget } from './preview-identity';

export function usePreviewRefresh(options: {
  conversationIdRef: MutableRefObject<string | null>;
  loadingRef: MutableRefObject<boolean>;
  workspaceRestoringRef: MutableRefObject<boolean>;
  refreshWorkspace?: (conversationId: string) => Promise<unknown>;
  credentialRefreshMs: number;
  refreshPollMs: number;
  setPreview: Dispatch<SetStateAction<LinkInfo | null>>;
  setPreviewRefreshFailed: Dispatch<SetStateAction<boolean>>;
  setPreviewRefreshing: Dispatch<SetStateAction<boolean>>;
  setActivePreviewUrl: Dispatch<SetStateAction<string>>;
  setActivePreviewRevision: Dispatch<SetStateAction<number>>;
  setActivePreviewLoaded: Dispatch<SetStateAction<boolean>>;
  setPendingPreviewUrl: Dispatch<SetStateAction<string>>;
  setPendingPreviewRevision: Dispatch<SetStateAction<number>>;
  activePreviewUrlRef: MutableRefObject<string>;
  activePreviewRevisionRef: MutableRefObject<number>;
  previewRevisionRef: MutableRefObject<number>;
  previewRefreshedAtRef: MutableRefObject<number>;
  hasLivePreviewRef: MutableRefObject<boolean>;
  isMakersPreviewRef: MutableRefObject<boolean>;
  previewRefreshInFlightRef: MutableRefObject<boolean>;
  previewHiddenAtRef: MutableRefObject<number>;
  refreshPreviewLinkRef: MutableRefObject<(options?: {
    showLoading?: boolean;
    remountIframe?: boolean;
  }) => Promise<boolean>>;
}) {
  const {
    conversationIdRef,
    loadingRef,
    workspaceRestoringRef,
    credentialRefreshMs,
    refreshPollMs,
  } = options;

  useEffect(() => {
    const applyFreshPreviewUrl = (
      url: string,
      sandboxDebugUrl?: string,
      applyOptions?: { remountIframe?: boolean },
    ): boolean => {
      options.setPreview({ url, sandboxDebugUrl });
      options.setPreviewRefreshFailed(false);
      options.previewRefreshedAtRef.current = Date.now();

      if (
        applyOptions?.remountIframe === false
        && options.activePreviewUrlRef.current
        && isSamePreviewTarget(options.activePreviewUrlRef.current, url)
      ) {
        return false;
      }

      const revision = options.previewRevisionRef.current + 1;
      options.previewRevisionRef.current = revision;
      options.activePreviewUrlRef.current = url;
      options.activePreviewRevisionRef.current = revision;
      options.setActivePreviewUrl(url);
      options.setActivePreviewRevision(revision);
      options.setActivePreviewLoaded(false);
      options.setPendingPreviewUrl('');
      options.setPendingPreviewRevision(0);
      return true;
    };

    const refreshPreviewLink = async (refreshOptions?: {
      showLoading?: boolean;
      remountIframe?: boolean;
    }) => {
      const id = conversationIdRef.current;
      if (
        !id
        || !options.hasLivePreviewRef.current
        || options.isMakersPreviewRef.current
        || loadingRef.current
        || workspaceRestoringRef.current
        || options.previewRefreshInFlightRef.current
      ) {
        return false;
      }

      options.previewRefreshInFlightRef.current = true;
      const willRemount = refreshOptions?.remountIframe !== false;
      const previousActiveUrl = options.activePreviewUrlRef.current;

      if (refreshOptions?.showLoading) {
        options.setPreviewRefreshing(true);
        options.setPreviewRefreshFailed(false);
        options.setActivePreviewLoaded(false);
        if (willRemount && previousActiveUrl) {
          options.activePreviewUrlRef.current = '';
          options.setActivePreviewUrl('');
          options.setPendingPreviewUrl('');
          options.setPendingPreviewRevision(0);
        }
      }

      try {
        const data = await fetchPreviewRefresh(id);
        if (data?.ok && data.preview?.url) {
          applyFreshPreviewUrl(data.preview.url, data.preview.sandboxDebugUrl, {
            remountIframe: willRemount || data.preview.restarted === true,
          });
          void options.refreshWorkspace?.(id);
          return true;
        }
        if (refreshOptions?.showLoading) {
          options.setPreviewRefreshFailed(true);
        }
        return false;
      } finally {
        options.previewRefreshInFlightRef.current = false;
        if (refreshOptions?.showLoading) {
          options.setPreviewRefreshing(false);
        }
      }
    };

    options.refreshPreviewLinkRef.current = refreshPreviewLink;

    const onVisibility = () => {
      if (document.visibilityState !== 'visible') {
        options.previewHiddenAtRef.current = Date.now();
        return;
      }

      const hiddenFor = options.previewHiddenAtRef.current
        ? Date.now() - options.previewHiddenAtRef.current
        : 0;
      options.previewHiddenAtRef.current = 0;
      const credentialAge = Date.now() - options.previewRefreshedAtRef.current;
      const wentStale = hiddenFor >= credentialRefreshMs
        || credentialAge >= credentialRefreshMs;
      if (!wentStale || options.isMakersPreviewRef.current) return;

      void refreshPreviewLink({
        remountIframe: true,
        showLoading: true,
      });
    };

    const refreshTimer = window.setInterval(() => {
      if (
        document.visibilityState === 'visible'
        && options.hasLivePreviewRef.current
        && !options.isMakersPreviewRef.current
        && Date.now() - options.previewRefreshedAtRef.current >= credentialRefreshMs
      ) {
        void refreshPreviewLink({
          remountIframe: true,
          showLoading: true,
        });
      }
    }, refreshPollMs);

    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(refreshTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      options.refreshPreviewLinkRef.current = async () => false;
    };
    // Mount-only: conversation, loading, and restore flags are read from refs.
  }, []);
}
