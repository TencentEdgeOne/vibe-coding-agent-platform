'use client';

import { Check, Code2, Copy, Download, Eye, Rocket, ScrollText } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/app/components/ui/tabs';
import { PreviewControls, type PreviewControlsCopy } from '../preview-controls';
import type { UiCopy } from '@/app/i18n';
import type { PreviewSurfaceApi } from '../../hooks/use-preview-surface';
import type { SandboxTab, WorkspaceStateApi } from '../../hooks/use-workspace-state';
import { ResultPanelToggle } from './result-panel-toggle';

export const SHOW_SESSION_TAB = process.env.NODE_ENV === 'development';

export function ResultPanelTopbar({
  workspace,
  preview,
  t,
  copy,
  previewDisplayPath,
  deployHint,
  downloadHint,
  canDeployProject,
  publishing,
  conversationId,
  previewControlsCopy,
  handleDeployProject,
}: {
  workspace: WorkspaceStateApi;
  preview: PreviewSurfaceApi;
  t: UiCopy;
  copy: {
    preview: string;
    code: string;
    session: string;
    showPanel: string;
    hidePanel: string;
    previewPathCopied: string;
    copyPreviewPath: string;
  };
  previewDisplayPath: string;
  deployHint: string;
  downloadHint: string;
  canDeployProject: boolean;
  publishing: boolean;
  conversationId: string | null;
  previewControlsCopy: PreviewControlsCopy;
  handleDeployProject: () => void;
}) {
  return (
    <div className="workspace-topbar">
      <div className="workspace-topbar-tabs">
        <ResultPanelToggle
          open
          showLabel={copy.showPanel}
          hideLabel={copy.hidePanel}
          onToggle={() => workspace.setResultPanelOpen(false)}
        />
        <Tabs
          value={workspace.sandboxTab ?? ''}
          onValueChange={(value) => workspace.setSandboxTab(value as SandboxTab)}
          className="workspace-topbar-tablist"
        >
          <TabsList className="workspace-tabs">
            <TabsTrigger value="preview" className="workspace-tab">
              <Eye />
              {copy.preview}
            </TabsTrigger>
            <TabsTrigger value="files" className="workspace-tab">
              <Code2 />
              {copy.code}
            </TabsTrigger>
            {SHOW_SESSION_TAB && (
              <TabsTrigger value="session" className="workspace-tab">
                <ScrollText />
                {copy.session}
              </TabsTrigger>
            )}
          </TabsList>
        </Tabs>
      </div>

      <div className="workspace-topbar-center">
        {workspace.sandboxTab === 'preview' && preview.shareablePreviewUrl && !preview.previewRefreshing && !preview.previewRefreshFailed && (
          <button
            type="button"
            onClick={() => void preview.handleCopyPreviewUrl()}
            className="workspace-url-chip"
            title={preview.previewCopied ? copy.previewPathCopied : copy.copyPreviewPath}
          >
            <span dir="ltr">{previewDisplayPath}</span>
            {preview.previewCopied ? <Check /> : <Copy />}
          </button>
        )}
      </div>

      <div className="workspace-topbar-actions">
        <div className="workspace-topbar-group">
          <button
            type="button"
            onClick={handleDeployProject}
            disabled={!canDeployProject}
            className="workspace-icon-button is-publish"
            aria-label={deployHint}
            data-tooltip={deployHint}
          >
            <Rocket className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void workspace.handleDownload(conversationId, t.workspace.downloadFailed)}
            disabled={workspace.downloadBusy || !workspace.download?.url}
            className="workspace-icon-button"
            aria-label={downloadHint}
            data-tooltip={downloadHint}
          >
            {workspace.downloadBusy
              ? <span className="workspace-icon-spinner" />
              : <Download className="size-3.5" />}
          </button>
        </div>
        {workspace.sandboxTab === 'preview' && preview.shareablePreviewUrl && !preview.previewRefreshing && !preview.previewRefreshFailed && (
          <PreviewControls
            viewport={preview.previewViewport}
            publishing={publishing}
            copy={previewControlsCopy}
            onViewportChange={preview.setPreviewViewport}
            onRefresh={preview.handleRefreshPreview}
            onOpen={preview.handleOpenPreview}
          />
        )}
      </div>
    </div>
  );
}
