import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileArchive, FileText, Play, Upload } from 'lucide-react';
import { Client } from '../api';
import { useI18n } from '../i18n';

type UploadFormat = 'markdown' | 'epub';

export default function Dashboard() {
  const { t } = useI18n();
  const [content, setContent] = useState('');
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [filename, setFilename] = useState('');
  const [fileSize, setFileSize] = useState(0);
  const [format, setFormat] = useState<UploadFormat>('markdown');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const hasPayload = format === 'epub' ? Boolean(uploadedFile) : Boolean(content.trim());

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setFilename(file.name);
    setFileSize(file.size);
    setUploadedFile(file);

    try {
      if (/\.epub$/i.test(file.name)) {
        setFormat('epub');
        setContent('');
      } else {
        setFormat('markdown');
        setContent(await file.text());
      }
    } catch (error) {
      console.error(error);
      alert(t('dashboard.readFileFailed'));
    }
  };

  const handleCreateTask = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!hasPayload || loading) {
      return;
    }

    setLoading(true);
    try {
      const createResponse =
        format === 'epub'
          ? await Client.createBinaryTask(uploadedFile!, {
              filename: filename || 'untitled.epub',
              documentFormat: 'epub'
            })
          : await Client.createTask({
              filename: filename || 'untitled.md',
              documentFormat: 'markdown',
              content
            });

      if (!createResponse.success || !createResponse.data) {
        alert(createResponse.error?.message || t('dashboard.createTaskFailed'));
        return;
      }

      const taskId = createResponse.data.id;
      const startResponse = await Client.startTranslation(taskId);
      if (!startResponse.success) {
        if (startResponse.error?.code === 'provider_not_configured') {
          alert(t('dashboard.noApiKey'));
          navigate('/settings');
          return;
        }
        alert(startResponse.error?.message || t('dashboard.startTaskFailed'));
        navigate(`/tasks/${taskId}`);
        return;
      }

      navigate(`/tasks/${taskId}`);
    } catch (error) {
      console.error(error);
      const responseError = error as any;
      const message = responseError?.response?.data?.error?.message || t('dashboard.createTaskError');
      alert(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="glass-panel" style={{ padding: '2.5rem', maxWidth: '820px', margin: '0 auto', width: '100%' }}>
      <h1 style={{ marginBottom: '2rem', fontSize: '1.8rem', textAlign: 'center' }}>{t('dashboard.title')}</h1>

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
            title={t('dashboard.uploadTitle')}
          />
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem', color: 'var(--text-secondary)', pointerEvents: 'none' }}>
            <Upload size={48} className="text-primary" />
            <p style={{ fontWeight: 600, fontSize: '1.2rem', color: 'var(--text-primary)' }}>{t('dashboard.uploadPrompt')}</p>
            <p style={{ fontSize: '0.9rem' }}>{t('dashboard.uploadFormats')}</p>
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
              {format === 'epub' ? t('dashboard.epubParseNote') : t('dashboard.charsLoaded', { count: content.length.toLocaleString() })}
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
          {loading ? t('common.processing') : t('dashboard.startWorkflow')}
        </button>
      </form>
    </div>
  );
}
