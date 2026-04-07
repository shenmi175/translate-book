import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Maximize,
  Minimize,
  Pause,
  PlayCircle,
  RefreshCw,
  XCircle
} from 'lucide-react';
import { Client, type ExportJobStatus, type TaskPageBlock, type TaskStatusResponse } from '../api';
import { useI18n } from '../i18n';

const PAGE_SIZE = 20;
const COMPLETED_STATUSES = new Set(['translated', 'edited', 'retranslated']);
const PASSIVE_TASK_STAGES = new Set(['paused', 'cancelled', 'needs_review', 'review_ready']);
const EPUB_INTERNAL_PLACEHOLDER_PATTERN = /\[\[MTS_(?:OPEN|CLOSE|KEEP)_\d{4}\]\]/;

type ViewError = { code: string; message: string };
type DisplayMode = 'compare' | 'source' | 'target';
type ViewMode = 'pagination' | 'scroll';

function isActiveExportJob(job: ExportJobStatus | null | undefined) {
  return job?.status === 'queued' || job?.status === 'running';
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

export default function TaskDetail() {
  const { t, tTaskStage, dateLocale } = useI18n();
  const { taskId } = useParams<{ taskId: string }>();
  const taskNotFoundMessage = t('taskDetail.taskMissingMessage');
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  const blockNodeRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const pollingStoppedRef = useRef(false);

  const [status, setStatus] = useState<TaskStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [displayMode, setDisplayMode] = useState<DisplayMode>('compare');
  const [viewMode, setViewMode] = useState<ViewMode>('pagination');
  const [currentPage, setCurrentPage] = useState(1);
  const [scrollPagesLoaded, setScrollPagesLoaded] = useState(1);
  const [isFocusMode, setIsFocusMode] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [pendingDownloadJobId, setPendingDownloadJobId] = useState<string | null>(null);
  const [viewError, setViewError] = useState<ViewError | null>(null);
  const [pendingFocusBlockId, setPendingFocusBlockId] = useState<string | null>(null);
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1600));
  const [retryRailBlocks, setRetryRailBlocks] = useState<Array<{ id: string; order: number }>>([]);

  const totalPages = status?.totalPages || 1;
  const visibleBlocks = status?.pageBlocks || [];

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

  useEffect(() => {
    setCurrentPage(1);
    setScrollPagesLoaded(1);
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
      if (viewMode === 'pagination' && (event.key === 'ArrowLeft' || event.key === 'ArrowUp')) {
        setCurrentPage((page) => Math.max(1, page - 1));
      } else if (viewMode === 'pagination' && (event.key === 'ArrowRight' || event.key === 'ArrowDown')) {
        setCurrentPage((page) => Math.min(totalPages, page + 1));
      } else if (event.key === 'Escape') {
        setIsFocusMode(false);
        setExportMenuOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [totalPages, viewMode]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(event.target as Node)) {
        setExportMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, []);

  useEffect(() => {
    const handleResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

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
  const showErrorRail = !isFocusMode && railBlocks.length > 0 && viewportWidth >= 1280;
  const sidebarToolSlot = typeof document !== 'undefined' ? document.getElementById('sidebar-tool-slot') : null;
  const canUseSidebarRail = showErrorRail && Boolean(sidebarToolSlot);
  const latestExportJob = exportJobs[0] || null;
  const exportOptions = useMemo(() => {
    const items = [
      { format: 'markdown', label: t('taskDetail.export.markdown') },
      { format: 'markdown_bilingual', label: t('taskDetail.export.markdown_bilingual') },
      { format: 'pdf', label: t('taskDetail.export.pdf') },
      { format: 'pdf_bilingual', label: t('taskDetail.export.pdf_bilingual') }
    ];
    if (status?.documentFormat === 'epub') {
      items.push({ format: 'epub', label: t('taskDetail.export.epub') });
      items.push({ format: 'epub_bilingual', label: t('taskDetail.export.epub_bilingual') });
    }
    return items;
  }, [status?.documentFormat, t]);

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

  async function handleExport(format: string) {
    if (!taskId) return;
    try {
      const result = await Client.createExportJob(taskId, { format });
      if (!result.success || !result.data?.job) {
        throw new Error(result.error?.message || t('taskDetail.exportFailed'));
      }
      setPendingDownloadJobId(result.data.job.id);
      setExportMenuOpen(false);
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

  function jumpToError(direction: 'prev' | 'next') {
    if (!railBlocks.length || !status) return;
    const currentId = firstVisibleErrorId;
    let currentIndex = railBlocks.findIndex((block) => block.id === currentId);
    if (currentIndex < 0) currentIndex = direction === 'next' ? -1 : railBlocks.length;
    const nextIndex = direction === 'next' ? Math.min(railBlocks.length - 1, currentIndex + 1) : Math.max(0, currentIndex - 1);
    const targetBlock = railBlocks[nextIndex];
    if (!targetBlock) return;
    setPendingFocusBlockId(targetBlock.id);
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
        <AlertTriangle size={18} className="text-danger" />
        <span>{retryRailActive ? t('common.processing') : t('taskDetail.failed', { count: railCount })}</span>
      </div>
      <button className="glass-button" onClick={() => jumpToError('prev')} style={{ width: '100%', justifyContent: 'flex-start' }}>
        <ChevronLeft size={16} /> {t('taskDetail.prevError')}
      </button>
      <button className="glass-button" onClick={() => jumpToError('next')} style={{ width: '100%', justifyContent: 'flex-start' }}>
        <ChevronRight size={16} /> {t('taskDetail.nextError')}
      </button>
      <button className="glass-button" onClick={handleRetranslateFailed} disabled={actionBusy !== null || failedBlocks.length === 0} style={{ width: '100%', justifyContent: 'flex-start' }}>
        <RefreshCw size={16} /> {t('taskDetail.retryAll')}
      </button>
      <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', lineHeight: 1.6 }}>
        {t('taskDetail.errorRailHint')}
      </div>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', height: '100%' }}>
      {canUseSidebarRail && sidebarToolSlot ? createPortal(errorRail, sidebarToolSlot) : null}
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
                  <div ref={exportMenuRef} style={{ position: 'relative' }}>
                    <button className="glass-button primary" onClick={() => setExportMenuOpen((value) => !value)} disabled={!canExport}>
                      <Download size={16} /> {t('common.export')} <ChevronDown size={15} />
                    </button>
                    {exportMenuOpen && canExport && (
                      <div style={{ position: 'absolute', top: 'calc(100% + 10px)', right: 0, minWidth: '220px', padding: '0.5rem', borderRadius: '14px', background: 'var(--bg-color-solid)', boxShadow: 'var(--neu-shadow)', display: 'flex', flexDirection: 'column', gap: '0.35rem', zIndex: 100 }}>
                        {exportOptions.map((item) => (
                          <button key={item.format} className="glass-button" style={{ justifyContent: 'flex-start', padding: '0.7rem 0.9rem' }} onClick={() => handleExport(item.format)}>
                            {item.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
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
                  {!canUseSidebarRail && railBlocks.length > 0 && (
                    <>
                      <button className="glass-button" onClick={() => jumpToError('prev')} style={{ padding: '0.3rem 0.6rem', fontSize: '0.8rem' }}>
                        <ChevronLeft size={14} /> {t('taskDetail.prevError')}
                      </button>
                      <button className="glass-button" onClick={() => jumpToError('next')} style={{ padding: '0.3rem 0.6rem', fontSize: '0.8rem' }}>
                        <ChevronRight size={14} /> {t('taskDetail.nextError')}
                      </button>
                      <button className="glass-button" onClick={handleRetranslateFailed} disabled={actionBusy !== null || failedBlocks.length === 0} style={{ padding: '0.3rem 0.6rem', fontSize: '0.8rem' }}>
                        <RefreshCw size={14} /> {t('taskDetail.retryAll')}
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
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
              <button className={`glass-button ${viewMode === 'pagination' ? 'primary' : ''}`} onClick={() => { setViewMode('pagination'); setCurrentPage(1); }} style={{ padding: '0.4rem 1rem' }}>
                {t('taskDetail.viewPagination')}
              </button>
              <button className={`glass-button ${viewMode === 'scroll' ? 'primary' : ''}`} onClick={() => { setViewMode('scroll'); setScrollPagesLoaded(1); }} style={{ padding: '0.4rem 1rem' }}>
                {t('taskDetail.viewScroll')}
              </button>
              <button className="glass-button" onClick={() => setIsFocusMode(true)} style={{ padding: '0.4rem 1rem' }}>
                <Maximize size={16} style={{ verticalAlign: 'middle', marginRight: '0.35rem' }} /> {t('taskDetail.focusMode')}
              </button>
            </div>
          </div>
          {latestExportJob && (
            <div className="glass-panel" style={{ padding: '1.1rem 1.2rem', borderRadius: '14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', marginBottom: '0.9rem' }}>
                <div>
                  <div style={{ fontWeight: 700 }}>{t('taskDetail.exportQueueTitle')}</div>
                  <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '0.25rem' }}>
                    {pendingDownloadJobId ? t('taskDetail.exportAutoDownloadWaiting') : t('taskDetail.exportQueueHint')}
                  </div>
                </div>
                {hasActiveExportJobs && (
                  <div style={{ color: 'var(--primary-color)', fontWeight: 600 }}>
                    {t('common.processing')}
                  </div>
                )}
              </div>
              {(() => {
                const job = latestExportJob;
                const stageLabel = t(`taskDetail.exportStage.${job.progress.stage}`);
                return (
                  <div style={{ padding: '0.9rem 1rem', borderRadius: '12px', background: 'var(--shadow-light)', boxShadow: 'var(--neu-shadow-inset)', display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
                      <div>
                        <div style={{ fontWeight: 700 }}>{getExportLabel(job.format)}</div>
                        <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '0.2rem' }}>
                          {getExportStatusLabel(job)} · {new Date(job.createdAt).toLocaleTimeString(dateLocale)}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{stageLabel}</span>
                        {job.canDownload && (
                          <button className="glass-button primary" onClick={() => void handleExportJobDownload(job)} style={{ padding: '0.45rem 0.9rem' }}>
                            <Download size={14} /> {t('taskDetail.exportDownload')}
                          </button>
                        )}
                      </div>
                    </div>
                    <div style={{ height: '10px', borderRadius: '999px', background: 'rgba(148, 163, 184, 0.18)', overflow: 'hidden' }}>
                      <div style={{ width: `${job.progress.percent}%`, height: '100%', background: job.status === 'failed' ? 'var(--danger-color)' : 'var(--primary-color)', transition: 'width 0.3s ease' }} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                      <span>{job.progress.percent}%</span>
                      {job.progress.detail ? <span>{job.progress.detail}</span> : null}
                      {job.errorMessage ? <span className="text-danger">{job.errorMessage}</span> : null}
                      {job.stale ? <span>{t('taskDetail.exportStaleHint')}</span> : null}
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </>
      )}
      <div
        className={isFocusMode ? '' : 'glass-panel'}
        style={
          isFocusMode
            ? { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 999999, background: 'var(--bg-color-solid, var(--bg-color))', overflowY: 'auto', padding: '4rem 12%', display: 'flex', flexDirection: 'column' }
            : { flex: 1, display: 'flex', flexDirection: 'column', padding: '2.5rem', overflowY: 'auto' }
        }
      >
        {isFocusMode && (
          <button onClick={() => setIsFocusMode(false)} className="glass-button" style={{ position: 'fixed', top: '1rem', right: '1.5rem', zIndex: 10000, padding: '0.6rem 1.2rem' }}>
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

            return (
              <div key={block.id} ref={(node) => { blockNodeRefs.current[block.id] = node; }} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', minWidth: 0, maxWidth: '100%' }}>
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
                        <summary style={{ cursor: 'pointer' }}>{t('taskDetail.internalPlaceholderCandidate')}</summary>
                        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word', maxHeight: '12rem', overflow: 'auto', margin: '0.5rem 0 0', padding: '0.75rem', borderRadius: '10px', background: 'rgba(15, 23, 42, 0.08)' }}>
                          {candidateTranslation}
                        </pre>
                      </details>
                    )}
                    {block.status === 'failed' && (
                      <div style={{ display: 'inline-flex', gap: '0.5rem', flexWrap: 'wrap', marginLeft: '1rem', verticalAlign: 'middle' }}>
                        <button onClick={() => handleReviewAction(block.id, 'confirmed')} disabled={actionBusy !== null || !canConfirmCandidate} style={{ background: 'transparent', border: '1px solid var(--success-color)', borderRadius: '6px', color: 'var(--success-color)', cursor: 'pointer', padding: '2px 8px', fontSize: '0.8rem' }}>
                          {t('common.confirm')}
                        </button>
                        <button onClick={() => handleReviewAction(block.id, 'ignored')} disabled={actionBusy !== null} style={{ background: 'transparent', border: '1px solid var(--warning-color)', borderRadius: '6px', color: 'var(--warning-color)', cursor: 'pointer', padding: '2px 8px', fontSize: '0.8rem' }}>
                          {t('common.ignore')}
                        </button>
                        <button onClick={() => handleRetranslate(block.id)} disabled={actionBusy !== null} style={{ background: 'transparent', border: '1px solid var(--danger-color)', borderRadius: '6px', color: 'var(--danger-color)', cursor: 'pointer', padding: '2px 8px', fontSize: '0.8rem' }}>
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
              <button className="glass-button" disabled={currentPage === 1} onClick={() => setCurrentPage((page) => page - 1)} style={{ padding: '0.6rem 1.25rem' }}>
                {t('taskDetail.previousPage')}
              </button>
              <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>{currentPage} / {totalPages}</span>
              <button className="glass-button primary" disabled={currentPage === totalPages} onClick={() => setCurrentPage((page) => page + 1)} style={{ padding: '0.6rem 1.25rem' }}>
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
    </div>
  );
}
