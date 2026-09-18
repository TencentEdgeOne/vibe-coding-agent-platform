'use client';

import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  Check,
  Code2,
  Copy,
  Download,
  Eye,
  PanelRight,
  PanelRightClose,
  Rocket,
  ScrollText,
} from 'lucide-react';
import { Button } from '@/app/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/app/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/app/components/ui/tabs';
import {
  lastFinishedAssistant,
  resolveDeployOffer,
} from '../../../shared/timeline';
import { useFileContentCache } from '@/app/hooks/use-file-content-cache';
import { useTypewriterPlaceholder } from '@/app/hooks/use-typewriter-placeholder';
import {
  TEMPLATE_SOURCE_URL,
  TENCENT_CLOUD_CONTACT_URL,
  clearCachedConversationId,
  extractProjectName,
  getContactUrl,
  getMakersModelsDocsUrl,
  getTemplateDeployUrl,
} from '@/app/lib/conversation';
import { LANGUAGE_STORAGE_KEY, TRANSLATIONS, type Locale } from '@/app/i18n';
import { previewDisplayPathFromPath } from '../../../shared/preview-display-path';
import type { ModelOption } from '../../../shared/models';
import { HomeStage } from './components/home-stage';
import { PreviewControls } from './components/preview-controls';
import { PreviewFrame } from './components/preview-frame';
import { SiteHeader } from './components/site-header';
import { SessionPrepLoading } from './components/session-prep-loading';
import { WorkspaceErrorBar } from './components/workspace-error-bar';
import { fetchModelCatalog } from './workspace-api';
import { useLiveTurn } from './hooks/use-live-turn';
import { usePreviewSurface } from './hooks/use-preview-surface';
import { useSessionResume } from './hooks/use-session-resume';
import { useWorkspaceState, type SandboxTab } from './hooks/use-workspace-state';
import { useWorkspaceSnapshot } from './hooks/use-workspace-snapshot';

function ResultPanelToggle({
  open,
  showLabel,
  hideLabel,
  onToggle,
}: {
  open: boolean;
  showLabel: string;
  hideLabel: string;
  onToggle: () => void;
}) {
  const label = open ? hideLabel : showLabel;
  return (
    <button
      type="button"
      onClick={onToggle}
      className="workspace-icon-button"
      aria-expanded={open}
      aria-controls="workspace-result-panel"
      aria-label={label}
      data-tooltip={label}
    >
      {open ? <PanelRightClose /> : <PanelRight />}
    </button>
  );
}

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

const importAgentConversation = () =>
  import('@/app/components/agent-conversation').then((mod) => mod.AgentConversation);
const AgentConversation = dynamic(importAgentConversation, {
  ssr: false,
  loading: PanelLoading,
});
const FilesPanel = dynamic(
  () => import('@/app/components/files-panel').then((mod) => mod.FilesPanel),
  { ssr: false, loading: PanelLoading },
);
const SessionPanel = dynamic(
  () => import('@/app/components/session-panel').then((mod) => mod.SessionPanel),
  { ssr: false, loading: PanelLoading },
);

export function WorkspaceScreen() {
  const [language, setLanguage] = useState<Locale>('zh');
  const [contactUrl, setContactUrl] = useState(TENCENT_CLOUD_CONTACT_URL);
  const [templateDeployUrl, setTemplateDeployUrl] = useState(() => getTemplateDeployUrl(''));
  const [makersModelsDocsUrl, setMakersModelsDocsUrl] = useState(() => getMakersModelsDocsUrl(''));
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState('');
  const [newProjectConfirmOpen, setNewProjectConfirmOpen] = useState(false);

  const conversationIdRef = useRef<string | null>(null);
  const loadingRef = useRef(false);
  const workspaceRestoringRef = useRef(false);
  const workspaceEpochRef = useRef(0);
  const fileCache = useFileContentCache();

  const workspace = useWorkspaceState();
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

  const canSend = live.input.trim().length > 0 && !live.loading;
  const hasWorkspace = live.messages.length > 0
    || Boolean(preview.preview)
    || Boolean(workspace.deployment)
    || Boolean(workspace.build)
    || resume.workspaceRestoring;
  const hasDeployableProject = Boolean(workspace.download?.url);
  const publishing = workspace.deployment?.status === 'running';
  const deployRunning = live.loading || publishing;
  const canDeployProject = hasDeployableProject && !deployRunning && !resume.workspaceRestoring;
  const deployHint = hasDeployableProject
    ? (canDeployProject ? t.deployLabel : t.workspace.deployNeedsIdle)
    : t.workspace.deployNeedsProject;
  const deployOfferKind = resolveDeployOffer(live.messages, {
    canDownload: hasDeployableProject,
    loading: deployRunning || resume.workspaceRestoring,
    hasLiveDeployment: workspace.deployment?.status === 'success',
  });
  const deployOfferTurnId = lastFinishedAssistant(live.messages)?.id || '';
  const deployOffer = deployOfferKind && deployOfferTurnId && deployOfferTurnId !== workspace.dismissedDeployTurnId
    ? {
      prompt: deployOfferKind === 'again'
        ? t.workspace.deployOfferAgain
        : t.workspace.deployOffer,
      deploy: t.workspace.deployOfferAction,
      dismiss: t.workspace.deployOfferDismiss,
    }
    : null;
  const downloadHint = workspace.downloadBusy ? t.workspace.downloading : t.workspace.downloadSource;
  const previewDisplayPath = previewDisplayPathFromPath(preview.previewPath);
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
    const { domain } = extractProjectName();
    setContactUrl(getContactUrl(domain));
    setTemplateDeployUrl(getTemplateDeployUrl(domain));
    setMakersModelsDocsUrl(getMakersModelsDocsUrl(domain));
  }, []);

  useEffect(() => {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (stored === 'zh' || stored === 'en') {
      setLanguage(stored);
    }
  }, []);

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

  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  }, [language]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await live.sendMessage(live.input);
  }

  function handleDeployProject() {
    if (!canDeployProject) return;
    if (!workspace.gatewayConfigured && (workspace.gatewayNeeded || workspace.gatewayDeferred)) {
      workspace.setGatewayPromptVariant('deploy');
      workspace.setGatewayNeeded(true);
    }
    if (deployOfferTurnId) {
      workspace.setDismissedDeployTurnId(deployOfferTurnId);
    }
    void live.sendMessage(t.workspace.deployRequest, { deploy: true });
  }

  function startNewProject() {
    workspaceEpochRef.current += 1;
    live.chatAbortControllerRef.current = null;
    resume.resumeAbortControllerRef.current?.abort();
    resume.resumeAbortControllerRef.current = null;
    live.activeTurnIdRef.current = '';
    live.stoppingRef.current = false;
    loadingRef.current = false;
    conversationIdRef.current = null;
    clearCachedConversationId();
    setConversationId(null);
    live.setMessages([]);
    live.setLoading(false);
    live.setSessionPreparing(false);
    live.setPrepStage(null);
    live.setInput('');
    workspace.resetWorkspace();
    preview.resetPreview();
    resume.setWorkspaceRestoring(false);
  }

  function handleNewProject() {
    if (live.loadingRef.current) {
      setNewProjectConfirmOpen(true);
      return;
    }
    startNewProject();
  }

  function confirmNewProject() {
    setNewProjectConfirmOpen(false);
    if (live.loadingRef.current) {
      void live.stopCurrentTask({ discardProject: true });
    }
    startNewProject();
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
        onBack={handleNewProject}
      />
      <Dialog open={newProjectConfirmOpen} onOpenChange={setNewProjectConfirmOpen}>
        <DialogContent
          className="contact-dialog"
          overlayClassName="contact-dialog-overlay"
          showCloseButton={false}
        >
          <DialogHeader>
            <DialogTitle>{t.workspace.newProjectConfirmTitle}</DialogTitle>
            <DialogDescription>{t.workspace.newProjectConfirmDescription}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="contact-dialog-footer">
            <DialogClose asChild>
              <Button variant="outline">{t.workspace.newProjectConfirmCancel}</Button>
            </DialogClose>
            <Button onClick={confirmNewProject}>
              {t.workspace.newProjectConfirmContinue}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {!hasWorkspace && (
        <HomeStage
          copy={t}
          locale={language}
          input={live.input}
          placeholder={typedPlaceholder}
          canSend={canSend}
          loading={live.loading}
          models={models}
          model={model}
          onModelChange={setModel}
          onInputChange={live.setInput}
          onSubmit={handleSubmit}
          onSend={() => void live.sendMessage(live.input)}
        />
      )}

      <section
        className={`min-h-0 min-w-0 w-full flex-1 ${
          hasWorkspace
            ? `workspace-shell${workspace.resultPanelOpen ? '' : ' is-chat-only'}`
            : 'hidden'
        }`}
      >
        {hasWorkspace && <AgentConversation
          messages={live.messages}
          input={live.input}
          loading={live.loading}
          canSend={canSend}
          compact
          models={models}
          model={model}
          onModelChange={setModel}
          copy={conversationCopy}
          onInputChange={live.setInput}
          onSubmit={() => void live.sendMessage(live.input)}
          onStop={() => void live.stopCurrentTask()}
          deployOffer={workspace.gatewayNeeded ? null : deployOffer}
          onDeployOffer={handleDeployProject}
          onDismissDeployOffer={() => {
            if (deployOfferTurnId) workspace.setDismissedDeployTurnId(deployOfferTurnId);
          }}
          gatewayPrompt={workspace.gatewayNeeded ? {
            title: t.workspace.gatewayPromptTitle,
            description: workspace.gatewayPromptVariant === 'deploy'
              ? `${t.workspace.gatewayPromptDescription} ${t.workspace.gatewayPromptDeployHint}`
              : t.workspace.gatewayPromptDescription,
            docs: t.workspace.gatewayPromptDocs,
            docsUrl: makersModelsDocsUrl,
            apiKey: t.workspace.gatewayPromptApiKey,
            continue: t.workspace.gatewayPromptContinue,
            skip: t.workspace.gatewayPromptSkip,
          } : null}
          gatewayChip={workspace.gatewayDeferred && !workspace.gatewayNeeded
            ? t.workspace.gatewayPromptChip
            : null}
          gatewaySaved={workspace.gatewayConfigured && !workspace.gatewayNeeded
            ? t.workspace.gatewayPromptSaved
            : null}
          gatewayBusy={workspace.gatewayBusy}
          onGatewaySubmit={(values) => {
            const apiKey = values.apiKey.trim();
            if (!apiKey || workspace.gatewayBusy) return;
            void live.applyGateway({ apiKey });
          }}
          onGatewaySkip={() => {
            if (workspace.gatewayBusy) return;
            void live.applyGateway({ skip: true });
          }}
          onGatewayReopen={() => {
            workspace.setGatewayNeeded(true);
          }}
        />}

        {hasWorkspace && !workspace.resultPanelOpen && (
          <div className="workspace-panel-toggle">
            <ResultPanelToggle
              open={false}
              showLabel={t.workspace.showPanel}
              hideLabel={t.workspace.hidePanel}
              onToggle={() => workspace.setResultPanelOpen(true)}
            />
          </div>
        )}

        {workspace.resultPanelOpen && <div id="workspace-result-panel" className="workspace-result-panel">
          <div className="workspace-topbar">
            <div className="workspace-topbar-tabs">
              <ResultPanelToggle
                open
                showLabel={t.workspace.showPanel}
                hideLabel={t.workspace.hidePanel}
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
                    {t.workspace.preview}
                  </TabsTrigger>
                  <TabsTrigger value="files" className="workspace-tab">
                    <Code2 />
                    {t.workspace.code}
                    {workspace.filesRefreshing && <span className="workspace-tab-refreshing">{t.files.refreshing}</span>}
                  </TabsTrigger>
                  <TabsTrigger value="session" className="workspace-tab">
                    <ScrollText />
                    {t.workspace.session}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            <div className="workspace-topbar-center">
              {workspace.sandboxTab === 'preview' && preview.shareablePreviewUrl && !preview.previewRefreshing && !preview.previewRefreshFailed && (
                <button
                  type="button"
                  onClick={() => void preview.handleCopyPreviewUrl()}
                  className="workspace-url-chip"
                  title={preview.previewCopied ? t.workspace.previewPathCopied : t.workspace.copyPreviewPath}
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

          <div className="workspace-panel-content">
            {!workspace.sandboxTab && (
              <div className="workspace-empty-state">
                <p>{t.workspace.choosePanel}</p>
              </div>
            )}
            <div className={`workspace-panel-pane ${workspace.sandboxTab === 'preview' ? '' : 'is-hidden'}`}>
              {preview.preview?.url ? (
                <PreviewFrame
                  activeUrl={preview.activePreviewUrl}
                  activeRevision={preview.activePreviewRevision}
                  pendingUrl={preview.pendingPreviewUrl}
                  pendingRevision={preview.pendingPreviewRevision}
                  viewport={preview.previewViewport}
                  loaded={preview.activePreviewLoaded}
                  refreshing={preview.previewRefreshing}
                  refreshFailed={preview.previewRefreshFailed}
                  copy={previewFrameCopy}
                  onActiveLoad={preview.handleActivePreviewLoad}
                  onPendingLoad={preview.promotePendingPreview}
                  onRetry={preview.handleRefreshPreview}
                />
              ) : (
                <div className="workspace-empty-state">
                  {resume.workspaceRestoring ? (
                    <>
                      <span
                        className="size-8 animate-spin rounded-full border-2 border-primary/30 border-t-primary"
                        aria-hidden="true"
                      />
                      <p>{t.workspace.restoringWorkspace}</p>
                      <p className="max-w-xl text-xs leading-5 text-muted-foreground">
                        {t.workspace.previewStarting}
                      </p>
                    </>
                  ) : (
                    <>
                      <p>{t.workspace.previewEmpty}</p>
                      <p className="workspace-empty-disclaimer">
                        {t.workspace.constructionDisclaimer}
                      </p>
                    </>
                  )}
                </div>
              )}
            </div>

            {workspace.sandboxTab === 'files' && (
              <div className="workspace-panel-pane">
                <FilesPanel
                  tree={workspace.fileTree}
                  refreshing={workspace.filesRefreshing || resume.workspaceRestoring}
                  conversationId={conversationId}
                  copy={t.files}
                  cache={fileCache}
                  focusPath={workspace.filesFocusPath}
                />
              </div>
            )}

            {workspace.sandboxTab === 'session' && (
              <div className="workspace-panel-pane">
                <SessionPanel
                  conversationId={conversationId}
                  live={live.loading}
                  copy={t.session}
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
        </div>}
      </section>
    </main>
  );
}
