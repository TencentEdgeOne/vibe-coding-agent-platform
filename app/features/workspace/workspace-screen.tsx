'use client';

import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { TEMPLATE_SOURCE_URL } from '@/app/lib/conversation';
import { useFileContentCache } from '@/app/hooks/use-file-content-cache';
import { useTypewriterPlaceholder } from '@/app/hooks/use-typewriter-placeholder';
import { TRANSLATIONS, type Locale } from '@/app/i18n';
import { previewDisplayPathFromPath } from '../../../shared/preview-display-path';
import type { ModelOption } from '../../../shared/models';
import { HomeStage } from './components/home-stage';
import { NewProjectDialog } from './components/new-project-dialog';
import { WorkspaceCanvas } from './components/workspace-canvas';
import { importAgentConversation } from './components/lazy-panels';
import { SessionPrepLoading } from './components/session-prep-loading';
import { SiteHeader } from './components/site-header';
import { fetchModelCatalog } from './workspace-api';
import { useDeployOffer } from './hooks/use-deploy-offer';
import { useLiveTurn } from './hooks/use-live-turn';
import { useNewProject } from './hooks/use-new-project';
import { usePlatformLinks } from './hooks/use-platform-links';
import { usePreviewSurface } from './hooks/use-preview-surface';
import { useSessionResume } from './hooks/use-session-resume';
import { useWorkspaceCopy } from './hooks/use-workspace-copy';
import { useWorkspaceSnapshot } from './hooks/use-workspace-snapshot';
import { useWorkspaceSplit } from './hooks/use-workspace-split';
import { useWorkspaceState } from './hooks/use-workspace-state';

export function WorkspaceScreen() {
  const [language, setLanguage] = useState<Locale>('zh');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState('');

  const conversationIdRef = useRef<string | null>(null);
  const loadingRef = useRef(false);
  const workspaceRestoringRef = useRef(false);
  const workspaceEpochRef = useRef(0);
  const fileCache = useFileContentCache();

  const workspace = useWorkspaceState();
  const split = useWorkspaceSplit();
  const snapshotRefreshRef = useRef<(conversationId: string) => Promise<unknown>>(async () => null);
  const preview = usePreviewSurface({
    conversationIdRef,
    loadingRef,
    workspaceRestoringRef,
    refreshWorkspace: (id) => snapshotRefreshRef.current(id),
  });
  const snapshot = useWorkspaceSnapshot({
    workspace,
    preview,
    fileCache,
  });
  snapshotRefreshRef.current = snapshot.refresh;

  const t = TRANSLATIONS[language];
  const { contactUrl, templateDeployUrl, makersModelsDocsUrl } = usePlatformLinks(language, setLanguage);
  const live = useLiveTurn({
    language,
    model,
    t,
    workspace,
    preview,
    snapshot,
    conversationId,
    setConversationId,
    conversationIdRef,
    workspaceEpochRef,
    loadingRef,
  });
  const resume = useSessionResume({
    workspace,
    live,
    snapshot,
    setConversationId,
    setModel,
    setLanguage,
    conversationIdRef,
    workspaceEpochRef,
    workspaceRestoringRef,
  });
  const deploy = useDeployOffer({
    t,
    workspace,
    live,
    resume,
  });
  const {
    handleDeployProject,
    deployOffer,
    deployOfferTurnId,
    canDeployProject,
    publishing,
    hasDeployableProject,
  } = deploy;
  const copy = useWorkspaceCopy(t, {
    hasDeployableProject,
    canDeployProject,
    downloadBusy: workspace.downloadBusy,
  });
  const project = useNewProject({
    live,
    resume,
    workspace,
    preview,
    setConversationId,
    conversationIdRef,
    workspaceEpochRef,
    loadingRef,
  });

  const canSend = live.input.trim().length > 0 && !live.loading && !live.stopping;
  const hasWorkspace = live.messages.length > 0
    || Boolean(preview.preview)
    || Boolean(workspace.deployment)
    || Boolean(workspace.build)
    || resume.workspaceRestoring;
  const previewDisplayPath = previewDisplayPathFromPath(preview.previewPath);
  const placeholderPhrases = useMemo(
    () => t.home.examples.map((example) => `${example.label}…`),
    [t],
  );
  const typedPlaceholder = useTypewriterPlaceholder(
    placeholderPhrases,
    !hasWorkspace && live.input.length === 0,
  );

  const clearFileCache = fileCache.clear;
  useEffect(() => {
    clearFileCache();
  }, [clearFileCache, conversationId]);

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  const reconcileFileCache = fileCache.reconcile;
  useEffect(() => {
    reconcileFileCache(workspace.fileTree);
  }, [workspace.fileTree, reconcileFileCache]);

  useEffect(() => {
    if (hasWorkspace) return;
    const timer = window.setTimeout(() => void importAgentConversation(), 1200);
    return () => window.clearTimeout(timer);
  }, [hasWorkspace]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchModelCatalog(controller.signal).then((catalog) => {
      if (controller.signal.aborted || !catalog?.ok || !Array.isArray(catalog.models)) return;
      setModels(catalog.models);
      setModel((current) => current || catalog.defaultModel || '');
    });
    return () => controller.abort();
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await live.sendMessage(live.input);
  }

  const prepStage = live.prepStage || resume.prepStage
    || (live.sessionPreparing ? 'conversation' : null);
  if (!resume.resumeChecked || live.sessionPreparing) {
    return (
      <SessionPrepLoading
        stage={prepStage}
        title={live.sessionPreparing ? t.workspace.preparing : t.workspace.resuming}
        stageLabel={prepStage ? t.workspace.prepStages[prepStage] : t.workspace.resuming}
      />
    );
  }

  return (
    <main className="app-shell flex flex-col text-foreground">
      <SiteHeader
        copy={t}
        language={language}
        hasWorkspace={hasWorkspace}
        contactUrl={contactUrl}
        templateSourceUrl={TEMPLATE_SOURCE_URL}
        templateDeployUrl={templateDeployUrl}
        onLanguageChange={setLanguage}
        onBack={project.handleNewProject}
      />
      <NewProjectDialog
        open={project.newProjectConfirmOpen}
        title={t.workspace.newProjectConfirmTitle}
        description={t.workspace.newProjectConfirmDescription}
        cancelLabel={t.workspace.newProjectConfirmCancel}
        continueLabel={t.workspace.newProjectConfirmContinue}
        onOpenChange={project.setNewProjectConfirmOpen}
        onConfirm={project.confirmNewProject}
      />
      {!hasWorkspace && (
        <HomeStage
          copy={t}
          locale={language}
          input={live.input}
          placeholder={typedPlaceholder}
          canSend={canSend}
          loading={live.loading}
          stopping={live.stopping}
          models={models}
          model={model}
          onModelChange={setModel}
          onInputChange={live.setInput}
          onSubmit={handleSubmit}
          onSend={() => void live.sendMessage(live.input)}
        />
      )}

      <WorkspaceCanvas
        hasWorkspace={hasWorkspace}
        workspace={workspace}
        preview={preview}
        live={live}
        split={split}
        t={t}
        copy={copy}
        models={models}
        model={model}
        onModelChange={setModel}
        conversationId={conversationId}
        previewDisplayPath={previewDisplayPath}
        deployOffer={deployOffer}
        deployOfferTurnId={deployOfferTurnId}
        canSend={canSend}
        canDeployProject={canDeployProject}
        publishing={publishing}
        restoring={resume.workspaceRestoring}
        cache={fileCache}
        makersModelsDocsUrl={makersModelsDocsUrl}
        handleDeployProject={handleDeployProject}
      />
    </main>
  );
}
