import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Client } from '../api';
import { FileArchive, FileText, Play, Upload } from 'lucide-react';

type UploadFormat = 'markdown' | 'epub';

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, Math.min(index + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }

  return window.btoa(binary);
}

export default function Dashboard() {
  const [content, setContent] = useState('');
  const [contentBase64, setContentBase64] = useState('');
  const [filename, setFilename] = useState('');
  const [fileSize, setFileSize] = useState(0);
  const [format, setFormat] = useState<UploadFormat>('markdown');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const hasPayload = format === 'epub' ? Boolean(contentBase64) : Boolean(content.trim());

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setFilename(file.name);
    setFileSize(file.size);

    try {
      if (/\.epub$/i.test(file.name)) {
        setFormat('epub');
        setContent('');
        const buffer = await file.arrayBuffer();
        setContentBase64(arrayBufferToBase64(buffer));
      } else {
        setFormat('markdown');
        setContentBase64('');
        setContent(await file.text());
      }
    } catch (error) {
      console.error(error);
      alert('读取文件失败。');
    }
  };

  const handleCreateTask = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!hasPayload || loading) {
      return;
    }

    setLoading(true);
    try {
      const settings = await Client.getSettings();
      if (!settings.success || !settings.data?.hasApiKey) {
        alert('当前未配置可用的 API Key。请先到设置页保存当前会话 Key，或写入环境变量后再开始翻译。');
        navigate('/settings');
        return;
      }

      const createResponse = await Client.createTask(
        format === 'epub'
          ? {
              filename: filename || 'untitled.epub',
              documentFormat: 'epub',
              contentBase64
            }
          : {
              filename: filename || 'untitled.md',
              documentFormat: 'markdown',
              content
            }
      );

      if (!createResponse.success || !createResponse.data) {
        alert(createResponse.error?.message || '创建任务失败。');
        return;
      }

      const taskId = createResponse.data.id;
      const startResponse = await Client.startTranslation(taskId);
      if (!startResponse.success) {
        alert(startResponse.error?.message || '任务已创建，但启动翻译失败。');
        navigate(`/tasks/${taskId}`);
        return;
      }

      navigate(`/tasks/${taskId}`);
    } catch (error) {
      console.error(error);
      const responseError = error as any;
      const message = responseError?.response?.data?.error?.message || '创建任务时发生错误。';
      alert(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="glass-panel" style={{ padding: '2.5rem', maxWidth: '820px', margin: '0 auto', width: '100%' }}>
      <h1 style={{ marginBottom: '2rem', fontSize: '1.8rem', textAlign: 'center' }}>导入文档并启动翻译</h1>

      <form onSubmit={handleCreateTask} style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
        <div
          style={{
            padding: '4rem 2rem',
            border: '2px dashed var(--shadow-dark)',
            borderRadius: '16px',
            textAlign: 'center',
            position: 'relative',
            cursor: 'pointer',
            transition: 'all 0.2s ease'
          }}
        >
          <input
            type="file"
            accept=".md,.markdown,.txt,.epub"
            onChange={handleFileUpload}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, cursor: 'pointer' }}
            title="Upload Document"
          />
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem', color: 'var(--text-secondary)', pointerEvents: 'none' }}>
            <Upload size={48} className="text-primary" />
            <p style={{ fontWeight: 600, fontSize: '1.2rem', color: 'var(--text-primary)' }}>点击或拖入 Markdown / EPUB 文件</p>
            <p style={{ fontSize: '0.9rem' }}>支持 `.md`、`.markdown`、`.txt`、`.epub`</p>
          </div>
        </div>

        {filename && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '1rem',
              padding: '1.2rem 1.5rem',
              background: 'var(--bg-color-solid)',
              borderRadius: '12px',
              boxShadow: 'var(--neu-shadow-inset)'
            }}
          >
            {format === 'epub' ? <FileArchive size={24} className="text-primary" /> : <FileText size={24} className="text-primary" />}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              <span style={{ fontWeight: 'bold', fontSize: '1.05rem' }}>{filename}</span>
              <span style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                {format.toUpperCase()} · {(fileSize / 1024).toFixed(1)} KB
              </span>
            </div>
            <span style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginLeft: 'auto' }}>
              {format === 'epub' ? '将按 EPUB XHTML 块解析' : `${content.length.toLocaleString()} chars loaded`}
            </span>
          </div>
        )}

        <button
          type="submit"
          className="glass-button primary"
          disabled={loading || !hasPayload}
          style={{ padding: '1rem 2rem', fontSize: '1.1rem', margin: '0 auto' }}
        >
          <Play size={20} />
          {loading ? '处理中...' : '开始翻译工作流'}
        </button>
      </form>
    </div>
  );
}
