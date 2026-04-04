import { useState, useEffect, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { Client, type TaskStatusResponse } from '../api';
import { CheckCircle, AlertTriangle, PlayCircle, Loader2, Pause, XCircle, Download, FileDown, RefreshCw, Maximize, Minimize } from 'lucide-react';

export default function TaskDetail() {
  const { taskId } = useParams<{ taskId: string }>();
  const [taskFull, setTaskFull] = useState<any>(null);
  const [status, setStatus] = useState<TaskStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [displayMode, setDisplayMode] = useState<'compare' | 'source' | 'target'>('compare');
  const [viewMode, setViewMode] = useState<'pagination' | 'scroll'>('pagination');
  const [currentPage, setCurrentPage] = useState(1);
  const [isFocusMode, setIsFocusMode] = useState(false);
  const pageSize = 20;

  const totalPages = Math.max(1, Math.ceil((status?.blocks?.length || 0) / pageSize));

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
         setCurrentPage(p => Math.max(1, p - 1));
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
         setCurrentPage(p => Math.min(totalPages, p + 1));
      } else if (e.key === 'Escape') {
         setIsFocusMode(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [totalPages]);

  useEffect(() => {
    if (!taskId) return;
    
    // Initial fetch for structure and existing markdowns
    Client.getTask(taskId).then(res => {
      if (res.success) setTaskFull(res.data);
    });

    const poll = async () => {
      try {
        const res = await Client.getTaskStatus(taskId);
        if (res.success) {
          setStatus(prev => {
             // If any block transitioned to completion, fetch only that block
             if (prev) {
                res.data.blocks.forEach(async newB => {
                   const oldB = prev.blocks.find(b => b.id === newB.id);
                   if (oldB && oldB.status !== newB.status && ['translated', 'edited'].includes(newB.status)) {
                      const bRes = await Client.getBlock(taskId, newB.id);
                      if (bRes.success && bRes.data && bRes.data.block) {
                         setTaskFull((tf: any) => {
                            if (!tf) return tf;
                            return {
                               ...tf,
                               blocks: tf.blocks.map((tb: any) => tb.id === newB.id ? bRes.data.block : tb)
                            };
                         });
                      }
                   }
                });
             }
             return res.data;
          });
        }
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };

    poll();
    const interval = setInterval(poll, 2500);
    return () => clearInterval(interval);
  }, [taskId]);

  const stats = useMemo(() => {
    if (!status?.blocks) return { total: 0, translated: 0, failed: 0, percentage: 0 };
    const translateBlocks = status.blocks.filter(b => b.shouldTranslate);
    const total = translateBlocks.length;
    const translated = translateBlocks.filter(b => ['translated', 'edited', 'retranslated'].includes(b.status)).length;
    const failed = translateBlocks.filter(b => b.status === 'failed').length;
    let percentage = 0;
    if (total > 0) percentage = Math.round((translated / total) * 100);
    else if (status.stage !== 'parsed' && status.stage !== 'translating') percentage = 100;
    return { total, translated, failed, percentage };
  }, [status]);

  if (loading || !status) {
    return <div style={{ padding: '2rem', textAlign: 'center' }}>Loading task visualization...</div>;
  }

  const handleRetranslate = async (blockId: string) => {
    if (!taskId) return;
    try {
      await Client.retranslateBlock(taskId, blockId, { retranslationGoal: 'better', focus: 'auto' });
    } catch (e) {
      alert('Failed to trigger retranslate block');
    }
  };

  const handlePause = async () => {
     await Client.pauseTask(taskId!);
  };
  
  const handleCancel = async () => {
     if(confirm("Are you sure you want to cancel the active translation job?")) {
        await Client.cancelTask(taskId!);
     }
  };
  
  const handleExportMd = async (format: 'markdown' | 'markdown_bilingual') => {
    try {
      const res = await Client.exportTask(taskId!, format);
      if (res.success && res.data.export) {
         const { content, mimeType, filename } = res.data.export;
         const blob = new Blob([content], { type: mimeType });
         const linkSource = URL.createObjectURL(blob);
         const downloadLink = document.createElement("a");
         downloadLink.href = linkSource;
         downloadLink.download = filename;
         downloadLink.click();
         URL.revokeObjectURL(linkSource);
      } else {
         alert('Markdown Export missing or not ready');
      }
    } catch(e) { alert('Markdown Export failed'); }
  };

  const handleExportPdf = async (format: 'pdf' | 'pdf_bilingual') => {
    try {
      const res = await Client.exportTask(taskId!, format);
      if (res.success && res.data.export) {
         const { content, mimeType, filename } = res.data.export;
         const linkSource = `data:${mimeType};base64,${content}`;
         const downloadLink = document.createElement("a");
         downloadLink.href = linkSource;
         downloadLink.download = filename;
         downloadLink.click();
      } else {
         alert('PDF Export missing or not ready');
      }
    } catch(e) { alert('PDF Export failed'); }
  };

  const handleRetranslateFailed = async () => {
    if (!taskId || !status?.blocks) return;
    const failedIds = status.blocks.filter(b => b.status === 'failed').map(b => b.id);
    if (!failedIds.length) return;
    try {
       await Client.retranslateBlocksBatch(taskId, { blockIds: failedIds, retranslationGoal: 'more_accurate', focus: 'auto' });
    } catch(e) { alert('Batch retranslate failed'); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem', height: '100%' }}>
      {!isFocusMode && (
        <>
          {/* Header and Vis Stats */}
          <div className="glass-panel" style={{ padding: '2rem', display: 'flex', flexWrap: 'wrap', gap: '3rem', alignItems: 'center' }}>
        <div style={{ flex: 1, minWidth: '350px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.2rem' }}>
              <h1 style={{ fontSize: '1.6rem', fontWeight: 600, margin: 0 }}>{status.filename}</h1>
              <div style={{ display: 'flex', gap: '0.8rem' }}>
                 {(status.stage === 'translating' || status.stage === 'queued') ? (
                    <>
                       <button className="glass-button" onClick={handlePause} title="Pause"><Pause size={16} /> Pause</button>
                       <button className="glass-button" onClick={handleCancel} title="Cancel" style={{ color: 'var(--danger-color)' }}><XCircle size={16} /> Cancel</button>
                    </>
                 ) : (
                     <div style={{ display: 'flex', gap: '1rem' }}>
                        <div style={{ display: 'flex', gap: '0.4rem', borderRight: '2px solid var(--shadow-dark)', paddingRight: '1rem' }}>
                           <button className="glass-button primary" onClick={() => handleExportMd('markdown')} title="Download Target Markdown"><Download size={16} /> MD 纯译文</button>
                           <button className="glass-button" onClick={() => handleExportMd('markdown_bilingual')} title="Download Bilingual Markdown"><Download size={16} /> MD 双语</button>
                        </div>
                        <div style={{ display: 'flex', gap: '0.4rem' }}>
                           <button className="glass-button primary" onClick={() => handleExportPdf('pdf')} title="Download Target PDF"><FileDown size={16} /> PDF 纯译文</button>
                           <button className="glass-button" onClick={() => handleExportPdf('pdf_bilingual')} title="Download Bilingual PDF"><FileDown size={16} /> PDF 双语</button>
                        </div>
                     </div>
                 )}
              </div>
          </div>
          
          <div style={{ color: 'var(--text-secondary)', display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
             <span style={{ 
               padding: '4px 12px', borderRadius: '16px', 
               background: status.stage === 'review_ready' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(245, 158, 11, 0.15)',
               textTransform: 'capitalize', fontWeight: 600, fontSize: '0.9rem'
              }} className={status.stage === 'review_ready' ? 'text-success' : 'text-warning'}>
               {status.stage.replace('_', ' ')}
             </span>
             <span style={{ fontSize: '0.9rem' }}>Updated: {new Date(status.updatedAt).toLocaleTimeString()}</span>
             
             {status.stage === 'parsed' && (
                <button className="glass-button primary" onClick={() => Client.startTranslation(taskId!)} style={{ padding: '0.4rem 1rem', fontSize: '0.85rem' }}>
                    <PlayCircle size={16} /> Start Full Translation
                </button>
             )}
          </div>

          <div style={{ display: 'flex', gap: '1.5rem', marginTop: '1.5rem', fontSize: '0.95rem', color: 'var(--text-secondary)', background: 'var(--shadow-light)', padding: '1.2rem', borderRadius: '12px', boxShadow: 'var(--neu-shadow-inset)' }}>
             <div style={{ display: 'flex', flexDirection: 'column' }}>
                 <span style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Words</span>
                 <strong style={{ fontSize: '1.3rem', color: 'var(--text-primary)' }}>{status.summary?.translatedWordCount || 0} / {status.summary?.sourceWordCount || 0}</strong>
             </div>
             <div style={{ display: 'flex', flexDirection: 'column' }}>
                 <span style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Speed</span>
                 <strong style={{ fontSize: '1.3rem', color: 'var(--text-primary)' }}>{status.summary?.translationSpeed || 0} <span style={{fontSize:'0.8rem'}}>w/sec</span></strong>
             </div>
             <div style={{ display: 'flex', flexDirection: 'column' }}>
                 <span style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Est. Wait</span>
                 <strong style={{ fontSize: '1.3rem', color: 'var(--text-primary)' }}>{status.summary?.estimatedTimeRemaining ? `${status.summary.estimatedTimeRemaining}s` : 'N/A'}</strong>
             </div>
             <div style={{ display: 'flex', flexDirection: 'column' }}>
                 <span style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Active Nodes</span>
                 <strong style={{ fontSize: '1.3rem', color: 'var(--primary-color)' }}>{status.summary?.activeBlocks || 0}</strong>
             </div>
          </div>
        </div>

        {/* Visualization: Progress Circular */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '2rem', minWidth: '350px' }}>
           <div style={{ 
               width: '110px', height: '110px', borderRadius: '50%', 
               background: `conic-gradient(var(--primary-color) ${stats.percentage}%, var(--bg-color-solid) 0)`,
               display: 'flex', alignItems: 'center', justifyContent: 'center',
               boxShadow: 'var(--neu-shadow)'
           }}>
              <div style={{ 
                  width: '90px', height: '90px', borderRadius: '50%', 
                  background: 'var(--bg-color-solid)', 
                  display: 'flex', alignItems: 'center', justifyContent: 'center', 
                  fontWeight: 700, fontSize: '1.5rem', color: 'var(--primary-color)',
                  boxShadow: 'var(--neu-shadow-inset)'
              }}>
                 {stats.percentage}%
              </div>
           </div>
           
           <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem', fontSize: '1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', fontWeight: 600 }}>
                  <CheckCircle size={20} className="text-success" />
                  <span>{stats.translated} Completed</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', fontWeight: 600 }}>
                  <Loader2 size={20} className={stats.percentage === 100 ? "text-secondary" : "text-primary"} style={{ animation: stats.percentage !== 100 ? 'spin 2s linear infinite' : 'none' }}/>
                  <span>{stats.total - stats.translated - stats.failed} Pending</span>
              </div>
              {stats.failed > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', fontWeight: 600 }}>
                    <AlertTriangle size={20} className="text-danger" />
                    <span>{stats.failed} Failed</span>
                    <button onClick={handleRetranslateFailed} className="glass-button" style={{ padding: '0.3rem 0.6rem', fontSize: '0.8rem', marginLeft: '0.5rem' }}>
                       <RefreshCw size={14} /> Retry All
                    </button>
                </div>
              )}
           </div>
        </div>
      </div>

      {/* Reader Controls */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem', background: 'var(--bg-color-solid)', borderRadius: '12px', boxShadow: 'var(--neu-shadow-sm)' }}>
         <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button className={`glass-button ${displayMode === 'compare' ? 'primary' : ''}`} onClick={() => setDisplayMode('compare')} style={{ padding: '0.4rem 1rem' }}>双语对照 (Compare)</button>
            <button className={`glass-button ${displayMode === 'source' ? 'primary' : ''}`} onClick={() => setDisplayMode('source')} style={{ padding: '0.4rem 1rem' }}>仅原文 (Source)</button>
            <button className={`glass-button ${displayMode === 'target' ? 'primary' : ''}`} onClick={() => setDisplayMode('target')} style={{ padding: '0.4rem 1rem' }}>仅译文 (Target)</button>
         </div>
         <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button className={`glass-button ${viewMode === 'pagination' ? 'primary' : ''}`} onClick={() => { setViewMode('pagination'); setCurrentPage(1); }} style={{ padding: '0.4rem 1rem' }}>翻页模式 (Pages)</button>
            <button className={`glass-button ${viewMode === 'scroll' ? 'primary' : ''}`} onClick={() => setViewMode('scroll')} style={{ padding: '0.4rem 1rem' }}>长卷滚动 (Scroll)</button>
            <button className="glass-button" onClick={() => setIsFocusMode(true)} style={{ padding: '0.4rem 1rem', marginLeft: '1rem' }}><Maximize size={16} style={{ verticalAlign: 'middle', marginRight: '0.4rem' }}/> 专注功能 (Focus)</button>
         </div>
      </div>
      </>
      )}

      {/* Unified Text Reader View */}
      <div 
         className={isFocusMode ? "" : "glass-panel"} 
         style={isFocusMode ? {
            position: 'fixed' as const, top: 0, left: 0, right: 0, bottom: 0, 
            zIndex: 999999, background: 'var(--bg-color-solid, var(--bg-color))', overflowY: 'auto' as const,
            padding: '4rem 12%', display: 'flex', flexDirection: 'column' as const
         } : {
            flex: 1, display: 'flex', flexDirection: 'column' as const, padding: '2.5rem', overflowY: 'auto' as const
         }}
      >
           {isFocusMode && (
              <button 
                 onClick={() => setIsFocusMode(false)} 
                 className="glass-button" 
                 style={{ position: 'fixed', top: '1rem', right: '1.5rem', zIndex: 10000, padding: '0.6rem 1.2rem' }}
              >
                 <Minimize size={16} style={{ verticalAlign: 'middle', marginRight: '0.4rem' }}/> 退出专注 (ESC)
              </button>
           )}

           {isFocusMode && viewMode === 'pagination' && (
              <>
                 <div 
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    style={{ position: 'fixed', left: 0, top: 0, bottom: 0, width: '8%', cursor: currentPage === 1 ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: currentPage === 1 ? 0.1 : 0.6, transition: 'all 0.2s', background: 'linear-gradient(to right, rgba(0,0,0,0.06), transparent)' }}
                    title="上一页"
                 >
                     <span style={{ fontSize: '3rem' }}>‹</span>
                 </div>
                 <div 
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    style={{ position: 'fixed', right: 0, top: 0, bottom: 0, width: '8%', cursor: currentPage === totalPages ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: currentPage === totalPages ? 0.1 : 0.6, transition: 'all 0.2s', background: 'linear-gradient(to left, rgba(0,0,0,0.06), transparent)' }}
                    title="下一页"
                 >
                     <span style={{ fontSize: '3rem' }}>›</span>
                 </div>
              </>
           )}

           <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem', fontSize: isFocusMode ? '1.2rem' : '1.05rem', lineHeight: 1.8 }}>
              {(() => {
                 const visibleBlocks = viewMode === 'scroll' 
                    ? status.blocks 
                    : status.blocks.slice((currentPage - 1) * pageSize, currentPage * pageSize);
                 
                 return (
                    <>
                       {visibleBlocks.map(b => {
                          const fullBlock = taskFull?.blocks?.find((tb: any) => tb.id === b.id);
                          const sourceMd = fullBlock?.sourceMarkdown || '...';
                          
                          let targetContent: React.ReactNode = <em style={{ opacity: 0.5 }}>Translating...</em>;
                          let colorClass = "var(--text-primary)";
                          let borderLeft = "none";

                          if (!b.shouldTranslate) {
                             targetContent = sourceMd;
                             colorClass = "var(--text-secondary)"; // Gray
                             borderLeft = "3px solid var(--shadow-dark)";
                          } else if (b.status === 'failed') {
                             targetContent = b.errorMessage || 'Translation failed';
                             colorClass = "var(--danger-color)"; // Red
                             borderLeft = "3px solid var(--danger-color)";
                          } else if (['translated', 'edited', 'retranslated'].includes(b.status)) {
                             targetContent = fullBlock?.translatedMarkdown || '...';
                             colorClass = "var(--success-color)"; // Green
                             borderLeft = "3px solid rgba(16, 185, 129, 0.3)";
                          } else {
                             colorClass = "var(--warning-color)";
                             borderLeft = "3px solid var(--warning-color)";
                          }

                          return (
                             <div key={b.id} style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                                {(displayMode === 'compare' || displayMode === 'source') && (
                                   <div style={{ color: 'var(--text-primary)', whiteSpace: 'pre-wrap' }}>
                                      {sourceMd}
                                   </div>
                                )}
                                {(displayMode === 'compare' || displayMode === 'target') && (
                                   <div style={{ 
                                      color: colorClass, 
                                      borderLeft: borderLeft,
                                      paddingLeft: '1rem',
                                      whiteSpace: 'pre-wrap',
                                      position: 'relative',
                                      background: displayMode === 'compare' ? 'rgba(0,0,0,0.01)' : 'transparent',
                                      marginTop: displayMode === 'compare' ? '0.5rem' : 0,
                                      paddingTop: displayMode === 'compare' ? '0.5rem' : 0,
                                      paddingBottom: displayMode === 'compare' ? '0.5rem' : 0,
                                      borderRadius: '0 8px 8px 0'
                                   }}>
                                      {targetContent}
                                      
                                      {b.status === 'failed' && (
                                         <button 
                                            onClick={() => handleRetranslate(b.id)} 
                                            title="Retry" 
                                            style={{ 
                                              marginLeft: '1rem', 
                                              background: 'transparent', 
                                              border: '1px solid var(--danger-color)', 
                                              borderRadius: '6px', 
                                              color: 'var(--danger-color)', 
                                              cursor: 'pointer', 
                                              padding: '2px 8px', 
                                              fontSize: '0.8rem',
                                              verticalAlign: 'middle'
                                            }}
                                         >
                                            Retry
                                         </button>
                                      )}
                                   </div>
                                )}
                             </div>
                          );
                       })}
                       
                       {viewMode === 'pagination' && totalPages > 1 && (
                          <div style={{ display: 'flex', justifyContent: 'center', gap: '1.5rem', marginTop: '2rem', paddingTop: '2rem', borderTop: '2px solid var(--shadow-light)', alignItems: 'center' }}>
                              <button 
                                 className="glass-button" 
                                 disabled={currentPage === 1} 
                                 onClick={() => setCurrentPage(p => p - 1)}
                                 style={{ padding: '0.6rem 1.5rem' }}
                              >
                                 上一页 (Prev)
                              </button>
                              <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>
                                 {currentPage} / {totalPages}
                              </span>
                              <button 
                                 className="glass-button primary" 
                                 disabled={currentPage === totalPages} 
                                 onClick={() => setCurrentPage(p => p + 1)}
                                 style={{ padding: '0.6rem 1.5rem' }}
                              >
                                 下一页 (Next)
                              </button>
                          </div>
                       )}
                    </>
                 );
              })()}
           </div>
      </div>
    </div>
  );
}
