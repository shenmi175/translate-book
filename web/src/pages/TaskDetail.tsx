import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Maximize,
  Minimize,
  Pause,
  PlayCircle,
  RefreshCw,
  Save,
  XCircle
} from 'lucide-react';
import { Client, type ExportJobStatus, type TaskPageBlock, type TaskStatusResponse } from '../api';
import { useI18n } from '../i18n';

const PAGE_SIZE = 20;
const COMPLETED_STATUSES = new Set(['translated', 'edited', 'retranslated']);
const PASSIVE_TASK_STAGES = new Set(['paused', 'cancelled', 'needs_review', 'review_ready']);
const INLINE_EDITABLE_BLOCK_STATUSES = new Set(['translated', 'edited', 'retranslated', 'failed', 'paused', 'cancelled']);
const EPUB_INTERNAL_PLACEHOLDER_PATTERN = /\[\[MTS_(?:OPEN|CLOSE|KEEP)_\d{4}\]\]/;
const EXPORT_PREFERENCES_STORAGE_KEY = 'translate-book.task-detail.export-preferences';

type ViewError = { code: string; message: string };
type DisplayMode = 'compare' | 'source' | 'target';
type ViewMode = 'pagination' | 'scroll';
type ExportLayout = 'translation-only' | 'bilingual';
type ExportFamily = 'markdown' | 'pdf' | 'epub';
type InlineSaveIndicator = 'idle' | 'saving' | 'saved' | 'error';

const DEFAULT_EXPORT_PREFERENCES: { family: ExportFamily; layout: ExportLayout; autoDownload: boolean } = {
  family: 'pdf',
  layout: 'translation-only',
  autoDownload: true
};

function isActiveExportJob(job: ExportJobStatus | null | undefined) {
  return job?.status === 'queued' || job?.status === 'running';
}

function isExportFamily(value: unknown): value is ExportFamily {
  return value === 'markdown' || value === 'pdf' || value === 'epub';
}

function isExportLayout(value: unknown): value is ExportLayout {
  return value === 'translation-only' || value === 'bilingual';
}

function readSavedExportPreferences() {
  if (typeof window === 'undefined') {
    return DEFAULT_EXPORT_PREFERENCES;
  }
  try {
    const raw = window.localStorage.getItem(EXPORT_PREFERENCES_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_EXPORT_PREFERENCES;
    }
    const parsed = JSON.parse(raw);
    return {
      family: isExportFamily(parsed?.family) ? parsed.family : DEFAULT_EXPORT_PREFERENCES.family,
      layout: isExportLayout(parsed?.layout) ? parsed.layout : DEFAULT_EXPORT_PREFERENCES.layout,
      autoDownload: typeof parsed?.autoDownload === 'boolean' ? parsed.autoDownload : DEFAULT_EXPORT_PREFERENCES.autoDownload
    };
  } catch {
    return DEFAULT_EXPORT_PREFERENCES;
  }
}

function persistExportPreferences(preferences: { family: ExportFamily; layout: ExportLayout; autoDownload: boolean }) {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(EXPORT_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Ignore storage failures and keep the export UI usable.
  }
}

function formatBytes(sizeBytes: number | undefined) {
  const value = Number(sizeBytes || 0);
  if (!Number.isFinite(value) || value <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const decimals = size >= 100 || unitIndex === 0 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(decimals)} ${units[unitIndex]}`;
}

function formatExportDateTime(value: string | null | undefined, dateLocale: string) {
  if (!value) {
    return '';
  }
  return new Date(value).toLocaleString(dateLocale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function toViewError(result: any, fallbackMessage: string): ViewError {
  return {
    code: result?.error?.code || 'request_failed',
    message: result?.error?.message || fallbackMessage
  };
}

function formatProviderAwareErrorMessage(message: string | null | undefined, providerLabel: string) {
  if (!message) {
    return '';
  }
  const safeProviderLabel = providerLabel || 'Provider';
  return String(message)
    .replace(/^DeepSeek API error:/i, `${safeProviderLabel} API error:`)
    .replace(/^DeepSeek returned /i, `${safeProviderLabel} returned `)
    .replace(/ via DeepSeek API/gi, ` via ${safeProviderLabel} API`);
}

function hasEpubInternalPlaceholders(value: string | null | undefined) {
  return EPUB_INTERNAL_PLACEHOLDER_PATTERN.test(String(value || ''));
}

function resolveInlineEditorDraft(block: TaskPageBlock) {
  if (!block.shouldTranslate) {
    return block.sourceMarkdown || '';
  }
  const candidate = block.reviewCandidateTranslation || '';
  if (candidate && !hasEpubInternalPlaceholders(candidate)) {
    return candidate;
  }
  return block.translatedMarkdown || '';
}

export default function TaskDetail() {
  const { t, tTaskStage, tBlockStatus, dateLocale } = useI18n();
  const { taskId } = useParams<{ taskId: string }>();
  const taskNotFoundMessage = t('taskDetail.taskMissingMessage');
  const blockNodeRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const pollingStoppedRef = useRef(false);
  const inlineEditorHydratedBlockIdRef = useRef<string | null>(null);
  const inlineAutosaveTimerRef = useRef<number | null>(null);
  const inlineSavePromiseRef = useRef<Promise<boolean> | null>(null);
  const savedExportPreferences = useMemo(() => readSavedExportPreferences(), []);

  const [status, setStatus] = useState<TaskStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [displayMode, setDisplayMode] = useState<DisplayMode>('compare');
  const [viewMode, setViewMode] = useState<ViewMode>('pagination');
  const [currentPage, setCurrentPage] = useState(1);
  const [scrollPagesLoaded, setScrollPagesLoaded] = useState(1);
  const [isFocusMode, setIsFocusMode] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [selectedExportFamily, setSelectedExportFamily] = useState<ExportFamily>(savedExportPreferences.family);
  const [selectedExportLayout, setSelectedExportLayout] = useState<ExportLayout>(savedExportPreferences.layout);
  const [exportAutoDownload, setExportAutoDownload] = useState(savedExportPreferences.autoDownload);
  const [pendingDownloadJobId, setPendingDownloadJobId] = useState<string | null>(null);
  const [viewError, setViewError] = useState<ViewError | null>(null);
  const [pendingFocusBlockId, setPendingFocusBlockId] = useState<string | null>(null);
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1600));
  const [retryRailBlocks, setRetryRailBlocks] = useState<Array<{ id: string; order: number }>>([]);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [inlineDraft, setInlineDraft] = useState('');
  const [inlineSavedDraft, setInlineSavedDraft] = useState('');
  const [inlineSaveIndicator, setInlineSaveIndicator] = useState<InlineSaveIndicator>('idle');
  const [inlineSaveMessage, setInlineSaveMessage] = useState('');
  const [inlineLastSavedAt, setInlineLastSavedAt] = useState<string | null>(null);

  const totalPages = status?.totalPages || 1;
  const visibleBlocks = status?.pageBlocks || [];
  const selectedBlock = visibleBlocks.find((block) => block.id === selectedBlockId) || null;
  const selectedBlockReviewState = selectedBlock?.reviewState || 'none';
  const selectedBlockCandidate = selectedBlock?.reviewCandidateTranslation || '';
  const selectedBlockCanConfirmCandidate = selectedBlockReviewState === 'pending_confirmation' && Boolean(selectedBlockCandidate);
  const selectedBlockCandidateContainsInternalPlaceholders = hasEpubInternalPlaceholders(selectedBlockCandidate);
  const selectedBlockErrorMessage = formatProviderAwareErrorMessage(selectedBlock?.errorMessage, status?.providerLabel || '');
  const inlineEditorDirty = Boolean(selectedBlock && selectedBlock.shouldTranslate && inlineDraft !== inlineSavedDraft);
  const inlineEditorCanSave = Boolean(
    selectedBlock &&
    selectedBlock.shouldTranslate &&
    INLINE_EDITABLE_BLOCK_STATUSES.has(selectedBlock.status)
  );
  const inlineEditorSideBySide = !isFocusMode && viewportWidth >= 1560 && Boolean(selectedBlock);

  function TaskErrorState({ title, message }: { title: string; message: string }) {
    return (
      <div className="glass-panel" style={{ padding: '3rem', maxWidth: '760px', margin: '0 auto', textAlign: 'center' }}>
        <h1 style={{ marginTop: 0, marginBottom: '1rem' }}>{title}</h1>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.8 }}>{message}</p>
        <div style={{ display: 'flex', justifyContent: 'center', gap: '0.75rem', marginTop: '1.5rem', flexWrap: 'wrap' }}>
          <button className="glass-button primary" onClick={() => window.location.reload()}>
            {t('taskDetail.reload')}
          </button>
          <Link to="/tasks" className="glass-button" style={{ textDecoration: 'none' }}>
            {t('taskDetail.backToList')}
          </Link>
        </div>
      </div>
    );
  }

  function markTaskMissing(message = taskNotFoundMessage) {
    pollingStoppedRef.current = true;
    setStatus(null);
    setViewError({ code: 'task_not_found', message });
  }

  function applyOptimisticTaskStage(nextStage: 'paused' | 'cancelled') {
    pollingStoppedRef.current = true;
    setStatus((current) => {
      if (!current) return current;
      const updateBlock = (block: TaskPageBlock | any) =>
        block.status === 'queued' || block.status === 'translating'
          ? { ...block, status: nextStage, errorMessage: '', reviewErrorMessage: '' }
          : block;
      return {
        ...current,
        stage: nextStage,
        updatedAt: new Date().toISOString(),
        summary: { ...current.summary, activeBlocks: 0 },
        blocks: current.blocks?.map(updateBlock),
        pageBlocks: current.pageBlocks.map(updateBlock)
      };
    });
  }

  async function fetchStatus(currentTaskId: string, showLoading = false) {
    if (showLoading) setLoading(true);
    try {
      if (viewMode === 'scroll') {
        const pageRequests = Array.from({ length: scrollPagesLoaded }, (_, index) =>
          Client.getTaskStatus(currentTaskId, {
            page: index + 1,
            pageSize: PAGE_SIZE
          })
        );
        const results = await Promise.all(pageRequests);
        const failedResult = results.find((result) => !result.success);
        if (failedResult) {
          if (failedResult.error?.code === 'task_not_found') {
            markTaskMissing(failedResult.error?.message || taskNotFoundMessage);
            return false;
          }
          setViewError(toViewError(failedResult, t('taskDetail.loadTaskFailed')));
          return false;
        }

        const first = results[0]?.data;
        if (!first) {
          setViewError({ code: 'request_failed', message: t('taskDetail.loadTaskFailedHint') });
          return false;
        }

        const pageBlockMap = new Map<string, TaskPageBlock>();
        results.forEach((result) => {
          result.data.pageBlocks.forEach((block) => {
            pageBlockMap.set(block.id, block);
          });
        });

        const mergedStatus: TaskStatusResponse = {
          ...first,
          page: 1,
          pageSize: PAGE_SIZE,
          pageBlocks: [...pageBlockMap.values()].sort((left, right) => left.order - right.order)
        };
        pollingStoppedRef.current = PASSIVE_TASK_STAGES.has(mergedStatus.stage) && !(mergedStatus.exportJobs || []).some(isActiveExportJob);
        setStatus(mergedStatus);
        setViewError(null);
        return true;
      }

      const result = await Client.getTaskStatus(currentTaskId, {
        page: currentPage,
        pageSize: PAGE_SIZE
      });
      if (!result.success) {
        if (result.error?.code === 'task_not_found') {
          markTaskMissing(result.error?.message || taskNotFoundMessage);
          return false;
        }
        setViewError(toViewError(result, t('taskDetail.loadTaskFailed')));
        return false;
      }
      pollingStoppedRef.current = PASSIVE_TASK_STAGES.has(result.data.stage) && !(result.data.exportJobs || []).some(isActiveExportJob);
      setStatus(result.data);
      setViewError(null);
      return true;
    } catch (error) {
      console.error(error);
      setViewError({ code: 'request_failed', message: t('taskDetail.loadTaskFailedHint') });
      return false;
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  function clearInlineAutosaveTimer() {
    if (inlineAutosaveTimerRef.current !== null) {
      window.clearTimeout(inlineAutosaveTimerRef.current);
      inlineAutosaveTimerRef.current = null;
    }
  }

  async function saveInlineDraft(trigger: 'manual' | 'autosave' | 'navigation' = 'manual') {
    if (!taskId || !selectedBlock || !inlineEditorCanSave) {
      return true;
    }
    if (inlineSavePromiseRef.current) {
      return inlineSavePromiseRef.current;
    }
    if (!inlineEditorDirty) {
      if (trigger !== 'autosave') {
        setInlineSaveIndicator('saved');
        setInlineSaveMessage(t('taskDetail.inlineEditorSaved'));
      }
      return true;
    }

    setInlineSaveIndicator('saving');
    setInlineSaveMessage(t('taskDetail.inlineEditorSaving'));

    const targetBlockId = selectedBlock.id;
    const nextValue = inlineDraft;
    const promise = (async () => {
      const result = await Client.updateBlock(taskId, targetBlockId, { translatedMarkdown: nextValue });
      if (!result.success) {
        throw new Error(result.error?.message || t('taskDetail.inlineEditorSaveFailed'));
      }
      setInlineSavedDraft(nextValue);
      setInlineLastSavedAt(new Date().toISOString());
      setInlineSaveIndicator('saved');
      setInlineSaveMessage(t('taskDetail.inlineEditorSaved'));
      setStatus((current) => {
        if (!current) {
          return current;
        }
        const applySavedBlock = (block: TaskPageBlock | any) =>
          block.id === targetBlockId
            ? {
                ...block,
                translatedMarkdown: nextValue,
                status: 'edited',
                errorMessage: '',
                reviewCandidateTranslation: '',
                reviewErrorMessage: '',
                reviewState: 'confirmed',
                lastEditedAt: new Date().toISOString()
              }
            : block;
        return {
          ...current,
          updatedAt: new Date().toISOString(),
          failedBlocks: current.failedBlocks.filter((item) => item.id !== targetBlockId),
          attentionBlocks: current.attentionBlocks.filter((item) => item.id !== targetBlockId),
          blocks: current.blocks?.map(applySavedBlock),
          pageBlocks: current.pageBlocks.map(applySavedBlock)
        };
      });
      return true;
    })()
      .catch((error: any) => {
        console.error(error);
        setInlineSaveIndicator('error');
        setInlineSaveMessage(error?.message || t('taskDetail.inlineEditorSaveFailed'));
        return false;
      })
      .finally(() => {
        inlineSavePromiseRef.current = null;
      });

    inlineSavePromiseRef.current = promise;
    return promise;
  }

  async function ensureInlineEditorReady() {
    if (!inlineEditorDirty) {
      return true;
    }
    clearInlineAutosaveTimer();
    return saveInlineDraft('navigation');
  }

  async function selectBlockForEditor(blockId: string) {
    if (!blockId || blockId === selectedBlockId) {
      return;
    }
    if (!(await ensureInlineEditorReady())) {
      return;
    }
    setSelectedBlockId(blockId);
  }

  async function changePage(nextPage: number) {
    if (!(await ensureInlineEditorReady())) {
      return;
    }
    setCurrentPage(nextPage);
  }

  async function changeViewMode(nextViewMode: ViewMode) {
    if (nextViewMode === viewMode) {
      return;
    }
    if (!(await ensureInlineEditorReady())) {
      return;
    }
    setViewMode(nextViewMode);
    if (nextViewMode === 'pagination') {
      setCurrentPage(1);
    } else {
      setScrollPagesLoaded(1);
    }
  }

  async function toggleReadingMode(nextValue: boolean) {
    if (nextValue === isFocusMode) {
      return;
    }
    if (!(await ensureInlineEditorReady())) {
      return;
    }
    setIsFocusMode(nextValue);
  }

  useEffect(() => {
    setCurrentPage(1);
    setScrollPagesLoaded(1);
    setSelectedBlockId(null);
  }, [taskId]);

  const exportJobs = useMemo(() => status?.exportJobs || [], [status]);
  const hasActiveExportJobs = exportJobs.some(isActiveExportJob);
  const pollingIntervalMs = hasActiveExportJobs ? 2000 : 5000;

  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    pollingStoppedRef.current = false;
    void fetchStatus(taskId, true);
    const interval = window.setInterval(() => {
      if (cancelled || pollingStoppedRef.current) return;
      void fetchStatus(taskId);
    }, pollingIntervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [taskId, currentPage, scrollPagesLoaded, viewMode, pollingIntervalMs]);

  useEffect(() => {
    if (!pendingFocusBlockId) return;
    const node = blockNodeRefs.current[pendingFocusBlockId];
    if (!node) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const timer = window.setTimeout(() => setPendingFocusBlockId(null), 250);
    return () => window.clearTimeout(timer);
  }, [pendingFocusBlockId, visibleBlocks]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.key === 'Escape') {
        setExportDialogOpen(false);
        setIsFocusMode(false);
        return;
      }
      if (exportDialogOpen) {
        return;
      }
      if (viewMode === 'pagination' && (event.key === 'ArrowLeft' || event.key === 'ArrowUp')) {
        void changePage(Math.max(1, currentPage - 1));
      } else if (viewMode === 'pagination' && (event.key === 'ArrowRight' || event.key === 'ArrowDown')) {
        void changePage(Math.min(totalPages, currentPage + 1));
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentPage, exportDialogOpen, totalPages, viewMode, inlineEditorDirty]);

  useEffect(() => {
    const handleResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (!visibleBlocks.length) {
      setSelectedBlockId(null);
      return;
    }
    if (pendingFocusBlockId && visibleBlocks.some((block) => block.id === pendingFocusBlockId)) {
      setSelectedBlockId(pendingFocusBlockId);
      return;
    }
    if (selectedBlockId && visibleBlocks.some((block) => block.id === selectedBlockId)) {
      return;
    }
    const nextSelected = visibleBlocks.find((block) => block.status === 'failed')?.id || visibleBlocks[0]?.id || null;
    setSelectedBlockId(nextSelected);
  }, [pendingFocusBlockId, selectedBlockId, visibleBlocks]);

  useEffect(() => {
    if (!selectedBlock) {
      inlineEditorHydratedBlockIdRef.current = null;
      setInlineDraft('');
      setInlineSavedDraft('');
      setInlineSaveIndicator('idle');
      setInlineSaveMessage('');
      return;
    }
    const nextDraft = resolveInlineEditorDraft(selectedBlock);
    const isSwitchingBlock = inlineEditorHydratedBlockIdRef.current !== selectedBlock.id;
    const shouldHydrate = isSwitchingBlock || !inlineEditorDirty;
    if (shouldHydrate) {
      setInlineDraft(nextDraft);
      setInlineSavedDraft(nextDraft);
      if (inlineSaveIndicator !== 'saving') {
        setInlineSaveIndicator('idle');
        setInlineSaveMessage('');
      }
    }
    inlineEditorHydratedBlockIdRef.current = selectedBlock.id;
  }, [
    selectedBlock,
    selectedBlock?.id,
    selectedBlock?.translatedMarkdown,
    selectedBlock?.reviewCandidateTranslation,
    selectedBlock?.sourceMarkdown,
    selectedBlock?.status,
    inlineEditorDirty,
    inlineSaveIndicator
  ]);

  useEffect(() => {
    clearInlineAutosaveTimer();
    if (!inlineEditorDirty || !inlineEditorCanSave || isFocusMode) {
      return;
    }
    inlineAutosaveTimerRef.current = window.setTimeout(() => {
      void saveInlineDraft('autosave');
    }, 1000);
    return () => clearInlineAutosaveTimer();
  }, [inlineDraft, inlineEditorCanSave, inlineEditorDirty, isFocusMode, selectedBlock?.id]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!inlineEditorDirty && !inlineSavePromiseRef.current) {
        return;
      }
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [inlineEditorDirty]);

  const failedBlocks = useMemo(() => status?.failedBlocks || [], [status]);
  const stats = useMemo(() => {
    if (!status?.summary) return { total: 0, translated: 0, failed: 0, pending: 0, percentage: 0 };
    const counts = status.summary.counts || {};
    const total = status.summary.translatableBlocks || 0;
    const translated = (counts.translated || 0) + (counts.edited || 0) + (counts.retranslated || 0);
    const failed = counts.failed || 0;
    const pending = Math.max(0, total - translated - failed);
    const percentage = total > 0 ? Math.round((translated / total) * 100) : 0;
    return { total, translated, failed, pending, percentage };
  }, [status]);

  const canExport = (status?.summary?.completedBlocks || 0) > 0;
  const firstVisibleErrorId = visibleBlocks.find((block) => block.status === 'failed')?.id || null;
  const activeBlockCount = status?.summary?.activeBlocks || 0;
  const railBlocks = failedBlocks.length > 0 ? failedBlocks : retryRailBlocks;
  const retryRailActive = retryRailBlocks.length > 0 && failedBlocks.length === 0 && (activeBlockCount > 0 || status?.stage === 'translating');
  const railCount = failedBlocks.length > 0 ? stats.failed : retryRailBlocks.length;
  const sidebarToolSlot = typeof document !== 'undefined' ? document.getElementById('sidebar-tool-slot') : null;
  const latestExportJob = exportJobs[0] || null;
  const latestExportCompletedAt = latestExportJob?.finishedAt || latestExportJob?.generatedAt || '';
  const canUseSidebarTools = !isFocusMode && viewportWidth >= 1280 && Boolean(sidebarToolSlot);
  const shouldRenderInlineTools = !isFocusMode && !canUseSidebarTools;
  const exportFamilies = useMemo(() => {
    const items: Array<{ family: ExportFamily; label: string; description: string }> = [
      {
        family: 'markdown',
        label: t('taskDetail.exportFamily.markdown'),
        description: t('taskDetail.exportFamily.markdownHint')
      },
      {
        family: 'pdf',
        label: t('taskDetail.exportFamily.pdf'),
        description: t('taskDetail.exportFamily.pdfHint')
      },
      {
        family: 'epub',
        label: t('taskDetail.exportFamily.epub'),
        description: t('taskDetail.exportFamily.epubHint')
      }
    ];
    return items;
  }, [t]);

  useEffect(() => {
    if (failedBlocks.length > 0) {
      setRetryRailBlocks(failedBlocks);
    }
  }, [failedBlocks]);

  useEffect(() => {
    if (!retryRailBlocks.length) return;
    if (failedBlocks.length > 0) return;
    if (activeBlockCount > 0 || status?.stage === 'translating') return;
    setRetryRailBlocks([]);
  }, [activeBlockCount, failedBlocks.length, retryRailBlocks.length, status?.stage]);

  async function runTaskAction(actionName: string, action: () => Promise<any>, stopPolling = false) {
    if (!taskId) return;
    setActionBusy(actionName);
    if (stopPolling) pollingStoppedRef.current = true;
    try {
      await action();
      await fetchStatus(taskId);
    } catch (error) {
      console.error(error);
      alert(t('taskDetail.actionFailed'));
    } finally {
      setActionBusy(null);
    }
  }

  async function handleStart() {
    pollingStoppedRef.current = false;
    await runTaskAction('start', () => Client.startTranslation(taskId!));
  }

  async function handleResume() {
    pollingStoppedRef.current = false;
    await runTaskAction('resume', () => Client.resumeTask(taskId!));
  }

  async function handlePause() {
    applyOptimisticTaskStage('paused');
    await runTaskAction('pause', () => Client.pauseTask(taskId!), true);
  }

  async function handleCancel() {
    if (!window.confirm(t('taskDetail.cancelConfirm'))) return;
    applyOptimisticTaskStage('cancelled');
    await runTaskAction('cancel', () => Client.cancelTask(taskId!), true);
  }

  async function handleRetranslate(blockId: string) {
    if (!taskId) return;
    setActionBusy(`retranslate:${blockId}`);
    pollingStoppedRef.current = false;
    try {
      await Client.retranslateBlock(taskId, blockId, { retranslationGoal: 'better', focus: 'auto' });
      await fetchStatus(taskId);
    } catch (error) {
      console.error(error);
      alert(t('taskDetail.retranslateOneFailed'));
    } finally {
      setActionBusy(null);
    }
  }

  async function handleRetranslateFailed() {
    if (!taskId || !status?.failedBlocks?.length) return;
    const failedIds = status.failedBlocks.map((block) => block.id);
    if (!failedIds.length) return;
    setRetryRailBlocks(status.failedBlocks);
    setActionBusy('retry-failed');
    pollingStoppedRef.current = false;
    try {
      await Client.retranslateBlocksBatch(taskId, { blockIds: failedIds, retranslationGoal: 'more_accurate', focus: 'auto' });
      await fetchStatus(taskId);
    } catch (error) {
      console.error(error);
      alert(t('taskDetail.retranslateBatchFailed'));
    } finally {
      setActionBusy(null);
    }
  }

  async function handleReviewAction(blockId: string, reviewState: 'confirmed' | 'ignored') {
    if (!taskId) return;
    setActionBusy(`review:${reviewState}:${blockId}`);
    try {
      await Client.updateBlock(taskId, blockId, { reviewState });
      await fetchStatus(taskId);
    } catch (error) {
      console.error(error);
      alert(reviewState === 'confirmed' ? t('taskDetail.confirmFailed') : t('taskDetail.ignoreFailed'));
    } finally {
      setActionBusy(null);
    }
  }

  function resolveExportRequest(family: ExportFamily, layout: ExportLayout) {
    if (family === 'markdown') {
      return { format: layout === 'bilingual' ? 'markdown_bilingual' : 'markdown' };
    }
    if (family === 'pdf') {
      return {
        format: layout === 'bilingual' ? 'pdf_bilingual' : 'pdf',
        layout
      };
    }
    return {
      format: layout === 'bilingual' ? 'epub_bilingual' : 'epub',
      layout
    };
  }

  async function handleExportSubmit() {
    if (!taskId) return;
    try {
      const payload = resolveExportRequest(selectedExportFamily, selectedExportLayout);
      const result = await Client.createExportJob(taskId, payload);
      if (!result.success || !result.data?.job) {
        throw new Error(result.error?.message || t('taskDetail.exportFailed'));
      }
      persistExportPreferences({
        family: selectedExportFamily,
        layout: selectedExportLayout,
        autoDownload: exportAutoDownload
      });
      setPendingDownloadJobId(exportAutoDownload ? result.data.job.id : null);
      setExportDialogOpen(false);
      await fetchStatus(taskId);
    } catch (error: any) {
      console.error(error);
      alert(error?.message || t('taskDetail.exportFailed'));
    }
  }

  async function handleExportJobDownload(job: ExportJobStatus) {
    if (!taskId) return;
    const { blob, filename } = await Client.downloadExportJob(taskId, job.id);
    const objectUrl = window.URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename || job.filename || `${taskId}-${job.id}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => window.URL.revokeObjectURL(objectUrl), 1000);
  }

  useEffect(() => {
    if (!pendingDownloadJobId || !taskId) return;
    const job = exportJobs.find((candidate) => candidate.id === pendingDownloadJobId);
    if (!job) return;

    if (job.status === 'failed') {
      setPendingDownloadJobId(null);
      alert(job.errorMessage || t('taskDetail.exportFailed'));
      return;
    }

    if (job.status === 'completed' && job.canDownload) {
      setPendingDownloadJobId(null);
      void handleExportJobDownload(job).catch((error) => {
        console.error(error);
        alert(error?.message || t('taskDetail.exportFailed'));
      });
    }
  }, [pendingDownloadJobId, exportJobs, taskId]);

  function getExportLabel(format: string) {
    if (format === 'markdown') return t('taskDetail.export.markdown');
    if (format === 'markdown_bilingual') return t('taskDetail.export.markdown_bilingual');
    if (format === 'pdf') return t('taskDetail.export.pdf');
    if (format === 'pdf_bilingual') return t('taskDetail.export.pdf_bilingual');
    if (format === 'epub') return t('taskDetail.export.epub');
    if (format === 'epub_bilingual') return t('taskDetail.export.epub_bilingual');
    return format;
  }

  function getExportStatusLabel(job: ExportJobStatus) {
    if (job.stale) return t('taskDetail.exportStatus.stale');
    return t(`taskDetail.exportStatus.${job.status}`);
  }

  function getExportStageLabel(job: ExportJobStatus) {
    return t(`taskDetail.exportStage.${job.progress.stage}`);
  }

  async function jumpToError(direction: 'prev' | 'next') {
    if (!railBlocks.length || !status) return;
    if (!(await ensureInlineEditorReady())) {
      return;
    }
    const currentId = firstVisibleErrorId;
    let currentIndex = railBlocks.findIndex((block) => block.id === currentId);
    if (currentIndex < 0) currentIndex = direction === 'next' ? -1 : railBlocks.length;
    const nextIndex = direction === 'next' ? Math.min(railBlocks.length - 1, currentIndex + 1) : Math.max(0, currentIndex - 1);
    const targetBlock = railBlocks[nextIndex];
    if (!targetBlock) return;
    setPendingFocusBlockId(targetBlock.id);
    setSelectedBlockId(targetBlock.id);
    if (viewMode === 'pagination') {
      setCurrentPage(Math.floor(targetBlock.order / PAGE_SIZE) + 1);
    } else {
      setScrollPagesLoaded((current) => Math.max(current, Math.floor(targetBlock.order / PAGE_SIZE) + 1));
    }
  }

  function handleLoadMore() {
    if (!taskId || viewMode !== 'scroll' || scrollPagesLoaded >= totalPages) return;
    setScrollPagesLoaded((current) => current + 1);
  }

  function renderPrimaryAction() {
    if (!status) return null;
    if (status.stage === 'parsed') {
      return (
        <button className="glass-button primary" onClick={handleStart} disabled={actionBusy !== null}>
          <PlayCircle size={16} /> {t('taskDetail.startFull')}
        </button>
      );
    }
    if (status.stage === 'paused') {
      return (
        <button className="glass-button primary" onClick={handleResume} disabled={actionBusy !== null}>
          <PlayCircle size={16} /> {t('taskDetail.resume')}
        </button>
      );
    }
    if (status.stage === 'cancelled') {
      return (
        <button className="glass-button primary" onClick={handleStart} disabled={actionBusy !== null}>
          <PlayCircle size={16} /> {t('taskDetail.restartRemaining')}
        </button>
      );
    }
    return null;
  }

  function renderTargetContent(block: TaskPageBlock): { content: ReactNode; color: string; borderLeft: string } {
    const candidateTranslation = block.reviewCandidateTranslation || '';
    const reviewState = block.reviewState || 'none';
    const blockErrorMessage = formatProviderAwareErrorMessage(block.errorMessage, status?.providerLabel || '');
    const candidateContainsInternalPlaceholders = hasEpubInternalPlaceholders(candidateTranslation);

    if (!block.shouldTranslate) {
      return {
        content: block.sourceMarkdown,
        color: 'var(--text-secondary)',
        borderLeft: '3px solid var(--shadow-dark)'
      };
    }

    if (block.status === 'failed') {
      return {
        content: reviewState === 'ignored'
          ? block.sourceMarkdown
          : candidateContainsInternalPlaceholders
            ? blockErrorMessage || t('taskDetail.epubInternalPlaceholderFailed')
            : candidateTranslation || blockErrorMessage || t('taskDetail.translationFailed'),
        color: reviewState === 'ignored' ? 'var(--warning-color)' : 'var(--danger-color)',
        borderLeft: reviewState === 'ignored' ? '3px solid var(--warning-color)' : '3px solid var(--danger-color)'
      };
    }

    if (COMPLETED_STATUSES.has(block.status)) {
      return {
        content: block.translatedMarkdown || '...',
        color: 'var(--success-color)',
        borderLeft: '3px solid rgba(16, 185, 129, 0.35)'
      };
    }

    if (block.status === 'paused') {
      return {
        content: <em style={{ opacity: 0.7 }}>{t('taskDetail.paused')}</em>,
        color: 'var(--warning-color)',
        borderLeft: '3px solid var(--warning-color)'
      };
    }

    if (block.status === 'cancelled') {
      return {
        content: <em style={{ opacity: 0.7 }}>{t('taskDetail.cancelled')}</em>,
        color: 'var(--text-secondary)',
        borderLeft: '3px solid var(--shadow-dark)'
      };
    }

    if (block.status === 'queued') {
      return {
        content: <em style={{ opacity: 0.7 }}>{t('taskDetail.queued')}</em>,
        color: 'var(--warning-color)',
        borderLeft: '3px solid var(--warning-color)'
      };
    }

    if (block.status === 'translating') {
      return {
        content: <em style={{ opacity: 0.7 }}>{t('taskDetail.translating')}</em>,
        color: 'var(--warning-color)',
        borderLeft: '3px solid var(--warning-color)'
      };
    }

    return {
      content: <em style={{ opacity: 0.55 }}>{t('taskDetail.waiting')}</em>,
      color: 'var(--text-primary)',
      borderLeft: 'none'
    };
  }

  if (loading) return <div style={{ padding: '2rem', textAlign: 'center' }}>{t('taskDetail.loading')}</div>;
  if (viewError?.code === 'task_not_found') return <TaskErrorState title={t('taskDetail.notFoundTitle')} message={viewError.message} />;
  if (viewError && !status) return <TaskErrorState title={t('taskDetail.loadFailedTitle')} message={viewError.message} />;
  if (!status) return <div style={{ padding: '2rem', textAlign: 'center' }}>{t('taskDetail.emptyState')}</div>;

  const exportQueueWidget = (
    <div
      className="glass-panel"
      style={{
        padding: '1rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.8rem'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 700 }}>{t('taskDetail.exportQueueTitle')}</div>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '0.2rem', lineHeight: 1.5 }}>
            {pendingDownloadJobId ? t('taskDetail.exportAutoDownloadWaiting') : t('taskDetail.exportQueueHint')}
          </div>
        </div>
        <button className="glass-button primary" onClick={() => setExportDialogOpen(true)} disabled={!canExport}>
          <Download size={15} /> {t('taskDetail.exportOpenDialog')}
        </button>
      </div>
      {latestExportJob ? (
        <>
          <div style={{ padding: '0.9rem', borderRadius: '12px', background: 'var(--shadow-light)', boxShadow: 'var(--neu-shadow-inset)', display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontWeight: 700 }}>{getExportLabel(latestExportJob.format)}</div>
                <div style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', marginTop: '0.2rem', lineHeight: 1.5 }}>
                  {getExportStatusLabel(latestExportJob)} · {new Date(latestExportJob.createdAt).toLocaleTimeString(dateLocale)}
                </div>
              </div>
              <span
                style={{
                  padding: '0.2rem 0.6rem',
                  borderRadius: '999px',
                  fontSize: '0.78rem',
                  fontWeight: 700,
                  color: latestExportJob.status === 'failed'
                    ? 'var(--danger-color)'
                    : latestExportJob.canDownload
                      ? 'var(--success-color)'
                      : 'var(--primary-color)',
                  background: latestExportJob.status === 'failed'
                    ? 'rgba(239, 68, 68, 0.14)'
                    : latestExportJob.canDownload
                      ? 'rgba(16, 185, 129, 0.14)'
                      : 'rgba(96, 165, 250, 0.14)'
                }}
              >
                {getExportStageLabel(latestExportJob)}
              </span>
            </div>
            <div style={{ height: '8px', borderRadius: '999px', background: 'rgba(148, 163, 184, 0.18)', overflow: 'hidden' }}>
              <div
                style={{
                  width: `${latestExportJob.progress.percent}%`,
                  height: '100%',
                  background: latestExportJob.status === 'failed' ? 'var(--danger-color)' : 'var(--primary-color)',
                  transition: 'width 0.3s ease'
                }}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap', color: 'var(--text-secondary)', fontSize: '0.82rem', lineHeight: 1.5 }}>
              <span>{latestExportJob.progress.percent}%</span>
              {latestExportJob.progress.detail ? <span>{latestExportJob.progress.detail}</span> : null}
              {latestExportJob.errorMessage ? <span className="text-danger">{latestExportJob.errorMessage}</span> : null}
              {latestExportJob.stale ? <span>{t('taskDetail.exportStaleHint')}</span> : null}
            </div>
            {(latestExportCompletedAt || latestExportJob.sizeBytes > 0) && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.65rem' }}>
                {latestExportCompletedAt ? (
                  <div style={{ padding: '0.7rem 0.8rem', borderRadius: '10px', background: 'rgba(255,255,255,0.45)', boxShadow: 'var(--neu-shadow-inset)' }}>
                    <div style={{ fontSize: '0.74rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.02em' }}>
                      {t('taskDetail.exportFinishedAt')}
                    </div>
                    <div style={{ marginTop: '0.25rem', fontSize: '0.88rem', fontWeight: 600 }}>
                      {formatExportDateTime(latestExportCompletedAt, dateLocale)}
                    </div>
                  </div>
                ) : null}
                {latestExportJob.sizeBytes > 0 ? (
                  <div style={{ padding: '0.7rem 0.8rem', borderRadius: '10px', background: 'rgba(255,255,255,0.45)', boxShadow: 'var(--neu-shadow-inset)' }}>
                    <div style={{ fontSize: '0.74rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.02em' }}>
                      {t('taskDetail.exportFileSize')}
                    </div>
                    <div style={{ marginTop: '0.25rem', fontSize: '0.88rem', fontWeight: 600 }}>
                      {formatBytes(latestExportJob.sizeBytes)}
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </div>
          {latestExportJob.canDownload && (
            <button className="glass-button primary" onClick={() => void handleExportJobDownload(latestExportJob)} style={{ width: '100%', justifyContent: 'flex-start' }}>
              <Download size={16} /> {t('taskDetail.exportDownload')}
            </button>
          )}
        </>
      ) : (
        <div style={{ color: 'var(--text-secondary)', fontSize: '0.88rem', lineHeight: 1.6 }}>
          {t('taskDetail.exportQueueEmpty')}
        </div>
      )}
    </div>
  );

  const errorRail = (
    <div
      className="glass-panel"
      style={{
        padding: '1rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.75rem'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', fontWeight: 700 }}>
        <AlertTriangle size={18} className={railCount > 0 ? 'text-danger' : 'text-primary'} />
        <span>{t('taskDetail.errorRailTitle')}</span>
      </div>
      <div
        style={{
          padding: '0.85rem 0.95rem',
          borderRadius: '12px',
          background: 'var(--shadow-light)',
          boxShadow: 'var(--neu-shadow-inset)',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.45rem'
        }}
      >
        <div style={{ fontWeight: 700, color: railCount > 0 ? 'var(--danger-color)' : 'var(--primary-color)' }}>
          {retryRailActive ? t('common.processing') : railCount > 0 ? t('taskDetail.failed', { count: railCount }) : t('taskDetail.errorRailClear')}
        </div>
        <div style={{ color: 'var(--text-secondary)', fontSize: '0.84rem', lineHeight: 1.55 }}>
          {railCount > 0 || retryRailActive ? t('taskDetail.errorRailHint') : t('taskDetail.errorRailPersistHint')}
        </div>
      </div>
      <button className="glass-button" onClick={() => void jumpToError('prev')} disabled={railBlocks.length === 0} style={{ width: '100%', justifyContent: 'flex-start' }}>
        <ChevronLeft size={16} /> {t('taskDetail.prevError')}
      </button>
      <button className="glass-button" onClick={() => void jumpToError('next')} disabled={railBlocks.length === 0} style={{ width: '100%', justifyContent: 'flex-start' }}>
        <ChevronRight size={16} /> {t('taskDetail.nextError')}
      </button>
      <button className="glass-button" onClick={handleRetranslateFailed} disabled={actionBusy !== null || failedBlocks.length === 0} style={{ width: '100%', justifyContent: 'flex-start' }}>
        <RefreshCw size={16} /> {t('taskDetail.retryAll')}
      </button>
    </div>
  );

  const utilityPanels = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {exportQueueWidget}
      {errorRail}
    </div>
  );

  const inlineEditorPanel = !isFocusMode && selectedBlock ? (
    <div
      className="glass-panel"
      style={{
        padding: '1rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.85rem',
        alignSelf: 'flex-start',
        position: inlineEditorSideBySide ? 'sticky' : 'static',
        top: inlineEditorSideBySide ? '1rem' : undefined
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 700 }}>
            {t('taskDetail.inlineEditorTitle')} #{selectedBlock.order + 1}
          </div>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.84rem', marginTop: '0.2rem', lineHeight: 1.55 }}>
            {selectedBlock.headingPath?.length ? selectedBlock.headingPath.join(' / ') : t('taskEditor.noHeading')}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ color: selectedBlock.status === 'failed' ? 'var(--danger-color)' : 'var(--text-secondary)', fontSize: '0.85rem', fontWeight: 600 }}>
          {tBlockStatus(selectedBlock.status)}
        </span>
        {inlineEditorDirty ? (
          <span style={{ color: 'var(--warning-color)', fontSize: '0.82rem', fontWeight: 700 }}>
            {t('taskDetail.inlineEditorDirty')}
          </span>
        ) : null}
        {selectedBlock.reviewState === 'pending_confirmation' ? (
          <span style={{ color: 'var(--warning-color)', fontSize: '0.82rem', fontWeight: 700 }}>
            {t('taskEditor.pendingReviewHint')}
          </span>
        ) : null}
      </div>

      <div style={{ borderRadius: '12px', boxShadow: 'var(--neu-shadow-inset)', padding: '0.85rem 0.95rem', display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
        <div style={{ fontWeight: 700, fontSize: '0.88rem' }}>{t('taskDetail.inlineEditorSource')}</div>
        <div style={{ color: 'var(--text-primary)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word', lineHeight: 1.75, maxHeight: inlineEditorSideBySide ? '16rem' : '12rem', overflowY: 'auto' }}>
          {selectedBlock.sourceMarkdown}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ fontWeight: 700, fontSize: '0.88rem' }}>{t('taskDetail.inlineEditorTranslation')}</div>
          <div style={{ color: inlineSaveIndicator === 'error' ? 'var(--danger-color)' : inlineEditorDirty ? 'var(--warning-color)' : 'var(--text-secondary)', fontSize: '0.82rem', fontWeight: 600 }}>
            {inlineSaveMessage
              || (inlineEditorDirty
                ? t('taskDetail.inlineEditorDirty')
                : inlineLastSavedAt
                  ? t('taskDetail.inlineEditorSavedAt', { time: new Date(inlineLastSavedAt).toLocaleTimeString(dateLocale) })
                  : t('taskDetail.inlineEditorIdle'))}
          </div>
        </div>
        {inlineEditorCanSave ? (
          <textarea
            className="glass-input"
            value={inlineDraft}
            onChange={(event) => {
              setInlineDraft(event.target.value);
              if (inlineSaveIndicator === 'error') {
                setInlineSaveIndicator('idle');
                setInlineSaveMessage('');
              }
            }}
            placeholder={t('taskEditor.translationPlaceholder')}
            style={{
              minHeight: inlineEditorSideBySide ? '18rem' : '14rem',
              resize: 'vertical',
              lineHeight: 1.8,
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere'
            }}
          />
        ) : (
          <div
            style={{
              borderRadius: '10px',
              boxShadow: 'var(--neu-shadow-inset)',
              padding: '0.9rem 1rem',
              color: 'var(--text-secondary)',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              lineHeight: 1.8,
              minHeight: '8rem'
            }}
          >
            {selectedBlock.shouldTranslate ? t('taskEditor.blockBusy') : t('taskDetail.inlineEditorReadOnly')}
          </div>
        )}
      </div>

      {selectedBlockCandidateContainsInternalPlaceholders ? (
        <div style={{ color: 'var(--warning-color)', fontSize: '0.84rem', lineHeight: 1.65 }}>
          {t('taskEditor.placeholderHint')}
        </div>
      ) : null}
      {selectedBlockErrorMessage ? (
        <div style={{ color: 'var(--danger-color)', fontSize: '0.84rem', lineHeight: 1.65 }}>
          {selectedBlockErrorMessage}
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: '0.55rem', flexWrap: 'wrap' }}>
        <button className="glass-button primary" onClick={() => void saveInlineDraft('manual')} disabled={!inlineEditorCanSave || !inlineEditorDirty || inlineSaveIndicator === 'saving'}>
          <Save size={15} /> {t('taskDetail.inlineEditorSave')}
        </button>
        <button className="glass-button" onClick={() => void handleRetranslate(selectedBlock.id)} disabled={actionBusy !== null || !selectedBlock.shouldTranslate}>
          <RefreshCw size={15} /> {t('common.retry')}
        </button>
        <button className="glass-button" onClick={() => void handleReviewAction(selectedBlock.id, 'confirmed')} disabled={actionBusy !== null || !selectedBlockCanConfirmCandidate}>
          {t('common.confirm')}
        </button>
        <button className="glass-button" onClick={() => void handleReviewAction(selectedBlock.id, 'ignored')} disabled={actionBusy !== null || !selectedBlock.shouldTranslate}>
          {t('common.ignore')}
        </button>
      </div>
    </div>
  ) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', height: '100%' }}>
      {canUseSidebarTools && sidebarToolSlot ? createPortal(utilityPanels, sidebarToolSlot) : null}
      {!isFocusMode && (
        <>
          <div className="glass-panel" style={{ padding: '2rem', display: 'flex', flexWrap: 'wrap', gap: '2rem', alignItems: 'stretch' }}>
            <div style={{ flex: '1 1 720px', minWidth: '320px', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div>
                  <h1 style={{ fontSize: '1.8rem', fontWeight: 700, margin: 0 }}>{status.filename}</h1>
                  <div style={{ marginTop: '0.75rem', color: 'var(--text-secondary)', display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                    <span
                      className={status.stage === 'review_ready' ? 'text-success' : 'text-warning'}
                      style={{
                        padding: '4px 12px',
                        borderRadius: '999px',
                        background: status.stage === 'review_ready' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(245, 158, 11, 0.15)',
                        fontWeight: 600,
                        fontSize: '0.9rem'
                      }}
                    >
                      {tTaskStage(status.stage)}
                    </span>
                    <span style={{ fontSize: '0.9rem' }}>{status.documentFormat.toUpperCase()}</span>
                    <span style={{ fontSize: '0.9rem' }}>
                      {t('taskDetail.lastUpdated', { time: new Date(status.updatedAt).toLocaleTimeString(dateLocale) })}
                    </span>
                  </div>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', justifyContent: 'flex-end', alignItems: 'center' }}>
                  {status.stage === 'translating' && (
                    <>
                      <button className="glass-button" onClick={handlePause} disabled={actionBusy !== null}>
                        <Pause size={16} /> {t('common.pause')}
                      </button>
                      <button className="glass-button" onClick={handleCancel} disabled={actionBusy !== null} style={{ color: 'var(--danger-color)' }}>
                        <XCircle size={16} /> {t('common.cancel')}
                      </button>
                    </>
                  )}
                  {renderPrimaryAction()}
                  {latestExportJob && (
                    <span
                      style={{
                        padding: '0.35rem 0.7rem',
                        borderRadius: '999px',
                        fontSize: '0.8rem',
                        fontWeight: 700,
                        color: latestExportJob.status === 'failed'
                          ? 'var(--danger-color)'
                          : latestExportJob.canDownload
                            ? 'var(--success-color)'
                            : 'var(--primary-color)',
                        background: latestExportJob.status === 'failed'
                          ? 'rgba(239, 68, 68, 0.14)'
                          : latestExportJob.canDownload
                            ? 'rgba(16, 185, 129, 0.14)'
                            : 'rgba(96, 165, 250, 0.14)'
                      }}
                    >
                      {getExportStageLabel(latestExportJob)}
                    </span>
                  )}
                  <button className="glass-button primary" onClick={() => setExportDialogOpen(true)} disabled={!canExport}>
                    <Download size={16} /> {t('taskDetail.exportOpenDialog')}
                  </button>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '1rem', background: 'var(--shadow-light)', padding: '1.2rem', borderRadius: '12px', boxShadow: 'var(--neu-shadow-inset)' }}>
                <div>
                  <span style={{ fontSize: '0.8rem', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>{t('taskDetail.words')}</span>
                  <strong style={{ display: 'block', fontSize: '1.3rem' }}>{status.summary?.translatedWordCount || 0} / {status.summary?.sourceWordCount || 0}</strong>
                </div>
                <div>
                  <span style={{ fontSize: '0.8rem', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>{t('taskDetail.speed')}</span>
                  <strong style={{ display: 'block', fontSize: '1.3rem' }}>
                    {status.summary?.translationSpeed || 0} <span style={{ fontSize: '0.8rem' }}>{t('common.wps')}</span>
                  </strong>
                </div>
                <div>
                  <span style={{ fontSize: '0.8rem', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>{t('taskDetail.estWait')}</span>
                  <strong style={{ display: 'block', fontSize: '1.3rem' }}>
                    {status.summary?.estimatedTimeRemaining ? `${status.summary.estimatedTimeRemaining}s` : t('common.notAvailableShort')}
                  </strong>
                </div>
                <div>
                  <span style={{ fontSize: '0.8rem', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>{t('taskDetail.activeWorkers')}</span>
                  <strong style={{ display: 'block', fontSize: '1.3rem', color: 'var(--primary-color)' }}>{status.summary?.activeBlocks || 0}</strong>
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', minWidth: '260px' }}>
              <div style={{ width: '110px', height: '110px', borderRadius: '50%', background: `conic-gradient(var(--primary-color) ${stats.percentage}%, var(--bg-color-solid) 0)`, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: 'var(--neu-shadow)' }}>
                <div style={{ width: '90px', height: '90px', borderRadius: '50%', background: 'var(--bg-color-solid)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '1.5rem', color: 'var(--primary-color)', boxShadow: 'var(--neu-shadow-inset)' }}>
                  {stats.percentage}%
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', fontSize: '1rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', fontWeight: 600 }}>
                  <CheckCircle size={20} className="text-success" />
                  <span>{t('taskDetail.completed', { count: stats.translated })}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', fontWeight: 600 }}>
                  <Loader2 size={20} className={stats.pending > 0 ? 'text-primary' : 'text-secondary'} style={{ animation: stats.pending > 0 ? 'spin 2s linear infinite' : 'none' }} />
                  <span>{t('taskDetail.pending', { count: stats.pending })}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', fontWeight: 600, flexWrap: 'wrap' }}>
                  <AlertTriangle size={20} className="text-danger" />
                  <span>{retryRailActive ? t('common.processing') : t('taskDetail.failed', { count: railCount || stats.failed })}</span>
                </div>
              </div>
            </div>
          </div>
          {shouldRenderInlineTools && utilityPanels}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem', background: 'var(--bg-color-solid)', borderRadius: '12px', boxShadow: 'var(--neu-shadow-sm)', flexWrap: 'wrap', gap: '1rem' }}>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button className={`glass-button ${displayMode === 'compare' ? 'primary' : ''}`} onClick={() => setDisplayMode('compare')} style={{ padding: '0.4rem 1rem' }}>
                {t('taskDetail.displayCompare')}
              </button>
              <button className={`glass-button ${displayMode === 'source' ? 'primary' : ''}`} onClick={() => setDisplayMode('source')} style={{ padding: '0.4rem 1rem' }}>
                {t('taskDetail.displaySource')}
              </button>
              <button className={`glass-button ${displayMode === 'target' ? 'primary' : ''}`} onClick={() => setDisplayMode('target')} style={{ padding: '0.4rem 1rem' }}>
                {t('taskDetail.displayTarget')}
              </button>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button className={`glass-button ${viewMode === 'pagination' ? 'primary' : ''}`} onClick={() => void changeViewMode('pagination')} style={{ padding: '0.4rem 1rem' }}>
                {t('taskDetail.viewPagination')}
              </button>
              <button className={`glass-button ${viewMode === 'scroll' ? 'primary' : ''}`} onClick={() => void changeViewMode('scroll')} style={{ padding: '0.4rem 1rem' }}>
                {t('taskDetail.viewScroll')}
              </button>
              <button className="glass-button" onClick={() => void toggleReadingMode(true)} style={{ padding: '0.4rem 1rem' }}>
                <Maximize size={16} style={{ verticalAlign: 'middle', marginRight: '0.35rem' }} /> {t('taskDetail.focusMode')}
              </button>
            </div>
          </div>
        </>
      )}
      <div
        style={
          isFocusMode
            ? { position: 'relative', flex: 1, minHeight: 0 }
            : inlineEditorSideBySide
              ? { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 420px', gap: '1rem', alignItems: 'start', flex: 1, minHeight: 0 }
              : { display: 'flex', flexDirection: 'column', gap: '1rem', flex: 1, minHeight: 0 }
        }
      >
        <div
          className={isFocusMode ? '' : 'glass-panel'}
          style={
            isFocusMode
              ? { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 999999, background: 'var(--bg-color-solid, var(--bg-color))', overflowY: 'auto', padding: '4rem 12%', display: 'flex', flexDirection: 'column' }
              : { display: 'flex', flexDirection: 'column', padding: '2.5rem', overflowY: 'auto', minHeight: 0 }
          }
        >
          {isFocusMode && (
            <button onClick={() => void toggleReadingMode(false)} className="glass-button" style={{ position: 'fixed', top: '1rem', right: '1.5rem', zIndex: 10000, padding: '0.6rem 1.2rem' }}>
              <Minimize size={16} style={{ verticalAlign: 'middle', marginRight: '0.35rem' }} /> {t('taskDetail.exitFocusMode')}
            </button>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.75rem', fontSize: isFocusMode ? '1.2rem' : '1.05rem', lineHeight: 1.8 }}>
            {visibleBlocks.map((block) => {
              const candidateTranslation = block.reviewCandidateTranslation || '';
              const reviewState = block.reviewState || 'none';
              const canConfirmCandidate = reviewState === 'pending_confirmation' && Boolean(candidateTranslation);
              const candidateContainsInternalPlaceholders = hasEpubInternalPlaceholders(candidateTranslation);
              const blockErrorMessage = formatProviderAwareErrorMessage(block.errorMessage, status.providerLabel);
              const { content, color, borderLeft } = renderTargetContent(block);
              const isSelected = !isFocusMode && selectedBlockId === block.id;

              return (
                <div
                  key={block.id}
                  ref={(node) => { blockNodeRefs.current[block.id] = node; }}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.5rem',
                    minWidth: 0,
                    maxWidth: '100%',
                    borderRadius: '14px',
                    padding: !isFocusMode && isSelected ? '0.8rem 1rem' : !isFocusMode ? '0.55rem 0.7rem' : 0,
                    background: !isFocusMode && isSelected ? 'rgba(96, 165, 250, 0.12)' : !isFocusMode ? 'rgba(255,255,255,0.03)' : 'transparent',
                    boxShadow: !isFocusMode && isSelected ? 'var(--neu-shadow-inset)' : 'none',
                    cursor: !isFocusMode ? 'pointer' : 'default',
                    transition: 'background 0.2s ease, box-shadow 0.2s ease'
                  }}
                  onClick={() => {
                    if (!isFocusMode) {
                      void selectBlockForEditor(block.id);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (isFocusMode) {
                      return;
                    }
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      void selectBlockForEditor(block.id);
                    }
                  }}
                  role={isFocusMode ? undefined : 'button'}
                  tabIndex={isFocusMode ? -1 : 0}
                  aria-pressed={isFocusMode ? undefined : isSelected}
                >
                  {(displayMode === 'compare' || displayMode === 'source') && (
                    <div style={{ color: 'var(--text-primary)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word', maxWidth: '100%' }}>
                      {block.sourceMarkdown}
                    </div>
                  )}
                  {(displayMode === 'compare' || displayMode === 'target') && (
                    <div
                      style={{
                        color,
                        borderLeft,
                        paddingLeft: '1rem',
                        whiteSpace: 'pre-wrap',
                        overflowWrap: 'anywhere',
                        wordBreak: 'break-word',
                        maxWidth: '100%',
                        minWidth: 0,
                        overflowX: 'auto',
                        background: displayMode === 'compare' ? 'rgba(0,0,0,0.02)' : 'transparent',
                        borderRadius: '0 8px 8px 0',
                        paddingTop: displayMode === 'compare' ? '0.5rem' : 0,
                        paddingBottom: displayMode === 'compare' ? '0.5rem' : 0
                      }}
                    >
                      {content}
                      {block.status === 'failed' && blockErrorMessage && <div style={{ marginTop: '0.5rem', fontSize: '0.9rem', opacity: 0.9 }}>{blockErrorMessage}</div>}
                      {block.status === 'failed' && candidateTranslation && !canConfirmCandidate && !candidateContainsInternalPlaceholders && (
                        <div style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                          {t('taskDetail.rawCandidateHint')}
                        </div>
                      )}
                      {block.status === 'failed' && candidateTranslation && !canConfirmCandidate && candidateContainsInternalPlaceholders && (
                        <details style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                          <summary style={{ cursor: 'pointer' }} onClick={(event) => event.stopPropagation()}>{t('taskDetail.internalPlaceholderCandidate')}</summary>
                          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word', maxHeight: '12rem', overflow: 'auto', margin: '0.5rem 0 0', padding: '0.75rem', borderRadius: '10px', background: 'rgba(15, 23, 42, 0.08)' }}>
                            {candidateTranslation}
                          </pre>
                        </details>
                      )}
                      {block.status === 'failed' && (
                        <div style={{ display: 'inline-flex', gap: '0.5rem', flexWrap: 'wrap', marginLeft: '1rem', verticalAlign: 'middle' }}>
                          <button onClick={(event) => { event.stopPropagation(); void handleReviewAction(block.id, 'confirmed'); }} disabled={actionBusy !== null || !canConfirmCandidate} style={{ background: 'transparent', border: '1px solid var(--success-color)', borderRadius: '6px', color: 'var(--success-color)', cursor: 'pointer', padding: '2px 8px', fontSize: '0.8rem' }}>
                            {t('common.confirm')}
                          </button>
                          <button onClick={(event) => { event.stopPropagation(); void handleReviewAction(block.id, 'ignored'); }} disabled={actionBusy !== null} style={{ background: 'transparent', border: '1px solid var(--warning-color)', borderRadius: '6px', color: 'var(--warning-color)', cursor: 'pointer', padding: '2px 8px', fontSize: '0.8rem' }}>
                            {t('common.ignore')}
                          </button>
                          <button onClick={(event) => { event.stopPropagation(); void handleRetranslate(block.id); }} disabled={actionBusy !== null} style={{ background: 'transparent', border: '1px solid var(--danger-color)', borderRadius: '6px', color: 'var(--danger-color)', cursor: 'pointer', padding: '2px 8px', fontSize: '0.8rem' }}>
                            {t('common.retry')}
                          </button>
                        </div>
                      )}
                      {block.status === 'failed' && reviewState === 'ignored' && (
                        <div style={{ marginTop: '0.5rem', fontSize: '0.85rem', opacity: 0.85 }}>{t('common.ignore')}</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {viewMode === 'pagination' && totalPages > 1 && (
              <div style={{ display: 'flex', justifyContent: 'center', gap: '1rem', marginTop: '1rem', paddingTop: '1.5rem', borderTop: '2px solid var(--shadow-light)', alignItems: 'center' }}>
                <button className="glass-button" disabled={currentPage === 1} onClick={() => void changePage(Math.max(1, currentPage - 1))} style={{ padding: '0.6rem 1.25rem' }}>
                  {t('taskDetail.previousPage')}
                </button>
                <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>{currentPage} / {totalPages}</span>
                <button className="glass-button primary" disabled={currentPage === totalPages} onClick={() => void changePage(Math.min(totalPages, currentPage + 1))} style={{ padding: '0.6rem 1.25rem' }}>
                  {t('taskDetail.nextPage')}
                </button>
              </div>
            )}
            {viewMode === 'scroll' && scrollPagesLoaded < totalPages && (
              <div style={{ display: 'flex', justifyContent: 'center', marginTop: '1rem', paddingTop: '1.5rem', borderTop: '2px solid var(--shadow-light)' }}>
                <button className="glass-button primary" onClick={handleLoadMore} disabled={actionBusy !== null} style={{ padding: '0.75rem 1.5rem' }}>
                  {t('taskDetail.loadMore', { current: scrollPagesLoaded, total: totalPages })}
                </button>
              </div>
            )}
          </div>
        </div>
        {inlineEditorSideBySide ? inlineEditorPanel : null}
      </div>
      {!isFocusMode && !inlineEditorSideBySide ? inlineEditorPanel : null}
      {exportDialogOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.42)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '1.5rem',
            zIndex: 1000000
          }}
          onClick={() => setExportDialogOpen(false)}
        >
          <div
            className="glass-panel"
            style={{
              width: '100%',
              maxWidth: '760px',
              padding: '1.5rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '1.25rem'
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div>
                <h2 style={{ margin: 0, fontSize: '1.35rem' }}>{t('taskDetail.exportDialogTitle')}</h2>
                <p style={{ margin: '0.65rem 0 0', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
                  {t('taskDetail.exportDialogDescription')}
                </p>
              </div>
              <button className="glass-button" onClick={() => setExportDialogOpen(false)}>
                {t('common.cancel')}
              </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.9rem' }}>
              {exportFamilies.map((item) => {
                const active = selectedExportFamily === item.family;
                return (
                  <button
                    key={item.family}
                    type="button"
                    className={`glass-button ${active ? 'primary' : ''}`}
                    onClick={() => setSelectedExportFamily(item.family)}
                    style={{
                      padding: '1rem',
                      justifyContent: 'flex-start',
                      textAlign: 'left',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      gap: '0.45rem',
                      minHeight: '132px',
                      boxShadow: active ? 'var(--neu-shadow-inset)' : 'var(--neu-shadow-sm)'
                    }}
                  >
                    <span style={{ fontWeight: 700 }}>{item.label}</span>
                    <span style={{ fontSize: '0.88rem', lineHeight: 1.6, color: 'var(--text-secondary)' }}>{item.description}</span>
                  </button>
                );
              })}
            </div>

            <div className="glass-panel" style={{ padding: '1rem 1.1rem', boxShadow: 'var(--neu-shadow-inset)' }}>
              <div style={{ fontWeight: 700, marginBottom: '0.75rem' }}>{t('taskDetail.exportLayoutTitle')}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem' }}>
                {([
                  { value: 'translation-only', label: t('taskDetail.exportLayout.translationOnly'), hint: t('taskDetail.exportLayout.translationOnlyHint') },
                  { value: 'bilingual', label: t('taskDetail.exportLayout.bilingual'), hint: t('taskDetail.exportLayout.bilingualHint') }
                ] as Array<{ value: ExportLayout; label: string; hint: string }>).map((item) => {
                  const active = selectedExportLayout === item.value;
                  return (
                    <button
                      key={item.value}
                      type="button"
                      className={`glass-button ${active ? 'primary' : ''}`}
                      onClick={() => setSelectedExportLayout(item.value)}
                      style={{
                        justifyContent: 'flex-start',
                        textAlign: 'left',
                        flexDirection: 'column',
                        alignItems: 'flex-start',
                        padding: '0.9rem 1rem',
                        gap: '0.35rem',
                        boxShadow: active ? 'var(--neu-shadow-inset)' : 'var(--neu-shadow-sm)'
                      }}
                    >
                      <span style={{ fontWeight: 700 }}>{item.label}</span>
                      <span style={{ fontSize: '0.84rem', lineHeight: 1.55, color: 'var(--text-secondary)' }}>{item.hint}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <label
              className="glass-panel"
              style={{
                padding: '0.95rem 1rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                boxShadow: 'var(--neu-shadow-inset)',
                cursor: 'pointer'
              }}
            >
              <input
                type="checkbox"
                checked={exportAutoDownload}
                onChange={(event) => setExportAutoDownload(event.target.checked)}
                style={{ width: '18px', height: '18px' }}
              />
              <div>
                <div style={{ fontWeight: 700 }}>{t('taskDetail.exportAutoDownloadLabel')}</div>
                <div style={{ color: 'var(--text-secondary)', fontSize: '0.84rem', marginTop: '0.15rem', lineHeight: 1.55 }}>
                  {t('taskDetail.exportAutoDownloadHint')}
                </div>
              </div>
            </label>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', flexWrap: 'wrap' }}>
              <button className="glass-button" onClick={() => setExportDialogOpen(false)}>
                {t('common.cancel')}
              </button>
              <button className="glass-button primary" onClick={() => void handleExportSubmit()} disabled={!canExport}>
                <Download size={16} /> {t('taskDetail.exportStartAction')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
