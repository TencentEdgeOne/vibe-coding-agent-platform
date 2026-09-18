'use client';

import type { FileCopy } from '@/app/i18n';
import type { FileContentCache } from '@/app/hooks/use-file-content-cache';
import { FilesPanel } from '../files';
import type { WorkspaceStateApi } from '../../hooks/use-workspace-state';

export function FilesPane({
  workspace,
  conversationId,
  restoring,
  copy,
  cache,
}: {
  workspace: WorkspaceStateApi;
  conversationId: string | null;
  restoring: boolean;
  copy: FileCopy;
  cache: FileContentCache;
}) {
  if (workspace.sandboxTab !== 'files') return null;
  return (
    <div className="workspace-panel-pane">
      <FilesPanel
        tree={workspace.fileTree}
        refreshing={workspace.filesRefreshing || restoring}
        conversationId={conversationId}
        copy={copy}
        cache={cache}
        focusPath={workspace.filesFocusPath}
      />
    </div>
  );
}
