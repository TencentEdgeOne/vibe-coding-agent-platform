'use client';

import { useMemo } from 'react';
import type { UiCopy } from '@/app/i18n';

export function useWorkspaceCopy(t: UiCopy, options: {
  hasDeployableProject: boolean;
  canDeployProject: boolean;
  downloadBusy: boolean;
}) {
  const deployHint = options.hasDeployableProject
    ? (options.canDeployProject ? t.deployLabel : t.workspace.deployNeedsIdle)
    : t.workspace.deployNeedsProject;
  const downloadHint = options.downloadBusy ? t.workspace.downloading : t.workspace.downloadSource;
  const previewFrameCopy = useMemo(() => ({
    unavailable: t.workspace.previewUnavailable,
    loading: t.workspace.loadingPreview,
    retry: t.workspace.retryPreview,
  }), [t]);
  const previewControlsCopy = useMemo(() => ({
    viewportGroup: t.workspace.viewportGroup,
    desktop: t.workspace.viewportDesktop,
    mobile: t.workspace.viewportMobile,
    refresh: t.workspace.refreshPreview,
    open: t.workspace.openPreview,
    pausedForDeploy: t.workspace.previewPausedForDeploy,
  }), [t]);
  const conversationCopy = useMemo(() => ({
    running: t.workspace.activityRunning,
    completed: t.workspace.activityCompleted,
    failed: t.workspace.activityFailed,
    stopped: t.workspace.activityStopped,
    thinking: t.workspace.activityThinking,
    info: t.workspace.activityInfo,
    usage: t.workspace.activityUsage,
    compact: t.workspace.activityCompact,
    status: t.workspace.activityStatus,
    placeholder: t.workspace.changePlaceholder,
    send: t.workspace.send,
    stop: t.workspace.stop,
    modelLabel: t.workspace.modelLabel,
    copyLink: t.workspace.copyLink,
    linkCopied: t.workspace.linkCopied,
  }), [t]);

  return {
    deployHint,
    downloadHint,
    previewFrameCopy,
    previewControlsCopy,
    conversationCopy,
  };
}
