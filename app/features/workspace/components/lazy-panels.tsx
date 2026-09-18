'use client';

import dynamic from 'next/dynamic';

function PanelLoading() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <span
        className="size-8 animate-spin rounded-full border-2 border-primary/30 border-t-primary"
        aria-hidden="true"
      />
    </div>
  );
}

export const importAgentConversation = () =>
  import('./conversation').then((mod) => mod.AgentConversation);
export const AgentConversation = dynamic(importAgentConversation, {
  ssr: false,
  loading: PanelLoading,
});
export const FilesPanel = dynamic(
  () => import('./files').then((mod) => mod.FilesPanel),
  { ssr: false, loading: PanelLoading },
);
export const SessionPanel = dynamic(
  () => import('./session-panel').then((mod) => mod.SessionPanel),
  { ssr: false, loading: PanelLoading },
);
