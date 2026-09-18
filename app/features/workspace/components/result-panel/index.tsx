'use client';

import type { FileCopy, SessionCopy, UiCopy } from '@/app/i18n';
import type { FileContentCache } from '@/app/hooks/use-file-content-cache';
import type { PreviewControlsCopy } from '../preview-controls';
import type { PreviewFrameCopy } from '../preview-frame';
import { WorkspaceErrorBar } from '../workspace-error-bar';
import { SessionPanel } from '../lazy-panels';
import type { PreviewSurfaceApi } from '../../hooks/use-preview-surface';
import type { WorkspaceStateApi } from '../../hooks/use-workspace-state';
import { FilesPane } from './files-pane';
import { PreviewPane } from './preview-pane';
import { ResultPanelTopbar, SHOW_SESSION_TAB } from './result-panel-topbar';

export { ResultPanelToggle } from './result-panel-toggle';
export { SHOW_SESSION_TAB };

export function ResultPanel({
  workspace,
  preview,
  t,
  previewDisplayPath,
  deployHint,
  downloadHint,
  canDeployProject,
  publishing,
  conversationId,
  previewControlsCopy,
  previewFrameCopy,
  restoring,
  cache,
  loading,
  handleDeployProject,
}: {
  workspace: WorkspaceStateApi;
  preview: PreviewSurfaceApi;
  t: UiCopy;
  previewDisplayPath: string;
  deployHint: string;
  downloadHint: string;
  canDeployProject: boolean;
  publishing: boolean;
  conversationId: string | null;
  previewControlsCopy: PreviewControlsCopy;
  previewFrameCopy: PreviewFrameCopy;
  restoring: boolean;
  cache: FileContentCache;
  loading: boolean;
  handleDeployProject: () => void;
}) {
  const filesCopy: FileCopy = t.files;
  const sessionCopy: SessionCopy = t.session;

  return (
    <div id="workspace-result-panel" className="workspace-result-panel">
      <ResultPanelTopbar
        workspace={workspace}
        preview={preview}
        t={t}
        copy={{
          preview: t.workspace.preview,
          code: t.workspace.code,
          session: t.workspace.session,
          showPanel: t.workspace.showPanel,
          hidePanel: t.workspace.hidePanel,
          previewPathCopied: t.workspace.previewPathCopied,
          copyPreviewPath: t.workspace.copyPreviewPath,
          filesRefreshing: t.files.refreshing,
        }}
        previewDisplayPath={previewDisplayPath}
        deployHint={deployHint}
        downloadHint={downloadHint}
        canDeployProject={canDeployProject}
        publishing={publishing}
        conversationId={conversationId}
        previewControlsCopy={previewControlsCopy}
        handleDeployProject={handleDeployProject}
      />

      <div className="workspace-panel-content">
        {!workspace.sandboxTab && (
          <div className="workspace-empty-state">
            <p>{t.workspace.choosePanel}</p>
          </div>
        )}
        <PreviewPane
          workspace={workspace}
          preview={preview}
          restoring={restoring}
          restoringLabel={t.workspace.restoringWorkspace}
          previewStarting={t.workspace.previewStarting}
          previewEmpty={t.workspace.previewEmpty}
          constructionDisclaimer={t.workspace.constructionDisclaimer}
          previewFrameCopy={previewFrameCopy}
        />
        <FilesPane
          workspace={workspace}
          conversationId={conversationId}
          restoring={restoring}
          copy={filesCopy}
          cache={cache}
        />
        {SHOW_SESSION_TAB && workspace.sandboxTab === 'session' && (
          <div className="workspace-panel-pane">
            <SessionPanel
              conversationId={conversationId}
              live={loading}
              copy={sessionCopy}
            />
          </div>
        )}
      </div>

      <WorkspaceErrorBar
        build={workspace.build?.status === 'failed'
          ? (workspace.build.autoFixApplied && workspace.build.autoFixAttempts
            ? t.workspace.buildFailedAfter(workspace.build.autoFixAttempts)
            : t.workspace.buildFailedMessage)
          : ''}
        preview={preview.preview?.error ? `${t.workspace.previewError}${preview.preview.error}` : ''}
        download={workspace.download?.error ? `${t.workspace.downloadError}${workspace.download.error}` : ''}
      />
    </div>
  );
}
