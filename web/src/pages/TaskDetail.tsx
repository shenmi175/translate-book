
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
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
import { Client, type TaskPageBlock, type TaskStatusResponse } from '../api';

const PAGE_SIZE = 20;
const COMPLETED_STATUSES = new Set(['translated', 'edited', 'retranslated']);
const PASSIVE_TASK_STAGES = new Set(['paused', 'cancelled', 'needs_review', 'review_ready']);
const TASK_NOT_FOUND_MESSAGE = '任务不存在，可能已被删除，或者当前地址仍停留在旧任务页面。';

type ViewError = { code: string; message: string };
type DisplayMode = 'compare' | 'source' | 'target';
type ViewMode = 'pagination' | 'scroll';

function artifactToBlob(artifact: any) {
  const mimeType = artifact?.mimeType || 'application/octet-stream';
  if (artifact?.encoding === 'base64') {
    const binary = window.atob(artifact.content || '');
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type: mimeType });
  }
  if (artifact?.encoding === 'json') {
    return new Blob([JSON.stringify(artifact.content ?? {}, null, 2)], { type: mimeType });
  }
  return new Blob([String(artifact?.content ?? '')], { type: mimeType });
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

function TaskErrorState({ title, message }: { title: string; message: string }) {
  return (
    <div className="glass-panel" style={{ padding: '3rem', maxWidth: '760px', margin: '0 auto', textAlign: 'center' }}>
      <h1 style={{ marginTop: 0, marginBottom: '1rem' }}>{title}</h1>
      <p style={{ color: 'var(--text-secondary)', lineHeight: 1.8 }}>{message}</p>
      <div style={{ display: 'flex', justifyContent: 'center', gap: '0.75rem', marginTop: '1.5rem', flexWrap: 'wrap' }}>
        <button className="glass-button primary" onClick={() => window.location.reload()}>重新加载</button>
        <Link to="/tasks" className="glass-button" style={{ textDecoration: 'none' }}>返回任务列表</Link>
      </div>
    </div>
  );
}

export default function TaskDetail() {
  const { taskId } = useParams<{ taskId: string }>();
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  const blockNodeRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const pollingStoppedRef = useRef(false);

  const [status, setStatus] = useState<TaskStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [displayMode, setDisplayMode] = useState<DisplayMode>('compare');
  const [viewMode, setViewMode] = useState<ViewMode>('pagination');
  const [currentPage, setCurrentPage] = useState(1);
  const [isFocusMode, setIsFocusMode] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [viewError, setViewError] = useState<ViewError | null>(null);
  const [pendingFocusBlockId, setPendingFocusBlockId] = useState<string | null>(null);

  const requestPageSize = viewMode === 'scroll' ? 'all' : PAGE_SIZE;
  const totalPages = status?.totalPages || 1;
  const visibleBlocks = status?.pageBlocks || [];

  function markTaskMissing(message = TASK_NOT_FOUND_MESSAGE) {
    pollingStoppedRef.current = true;
    setStatus(null);
    setViewError({ code: 'task_not_found', message });
  }

  function applyOptimisticTaskStage(nextStage: 'paused' | 'cancelled') {
    pollingStoppedRef.current = true;
    setStatus((current) => {
      if (!current) return current;
      const updateBlock = (block: TaskPageBlock | any) => (
        block.status === 'queued' || block.status === 'translating'
          ? { ...block, status: nextStage, errorMessage: '', reviewErrorMessage: '' }
          : block
      );
      return {
        ...current,
        stage: nextStage,
        updatedAt: new Date().toISOString(),
        summary: { ...current.summary, activeBlocks: 0 },
        blocks: current.blocks.map(updateBlock),
        pageBlocks: current.pageBlocks.map(updateBlock)
      };
    });
  }

  async function fetchStatus(currentTaskId: string, showLoading = false) {
    if (showLoading) setLoading(true);
    try {
      const result = await Client.getTaskStatus(currentTaskId, {
        page: viewMode === 'scroll' ? 1 : currentPage,
        pageSize: requestPageSize
      });
      if (!result.success) {
        if (result.error?.code === 'task_not_found') {
          markTaskMissing(result.error?.message || TASK_NOT_FOUND_MESSAGE);
          return false;
        }
        setViewError(toViewError(result, '加载任务状态失败。'));
        return false;
      }
      pollingStoppedRef.current = PASSIVE_TASK_STAGES.has(result.data.stage);
      setStatus(result.data);
      setViewError(null);
      return true;
    } catch (error) {
      console.error(error);
      setViewError({ code: 'request_failed', message: '加载任务状态失败，请检查后端日志。' });
      return false;
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    pollingStoppedRef.current = false;
    void fetchStatus(taskId, true);
    const interval = window.setInterval(() => {
      if (cancelled || pollingStoppedRef.current) return;
      void fetchStatus(taskId);
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [taskId, currentPage, requestPageSize, viewMode]);

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

  const failedBlocks = useMemo(() => (status?.blocks || []).filter((block) => block.status === 'failed'), [status]);
  const stats = useMemo(() => {
    if (!status?.blocks) return { total: 0, translated: 0, failed: 0, pending: 0, percentage: 0 };
    const translatableBlocks = status.blocks.filter((block) => block.shouldTranslate);
    const total = translatableBlocks.length;
    const translated = translatableBlocks.filter((block) => COMPLETED_STATUSES.has(block.status)).length;
    const failed = translatableBlocks.filter((block) => block.status === 'failed').length;
    const pending = Math.max(0, total - translated - failed);
    const percentage = total > 0 ? Math.round((translated / total) * 100) : 0;
    return { total, translated, failed, pending, percentage };
  }, [status]);

  const canExport = (status?.summary?.completedBlocks || 0) > 0;
  const firstVisibleErrorId = visibleBlocks.find((block) => block.status === 'failed')?.id || null;
  const exportOptions = useMemo(() => {
    const items = [
      { format: 'markdown', label: 'Markdown 纯译文' },
      { format: 'markdown_bilingual', label: 'Markdown 双语' },
      { format: 'pdf', label: 'PDF 纯译文' },
      { format: 'pdf_bilingual', label: 'PDF 双语' }
    ];
    if (status?.documentFormat === 'epub') items.push({ format: 'epub', label: 'EPUB 导出' });
    return items;
  }, [status?.documentFormat]);

  async function runTaskAction(actionName: string, action: () => Promise<any>, stopPolling = false) {
    if (!taskId) return;
    setActionBusy(actionName);
    if (stopPolling) pollingStoppedRef.current = true;
    try {
      await action();
      await fetchStatus(taskId);
    } catch (error) {
      console.error(error);
      alert('任务操作失败，请检查后端日志。');
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
    if (!window.confirm('确认取消当前翻译任务吗？')) return;
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
      alert('单块重译触发失败。');
    } finally {
      setActionBusy(null);
    }
  }

  async function handleRetranslateFailed() {
    if (!taskId || !status?.blocks) return;
    const failedIds = status.blocks.filter((block) => block.status === 'failed').map((block) => block.id);
    if (!failedIds.length) return;
    setActionBusy('retry-failed');
    pollingStoppedRef.current = false;
    try {
      await Client.retranslateBlocksBatch(taskId, { blockIds: failedIds, retranslationGoal: 'more_accurate', focus: 'auto' });
      await fetchStatus(taskId);
    } catch (error) {
      console.error(error);
      alert('批量重译失败。');
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
      alert(reviewState === 'confirmed' ? '确认失败。' : '忽略失败。');
    } finally {
      setActionBusy(null);
    }
  }

  async function handleExport(format: string) {
    if (!taskId) return;
    try {
      const result = await Client.exportTask(taskId, format);
      if (!result.success || !result.data?.export) {
        alert('导出结果缺失。');
        return;
      }
      const artifact = result.data.export;
      const blob = artifactToBlob(artifact);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = artifact.filename || `export.${format}`;
      anchor.click();
      URL.revokeObjectURL(objectUrl);
      setExportMenuOpen(false);
    } catch (error) {
      console.error(error);
      alert('导出失败。');
    }
  }

  function jumpToError(direction: 'prev' | 'next') {
    if (!failedBlocks.length || !status) return;
    const currentId = firstVisibleErrorId;
    let currentIndex = failedBlocks.findIndex((block) => block.id === currentId);
    if (currentIndex < 0) currentIndex = direction === 'next' ? -1 : failedBlocks.length;
    const nextIndex = direction === 'next'
      ? Math.min(failedBlocks.length - 1, currentIndex + 1)
      : Math.max(0, currentIndex - 1);
    const targetBlock = failedBlocks[nextIndex];
    if (!targetBlock) return;
    setPendingFocusBlockId(targetBlock.id);
    if (viewMode === 'pagination') {
      const allIndex = status.blocks.findIndex((block) => block.id === targetBlock.id);
      if (allIndex >= 0) setCurrentPage(Math.floor(allIndex / PAGE_SIZE) + 1);
    }
  }

  function renderPrimaryAction() {
    if (!status) return null;
    if (status.stage === 'parsed') {
      return <button className="glass-button primary" onClick={handleStart} disabled={actionBusy !== null}><PlayCircle size={16} /> 开始全文翻译</button>;
    }
    if (status.stage === 'paused') {
      return <button className="glass-button primary" onClick={handleResume} disabled={actionBusy !== null}><PlayCircle size={16} /> 继续翻译</button>;
    }
    if (status.stage === 'cancelled') {
      return <button className="glass-button primary" onClick={handleStart} disabled={actionBusy !== null}><PlayCircle size={16} /> 重新启动剩余块</button>;
    }
    return null;
  }

  if (loading) return <div style={{ padding: '2rem', textAlign: 'center' }}>正在加载任务...</div>;
  if (viewError?.code === 'task_not_found') return <TaskErrorState title="任务不存在" message={viewError.message} />;
  if (viewError && !status) return <TaskErrorState title="加载失败" message={viewError.message} />;
  if (!status) return <div style={{ padding: '2rem', textAlign: 'center' }}>暂无任务状态。</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', height: '100%' }}>
      {!isFocusMode && (
        <>
          <div className="glass-panel" style={{ padding: '2rem', display: 'flex', flexWrap: 'wrap', gap: '2rem', alignItems: 'stretch' }}>
            <div style={{ flex: '1 1 720px', minWidth: '320px', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div>
                  <h1 style={{ fontSize: '1.8rem', fontWeight: 700, margin: 0 }}>{status.filename}</h1>
                  <div style={{ marginTop: '0.75rem', color: 'var(--text-secondary)', display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                    <span className={status.stage === 'review_ready' ? 'text-success' : 'text-warning'} style={{ padding: '4px 12px', borderRadius: '999px', background: status.stage === 'review_ready' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(245, 158, 11, 0.15)', textTransform: 'capitalize', fontWeight: 600, fontSize: '0.9rem' }}>{status.stage.replace('_', ' ')}</span>
                    <span style={{ fontSize: '0.9rem' }}>{status.documentFormat.toUpperCase()}</span>
                    <span style={{ fontSize: '0.9rem' }}>更新时间：{new Date(status.updatedAt).toLocaleTimeString()}</span>
                  </div>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', justifyContent: 'flex-end', alignItems: 'center' }}>
                  {status.stage === 'translating' && (
                    <>
                      <button className="glass-button" onClick={handlePause} disabled={actionBusy !== null}><Pause size={16} /> 暂停</button>
                      <button className="glass-button" onClick={handleCancel} disabled={actionBusy !== null} style={{ color: 'var(--danger-color)' }}><XCircle size={16} /> 取消</button>
                    </>
                  )}
                  {renderPrimaryAction()}
                  <div ref={exportMenuRef} style={{ position: 'relative' }}>
                    <button className="glass-button primary" onClick={() => setExportMenuOpen((value) => !value)} disabled={!canExport}><Download size={16} /> 导出 <ChevronDown size={15} /></button>
                    {exportMenuOpen && canExport && (
                      <div style={{ position: 'absolute', top: 'calc(100% + 10px)', right: 0, minWidth: '220px', padding: '0.5rem', borderRadius: '14px', background: 'var(--bg-color-solid)', boxShadow: 'var(--neu-shadow)', display: 'flex', flexDirection: 'column', gap: '0.35rem', zIndex: 100 }}>
                        {exportOptions.map((item) => (
                          <button key={item.format} className="glass-button" style={{ justifyContent: 'flex-start', padding: '0.7rem 0.9rem' }} onClick={() => handleExport(item.format)}>{item.label}</button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '1rem', background: 'var(--shadow-light)', padding: '1.2rem', borderRadius: '12px', boxShadow: 'var(--neu-shadow-inset)' }}>
                <div><span style={{ fontSize: '0.8rem', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>Words</span><strong style={{ display: 'block', fontSize: '1.3rem' }}>{status.summary?.translatedWordCount || 0} / {status.summary?.sourceWordCount || 0}</strong></div>
                <div><span style={{ fontSize: '0.8rem', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>Speed</span><strong style={{ display: 'block', fontSize: '1.3rem' }}>{status.summary?.translationSpeed || 0} <span style={{ fontSize: '0.8rem' }}>w/sec</span></strong></div>
                <div><span style={{ fontSize: '0.8rem', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>Est. Wait</span><strong style={{ display: 'block', fontSize: '1.3rem' }}>{status.summary?.estimatedTimeRemaining ? `${status.summary.estimatedTimeRemaining}s` : 'N/A'}</strong></div>
                <div><span style={{ fontSize: '0.8rem', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>Active Workers</span><strong style={{ display: 'block', fontSize: '1.3rem', color: 'var(--primary-color)' }}>{status.summary?.activeBlocks || 0}</strong></div>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', minWidth: '260px' }}>
              <div style={{ width: '110px', height: '110px', borderRadius: '50%', background: `conic-gradient(var(--primary-color) ${stats.percentage}%, var(--bg-color-solid) 0)`, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: 'var(--neu-shadow)' }}>
                <div style={{ width: '90px', height: '90px', borderRadius: '50%', background: 'var(--bg-color-solid)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '1.5rem', color: 'var(--primary-color)', boxShadow: 'var(--neu-shadow-inset)' }}>{stats.percentage}%</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', fontSize: '1rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', fontWeight: 600 }}><CheckCircle size={20} className="text-success" /><span>{stats.translated} Completed</span></div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', fontWeight: 600 }}><Loader2 size={20} className={stats.pending > 0 ? 'text-primary' : 'text-secondary'} style={{ animation: stats.pending > 0 ? 'spin 2s linear infinite' : 'none' }} /><span>{stats.pending} Pending</span></div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', fontWeight: 600, flexWrap: 'wrap' }}>
                  <AlertTriangle size={20} className="text-danger" /><span>{stats.failed} Failed</span>
                  {stats.failed > 0 && (
                    <>
                      <button className="glass-button" onClick={() => jumpToError('prev')} style={{ padding: '0.3rem 0.6rem', fontSize: '0.8rem' }}><ChevronLeft size={14} /> 上一个错误</button>
                      <button className="glass-button" onClick={() => jumpToError('next')} style={{ padding: '0.3rem 0.6rem', fontSize: '0.8rem' }}><ChevronRight size={14} /> 下一个错误</button>
                      <button className="glass-button" onClick={handleRetranslateFailed} disabled={actionBusy !== null} style={{ padding: '0.3rem 0.6rem', fontSize: '0.8rem' }}><RefreshCw size={14} /> Retry All</button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem', background: 'var(--bg-color-solid)', borderRadius: '12px', boxShadow: 'var(--neu-shadow-sm)', flexWrap: 'wrap', gap: '1rem' }}>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button className={`glass-button ${displayMode === 'compare' ? 'primary' : ''}`} onClick={() => setDisplayMode('compare')} style={{ padding: '0.4rem 1rem' }}>双语对照</button>
              <button className={`glass-button ${displayMode === 'source' ? 'primary' : ''}`} onClick={() => setDisplayMode('source')} style={{ padding: '0.4rem 1rem' }}>仅原文</button>
              <button className={`glass-button ${displayMode === 'target' ? 'primary' : ''}`} onClick={() => setDisplayMode('target')} style={{ padding: '0.4rem 1rem' }}>仅译文</button>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button className={`glass-button ${viewMode === 'pagination' ? 'primary' : ''}`} onClick={() => { setViewMode('pagination'); setCurrentPage(1); }} style={{ padding: '0.4rem 1rem' }}>分页模式</button>
              <button className={`glass-button ${viewMode === 'scroll' ? 'primary' : ''}`} onClick={() => setViewMode('scroll')} style={{ padding: '0.4rem 1rem' }}>长卷滚动</button>
              <button className="glass-button" onClick={() => setIsFocusMode(true)} style={{ padding: '0.4rem 1rem' }}><Maximize size={16} style={{ verticalAlign: 'middle', marginRight: '0.35rem' }} /> 专注模式</button>
            </div>
          </div>
        </>
      )}
      <div className={isFocusMode ? '' : 'glass-panel'} style={isFocusMode ? { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 999999, background: 'var(--bg-color-solid, var(--bg-color))', overflowY: 'auto', padding: '4rem 12%', display: 'flex', flexDirection: 'column' } : { flex: 1, display: 'flex', flexDirection: 'column', padding: '2.5rem', overflowY: 'auto' }}>
        {isFocusMode && <button onClick={() => setIsFocusMode(false)} className="glass-button" style={{ position: 'fixed', top: '1rem', right: '1.5rem', zIndex: 10000, padding: '0.6rem 1.2rem' }}><Minimize size={16} style={{ verticalAlign: 'middle', marginRight: '0.35rem' }} /> 退出专注模式 (ESC)</button>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.75rem', fontSize: isFocusMode ? '1.2rem' : '1.05rem', lineHeight: 1.8 }}>
          {visibleBlocks.map((block) => {
            const candidateTranslation = block.reviewCandidateTranslation || '';
            const reviewState = block.reviewState || 'none';
            const blockErrorMessage = formatProviderAwareErrorMessage(block.errorMessage, status.providerLabel);
            let targetContent: any = <em style={{ opacity: 0.55 }}>等待处理...</em>;
            let color = 'var(--text-primary)';
            let borderLeft = 'none';
            if (!block.shouldTranslate) {
              targetContent = block.sourceMarkdown;
              color = 'var(--text-secondary)';
              borderLeft = '3px solid var(--shadow-dark)';
            } else if (block.status === 'failed') {
              targetContent = reviewState === 'ignored' ? block.sourceMarkdown : candidateTranslation || blockErrorMessage || '翻译失败';
              color = reviewState === 'ignored' ? 'var(--warning-color)' : 'var(--danger-color)';
              borderLeft = reviewState === 'ignored' ? '3px solid var(--warning-color)' : '3px solid var(--danger-color)';
            } else if (COMPLETED_STATUSES.has(block.status)) {
              targetContent = block.translatedMarkdown || '...';
              color = 'var(--success-color)';
              borderLeft = '3px solid rgba(16, 185, 129, 0.35)';
            } else if (block.status === 'paused') {
              targetContent = <em style={{ opacity: 0.7 }}>已暂停，等待继续</em>;
              color = 'var(--warning-color)';
              borderLeft = '3px solid var(--warning-color)';
            } else if (block.status === 'cancelled') {
              targetContent = <em style={{ opacity: 0.7 }}>已取消</em>;
              color = 'var(--text-secondary)';
              borderLeft = '3px solid var(--shadow-dark)';
            } else if (block.status === 'queued') {
              targetContent = <em style={{ opacity: 0.7 }}>排队中...</em>;
              color = 'var(--warning-color)';
              borderLeft = '3px solid var(--warning-color)';
            } else if (block.status === 'translating') {
              targetContent = <em style={{ opacity: 0.7 }}>翻译中...</em>;
              color = 'var(--warning-color)';
              borderLeft = '3px solid var(--warning-color)';
            }
            return (
              <div key={block.id} ref={(node) => { blockNodeRefs.current[block.id] = node; }} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {(displayMode === 'compare' || displayMode === 'source') && <div style={{ color: 'var(--text-primary)', whiteSpace: 'pre-wrap' }}>{block.sourceMarkdown}</div>}
                {(displayMode === 'compare' || displayMode === 'target') && (
                  <div style={{ color, borderLeft, paddingLeft: '1rem', whiteSpace: 'pre-wrap', background: displayMode === 'compare' ? 'rgba(0,0,0,0.02)' : 'transparent', borderRadius: '0 8px 8px 0', paddingTop: displayMode === 'compare' ? '0.5rem' : 0, paddingBottom: displayMode === 'compare' ? '0.5rem' : 0 }}>
                    {targetContent}
                    {block.status === 'failed' && blockErrorMessage && <div style={{ marginTop: '0.5rem', fontSize: '0.9rem', opacity: 0.9 }}>{blockErrorMessage}</div>}
                    {block.status === 'failed' && (
                      <div style={{ display: 'inline-flex', gap: '0.5rem', flexWrap: 'wrap', marginLeft: '1rem', verticalAlign: 'middle' }}>
                        <button onClick={() => handleReviewAction(block.id, 'confirmed')} disabled={actionBusy !== null || !candidateTranslation} style={{ background: 'transparent', border: '1px solid var(--success-color)', borderRadius: '6px', color: 'var(--success-color)', cursor: 'pointer', padding: '2px 8px', fontSize: '0.8rem' }}>确认</button>
                        <button onClick={() => handleReviewAction(block.id, 'ignored')} disabled={actionBusy !== null} style={{ background: 'transparent', border: '1px solid var(--warning-color)', borderRadius: '6px', color: 'var(--warning-color)', cursor: 'pointer', padding: '2px 8px', fontSize: '0.8rem' }}>忽略</button>
                        <button onClick={() => handleRetranslate(block.id)} disabled={actionBusy !== null} style={{ background: 'transparent', border: '1px solid var(--danger-color)', borderRadius: '6px', color: 'var(--danger-color)', cursor: 'pointer', padding: '2px 8px', fontSize: '0.8rem' }}>重试</button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {viewMode === 'pagination' && totalPages > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', gap: '1rem', marginTop: '1rem', paddingTop: '1.5rem', borderTop: '2px solid var(--shadow-light)', alignItems: 'center' }}>
              <button className="glass-button" disabled={currentPage === 1} onClick={() => setCurrentPage((page) => page - 1)} style={{ padding: '0.6rem 1.25rem' }}>上一页</button>
              <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>{currentPage} / {totalPages}</span>
              <button className="glass-button primary" disabled={currentPage === totalPages} onClick={() => setCurrentPage((page) => page + 1)} style={{ padding: '0.6rem 1.25rem' }}>下一页</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
