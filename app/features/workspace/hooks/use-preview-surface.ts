'use client';

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { isMakersDeployUrl } from '../../../../shared/makers-url';
import { previewDeepLink } from '../../../../shared/preview-link';
import type { FileTree, LinkInfo } from '@/app/types/workspace';
import { fetchPreviewRefresh } from '../workspace-api';

const PREVIEW_CREDENTIAL_REFRESH_MS = 8 * 60_000;
const PREVIEW_REFRESH_POLL_MS = 60_000;

export function isSamePreviewTarget(a: string, b: string) {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.origin === right.origin && left.pathname === right.pathname;
  } catch {
    return false;
  }
}

export function isPreviewMessageOrigin(origin: string, previewUrls: readonly string[]) {
  if (!origin || origin === 'null') return false;
  return previewUrls.some((url) => {
    if (!url) return false;
    try {
      return new URL(url).origin === origin;
    } catch {
      return false;
    }
  });
}

export function usePreviewSurface(options: {
  conversationIdRef: MutableRefObject<string | null>;
  loadingRef: MutableRefObject<boolean>;
  workspaceRestoringRef: MutableRefObject<boolean>;
  setFileTree: (tree: FileTree) => void;
  setDownload: (download: LinkInfo) => void;
}) {
  const [preview, setPreview] = useState<LinkInfo | null>(null);
  const [previewViewport, setPreviewViewport] = useState<'desktop' | 'mobile'>('desktop');
  const [activePreviewUrl, setActivePreviewUrl] = useState('');
  const [activePreviewRevision, setActivePreviewRevision] = useState(0);
  const [activePreviewLoaded, setActivePreviewLoaded] = useState(false);
  const [previewRefreshing, setPreviewRefreshing] = useState(false);
  const [previewRefreshFailed, setPreviewRefreshFailed] = useState(false);
  const [previewCopied, setPreviewCopied] = useState(false);
  const [previewPath, setPreviewPath] = useState('');
  const previewPathRef = useRef('');
  const [pendingPreviewUrl, setPendingPreviewUrl] = useState('');
  const pendingPreviewUrlRef = useRef('');
  const [pendingPreviewRevision, setPendingPreviewRevision] = useState(0);
  const activePreviewUrlRef = useRef('');
  const activePreviewRevisionRef = useRef(0);
  const previewRevisionRef = useRef(0);
  const previewRefreshInFlightRef = useRef(false);
  const previewHiddenAtRef = useRef(0);
  const previewRefreshedAtRef = useRef(0);
  const hasLivePreviewRef = useRef(false);
  const isMakersPreviewRef = useRef(false);
  const refreshPreviewLinkRef = useRef<(options?: {
    showLoading?: boolean;
    remountIframe?: boolean;
  }) => Promise<boolean>>(async () => false);

  const shareablePreviewUrl = preview?.url || activePreviewUrl;

  useEffect(() => {
    pendingPreviewUrlRef.current = pendingPreviewUrl;
  }, [pendingPreviewUrl]);

  useEffect(() => {
    hasLivePreviewRef.current = Boolean(preview?.url);
    isMakersPreviewRef.current = preview?.kind === 'makers' || isMakersDeployUrl(preview?.url);
  }, [preview?.url, preview?.kind]);

  useEffect(() => {
    const applyFreshPreviewUrl = (
      url: string,
      sandboxDebugUrl?: string,
      applyOptions?: { remountIframe?: boolean },
    ): boolean => {
      setPreview({ url, sandboxDebugUrl });
      setPreviewRefreshFailed(false);
      previewRefreshedAtRef.current = Date.now();

      if (
        applyOptions?.remountIframe === false
        && activePreviewUrlRef.current
        && isSamePreviewTarget(activePreviewUrlRef.current, url)
      ) {
        return false;
      }

      const revision = previewRevisionRef.current + 1;
      previewRevisionRef.current = revision;
      activePreviewUrlRef.current = url;
      activePreviewRevisionRef.current = revision;
      setActivePreviewUrl(url);
      setActivePreviewRevision(revision);
      setActivePreviewLoaded(false);
      setPendingPreviewUrl('');
      setPendingPreviewRevision(0);
      return true;
    };

    const refreshPreviewLink = async (refreshOptions?: {
      showLoading?: boolean;
      remountIframe?: boolean;
    }) => {
      const id = options.conversationIdRef.current;
      if (
        !id
        || !hasLivePreviewRef.current
        || isMakersPreviewRef.current
        || options.loadingRef.current
        || options.workspaceRestoringRef.current
        || previewRefreshInFlightRef.current
      ) {
        return false;
      }

      previewRefreshInFlightRef.current = true;
      const willRemount = refreshOptions?.remountIframe !== false;
      const previousActiveUrl = activePreviewUrlRef.current;

      if (refreshOptions?.showLoading) {
        setPreviewRefreshing(true);
        setPreviewRefreshFailed(false);
        setActivePreviewLoaded(false);
        if (willRemount && previousActiveUrl) {
          activePreviewUrlRef.current = '';
          setActivePreviewUrl('');
          setPendingPreviewUrl('');
          setPendingPreviewRevision(0);
        }
      }

      try {
        const data = await fetchPreviewRefresh(id);
        if (data?.ok && data.preview?.url) {
          applyFreshPreviewUrl(data.preview.url, data.preview.sandboxDebugUrl, {
            remountIframe: willRemount || data.preview.restarted === true,
          });
          if (data.files?.items?.length) {
            options.setFileTree(data.files);
          }
          if (data.download?.url) {
            options.setDownload(data.download);
          }
          return true;
        }
        if (refreshOptions?.showLoading) {
          setPreviewRefreshFailed(true);
        }
        return false;
      } finally {
        previewRefreshInFlightRef.current = false;
        if (refreshOptions?.showLoading) {
          setPreviewRefreshing(false);
        }
      }
    };

    refreshPreviewLinkRef.current = refreshPreviewLink;

    const onVisibility = () => {
      if (document.visibilityState !== 'visible') {
        previewHiddenAtRef.current = Date.now();
        return;
      }

      const hiddenFor = previewHiddenAtRef.current
        ? Date.now() - previewHiddenAtRef.current
        : 0;
      previewHiddenAtRef.current = 0;
      const credentialAge = Date.now() - previewRefreshedAtRef.current;
      const wentStale = hiddenFor >= PREVIEW_CREDENTIAL_REFRESH_MS
        || credentialAge >= PREVIEW_CREDENTIAL_REFRESH_MS;
      if (!wentStale || isMakersPreviewRef.current) return;

      void refreshPreviewLink({
        remountIframe: true,
        showLoading: true,
      });
    };

    const refreshTimer = window.setInterval(() => {
      if (
        document.visibilityState === 'visible'
        && hasLivePreviewRef.current
        && !isMakersPreviewRef.current
        && Date.now() - previewRefreshedAtRef.current >= PREVIEW_CREDENTIAL_REFRESH_MS
      ) {
        void refreshPreviewLink({
          remountIframe: true,
          showLoading: true,
        });
      }
    }, PREVIEW_REFRESH_POLL_MS);

    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(refreshTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      refreshPreviewLinkRef.current = async () => false;
    };
    // Mount-only: conversation, loading, and restore flags are read from refs.
  }, []);

  const promotePendingPreview = () => {
    if (!pendingPreviewUrl) return;
    activePreviewUrlRef.current = pendingPreviewUrl;
    activePreviewRevisionRef.current = pendingPreviewRevision;
    setActivePreviewUrl(pendingPreviewUrl);
    setActivePreviewRevision(pendingPreviewRevision);
    setActivePreviewLoaded(true);
    setPendingPreviewUrl('');
    setPendingPreviewRevision(0);
  };

  useEffect(() => {
    if (!activePreviewUrl || activePreviewLoaded || previewRefreshing) return;
    const timer = window.setTimeout(() => setActivePreviewLoaded(true), 3000);
    return () => window.clearTimeout(timer);
  }, [activePreviewUrl, activePreviewLoaded, activePreviewRevision, previewRefreshing]);

  useEffect(() => {
    if (!pendingPreviewUrl) return;
    const timer = window.setTimeout(() => {
      activePreviewUrlRef.current = pendingPreviewUrl;
      activePreviewRevisionRef.current = pendingPreviewRevision;
      setActivePreviewUrl(pendingPreviewUrl);
      setActivePreviewRevision(pendingPreviewRevision);
      setActivePreviewLoaded(true);
      setPendingPreviewUrl('');
      setPendingPreviewRevision(0);
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [pendingPreviewUrl, pendingPreviewRevision]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const payload = event.data;
      if (!payload || typeof payload !== 'object') return;
      const path = (payload as { __edgeonePreviewPath?: unknown }).__edgeonePreviewPath;
      if (typeof path !== 'string' || !path) return;
      if (!isPreviewMessageOrigin(event.origin, [
        activePreviewUrlRef.current,
        pendingPreviewUrlRef.current,
      ])) return;
      if (path === previewPathRef.current) return;
      previewPathRef.current = path;
      setPreviewPath(path);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const handleActivePreviewLoad = useCallback(() => {
    if (!previewRefreshInFlightRef.current) {
      setActivePreviewLoaded(true);
    }
  }, []);

  function handleRefreshPreview() {
    if (!shareablePreviewUrl) return;
    void refreshPreviewLinkRef.current({ showLoading: true });
  }

  function handleOpenPreview() {
    if (shareablePreviewUrl) {
      window.open(
        previewDeepLink(shareablePreviewUrl, previewPath),
        '_blank',
        'noopener,noreferrer',
      );
    }
  }

  async function handleCopyPreviewUrl() {
    if (!shareablePreviewUrl || !navigator.clipboard) return;
    const urlToCopy = previewDeepLink(shareablePreviewUrl, previewPath);
    try {
      await navigator.clipboard.writeText(urlToCopy);
      setPreviewCopied(true);
      window.setTimeout(() => setPreviewCopied(false), 1600);
    } catch {
      setPreviewCopied(false);
    }
  }

  function activatePreview(nextPreview: LinkInfo, activatedPreviewRevisions: Map<string, number>) {
    if (!nextPreview.url) {
      if (nextPreview.error) {
        setPreview((current) =>
          current?.url
            ? {
                ...nextPreview,
                url: current.url,
                sandboxDebugUrl: nextPreview.sandboxDebugUrl ?? current.sandboxDebugUrl,
              }
            : nextPreview,
        );
      }
      return;
    }

    setPreview(nextPreview);
    setPreviewRefreshFailed(false);
    previewRefreshedAtRef.current = Date.now();
    let revision = activatedPreviewRevisions.get(nextPreview.url);
    if (revision === undefined) {
      revision = previewRevisionRef.current + 1;
      previewRevisionRef.current = revision;
      activatedPreviewRevisions.set(nextPreview.url, revision);
    }

    if (!activePreviewUrlRef.current) {
      activePreviewUrlRef.current = nextPreview.url;
      activePreviewRevisionRef.current = revision;
      setActivePreviewUrl(nextPreview.url);
      setActivePreviewRevision(revision);
      setActivePreviewLoaded(false);
      setPendingPreviewUrl('');
      setPendingPreviewRevision(0);
      return;
    }

    if (
      activePreviewUrlRef.current === nextPreview.url
      && activePreviewRevisionRef.current === revision
    ) {
      return;
    }

    setPendingPreviewUrl(nextPreview.url);
    setPendingPreviewRevision(revision);
  }

  function applyResumedPreview(nextPreview: LinkInfo | undefined) {
    if (nextPreview?.url) {
      setPreview(nextPreview);
      setPreviewRefreshFailed(false);
      previewRefreshedAtRef.current = Date.now();
      const revision = previewRevisionRef.current + 1;
      previewRevisionRef.current = revision;
      activePreviewUrlRef.current = nextPreview.url;
      activePreviewRevisionRef.current = revision;
      setActivePreviewUrl(nextPreview.url);
      setActivePreviewRevision(revision);
      setActivePreviewLoaded(false);
      return;
    }
    setPreview(null);
    setPreviewRefreshFailed(false);
    activePreviewUrlRef.current = '';
    activePreviewRevisionRef.current = 0;
    setActivePreviewUrl('');
    setActivePreviewRevision(0);
    setActivePreviewLoaded(false);
    previewPathRef.current = '';
    setPreviewPath('');
  }

  const resetPreview = useCallback(() => {
    setPreview(null);
    setPreviewViewport('desktop');
    activePreviewUrlRef.current = '';
    activePreviewRevisionRef.current = 0;
    previewRevisionRef.current = 0;
    setActivePreviewUrl('');
    setActivePreviewRevision(0);
    setActivePreviewLoaded(false);
    setPreviewRefreshFailed(false);
    setPendingPreviewUrl('');
    setPendingPreviewRevision(0);
    setPreviewCopied(false);
    previewPathRef.current = '';
    setPreviewPath('');
  }, []);

  return {
    preview,
    setPreview,
    previewViewport,
    setPreviewViewport,
    activePreviewUrl,
    activePreviewRevision,
    activePreviewLoaded,
    previewRefreshing,
    previewRefreshFailed,
    previewCopied,
    previewPath,
    pendingPreviewUrl,
    pendingPreviewRevision,
    shareablePreviewUrl,
    previewRevisionRef,
    activePreviewUrlRef,
    activePreviewRevisionRef,
    previewPathRef,
    previewRefreshedAtRef,
    promotePendingPreview,
    handleActivePreviewLoad,
    handleRefreshPreview,
    handleOpenPreview,
    handleCopyPreviewUrl,
    activatePreview,
    applyResumedPreview,
    resetPreview,
  };
}

export type PreviewSurfaceApi = ReturnType<typeof usePreviewSurface>;
