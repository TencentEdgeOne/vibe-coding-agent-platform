'use client';

import { memo } from 'react';
import type { FileCopy } from '@/app/i18n';
import type { FileTree } from '@/app/types/workspace';
import type { FileContentCache } from '@/app/hooks/use-file-content-cache';
import { Spinner } from '@/app/components/spinner';
import { FileContentView } from './file-content-view';
import { FileTreeList } from './file-tree';
import { useFilePreview } from './use-file-preview';

export const FilesPanel = memo(function FilesPanel({
  tree,
  refreshing,
  conversationId,
  copy,
  cache,
  focusPath = null,
}: {
  tree: FileTree | null;
  refreshing: boolean;
  conversationId: string | null;
  copy: FileCopy;
  cache: FileContentCache;
  focusPath?: string | null;
}) {
  const {
    collapsedDirs,
    selectedPath,
    preview,
    loadFile,
    toggleDirectory,
  } = useFilePreview({
    tree,
    conversationId,
    copy,
    cache,
    focusPath,
  });

  if (!tree || tree.items.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-card px-6 text-center text-muted-foreground">
        {refreshing ? (
          <>
            <Spinner />
            <p>{copy.refreshing}</p>
          </>
        ) : (
          <p>{copy.empty}</p>
        )}
      </div>
    );
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)] overflow-hidden bg-[var(--code-paper)] text-[var(--code-ink)] max-sm:grid-cols-[164px_minmax(0,1fr)]">
      <FileTreeList
        tree={tree}
        collapsedDirs={collapsedDirs}
        selectedPath={selectedPath}
        copy={copy}
        onToggleDirectory={toggleDirectory}
        onOpenFile={loadFile}
      />
      <div className="flex min-h-0 flex-col">
        <FileContentView preview={preview} copy={copy} />
      </div>
    </div>
  );
});
