import { useEffect, useState } from 'react';
import { AlertCircle, KeyRound, RefreshCw, Save, Trash2 } from 'lucide-react';
import { Client, type ConnectionTestResult } from '../api';

type SettingsForm = {
  apiProvider: string;
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  targetLanguage: string;
  style: string;
  concurrency: number;
};

type KeySource = 'none' | 'dotenv' | 'session';

type SettingsResponse = {
  apiProvider?: string;
  apiBaseUrl?: string;
  model?: string;
  targetLanguage?: string;
  style?: string;
  concurrency?: number;
  hasApiKey?: boolean;
  maskedApiKey?: string;
  apiKeySource?: KeySource | 'env';
  apiKeyStorageKey?: string;
  apiKeyPersistence?: string;
  apiKeyDotenvPath?: string;
  effectiveApiEndpoint?: string;
};

const DEFAULT_FORM: SettingsForm = {
  apiProvider: 'DeepSeek',
  apiBaseUrl: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-chat',
  targetLanguage: 'Chinese',
  style: 'Accurate, natural, professional, concise',
  concurrency: 4
};

function normalizeKeySource(source?: KeySource | 'env'): KeySource {
  if (source === 'env') {
    return 'dotenv';
  }
  if (source === 'dotenv' || source === 'session') {
    return source;
  }
  return 'none';
}

function describeKeySource(source: KeySource, storageKey: string) {
  if (source === 'dotenv') {
    return storageKey ? `.env file (${storageKey})` : '.env file';
  }
  if (source === 'session') {
    return 'Current backend session';
  }
  return 'Not configured';
}

export default function Settings() {
  const [settings, setSettings] = useState<SettingsForm>(DEFAULT_FORM);
  const [hasKey, setHasKey] = useState(false);
  const [maskedKey, setMaskedKey] = useState('');
  const [keySource, setKeySource] = useState<KeySource>('none');
  const [keyPersistence, setKeyPersistence] = useState('none');
  const [keyStorageKey, setKeyStorageKey] = useState('');
  const [dotenvPath, setDotenvPath] = useState('');
  const [effectiveApiEndpoint, setEffectiveApiEndpoint] = useState('');
  const [activeProvider, setActiveProvider] = useState('DeepSeek');
  const [activeModel, setActiveModel] = useState('deepseek-chat');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [persistingDotenv, setPersistingDotenv] = useState(false);
  const [clearingKey, setClearingKey] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionTest, setConnectionTest] = useState<ConnectionTestResult | null>(null);

  const syncFromResponse = (data: SettingsResponse) => {
    const source = normalizeKeySource(data?.apiKeySource);
    setHasKey(Boolean(data?.hasApiKey));
    setMaskedKey(data?.maskedApiKey || '');
    setKeySource(source);
    setKeyPersistence(data?.apiKeyPersistence || 'none');
    setKeyStorageKey(data?.apiKeyStorageKey || 'MARKDOWN_TRANSLATOR_API_KEY');
    setDotenvPath(data?.apiKeyDotenvPath || '.env');
    setEffectiveApiEndpoint(data?.effectiveApiEndpoint || '');
    setActiveProvider(data?.apiProvider || 'DeepSeek');
    setActiveModel(data?.model || 'deepseek-chat');
    setSettings({
      apiProvider: data?.apiProvider || DEFAULT_FORM.apiProvider,
      apiBaseUrl: data?.apiBaseUrl || DEFAULT_FORM.apiBaseUrl,
      apiKey: '',
      model: data?.model || DEFAULT_FORM.model,
      targetLanguage: data?.targetLanguage || DEFAULT_FORM.targetLanguage,
      style: data?.style || DEFAULT_FORM.style,
      concurrency: Number.isInteger(data?.concurrency) ? Number(data.concurrency) : DEFAULT_FORM.concurrency
    });
  };

  const loadSettings = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const res = await Client.getSettings();
      if (res.success && res.data) {
        syncFromResponse(res.data);
        return;
      }
      setLoadError(res.error?.message || 'Failed to load settings.');
    } catch (error: any) {
      console.error(error);
      setLoadError(error?.response?.data?.error?.message || error?.message || 'Failed to load settings.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSettings();
  }, []);

  const saveProviderSettings = async (includeApiKey: boolean) => {
    const payload: Record<string, unknown> = {
      apiProvider: settings.apiProvider,
      apiBaseUrl: settings.apiBaseUrl,
      model: settings.model,
      targetLanguage: settings.targetLanguage,
      style: settings.style,
      concurrency: settings.concurrency
    };

    if (includeApiKey && settings.apiKey.trim()) {
      payload.apiKey = settings.apiKey.trim();
    }

    return Client.updateSettings(payload);
  };

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);

    try {
      const res = await saveProviderSettings(true);
      if (res.success && res.data) {
        syncFromResponse(res.data);
        alert('Settings saved. The API key stays only in the current backend session unless you also write it to the local .env file.');
      } else {
        alert(`Save failed: ${res.error?.message || 'Unknown error'}`);
      }
    } catch (error) {
      console.error(error);
      alert('A network error occurred while saving settings.');
    } finally {
      setSaving(false);
    }
  };

  const handlePersistDotenv = async () => {
    if (!settings.apiKey.trim()) {
      alert('Enter an API key before writing it to the local .env file.');
      return;
    }

    setPersistingDotenv(true);
    try {
      const settingsRes = await saveProviderSettings(false);
      if (!settingsRes.success || !settingsRes.data) {
        alert(`Failed to save provider settings first: ${settingsRes.error?.message || 'Unknown error'}`);
        return;
      }

      const res = await Client.persistApiKeyToDotenv({ apiKey: settings.apiKey.trim() });
      if (res.success && res.data) {
        syncFromResponse(res.data);
        alert('The API key was written to the local .env file and will remain available after restart.');
      } else {
        alert(`.env write failed: ${res.error?.message || 'Unknown error'}`);
      }
    } catch (error) {
      console.error(error);
      alert('A network error occurred while writing the .env file.');
    } finally {
      setPersistingDotenv(false);
    }
  };

  const handleClearKey = async () => {
    setClearingKey(true);
    try {
      const scope = keySource === 'dotenv' ? 'all' : 'session';
      const res = await Client.clearApiKey({ scope });
      if (res.success && res.data) {
        syncFromResponse(res.data);
        setConnectionTest(null);
        alert(scope === 'all' ? 'The key was cleared from both the current backend session and the local .env file.' : 'The key was cleared from the current backend session.');
      } else {
        alert(`Key deletion failed: ${res.error?.message || 'Unknown error'}`);
      }
    } catch (error) {
      console.error(error);
      alert('A network error occurred while deleting the key.');
    } finally {
      setClearingKey(false);
    }
  };

  const handleTestConnection = async () => {
    setTestingConnection(true);
    try {
      const res = await Client.testConnection();
      if (res.success && res.data) {
        setConnectionTest(res.data);
      } else {
        alert(`Connection test failed: ${res.error?.message || 'Unknown error'}`);
      }
    } catch (error) {
      console.error(error);
      alert('A network error occurred while testing the connection.');
    } finally {
      setTestingConnection(false);
    }
  };

  if (loading) {
    return <div style={{ padding: '2rem', textAlign: 'center' }}>Loading settings...</div>;
  }

  if (loadError) {
    return (
      <div className="glass-panel" style={{ padding: '2rem', textAlign: 'center', maxWidth: '760px', margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '1rem', color: 'var(--danger-color)' }}>
          <AlertCircle size={24} />
        </div>
        <h1 style={{ marginBottom: '0.75rem', fontSize: '1.4rem' }}>Settings unavailable</h1>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.8, marginBottom: '1.25rem', whiteSpace: 'pre-wrap' }}>{loadError}</p>
        <button className="glass-button" onClick={loadSettings} style={{ padding: '0.8rem 1.4rem' }}>
          <RefreshCw size={16} /> Retry
        </button>
      </div>
    );
  }

  const keyStatusText =
    keySource === 'dotenv'
      ? `Configured through .env file${keyStorageKey ? ` (${keyStorageKey})` : ''}`
      : keySource === 'session'
        ? 'Injected into the current backend session'
        : 'No API key configured';

  const persistenceText =
    keyPersistence === 'dotenv-file'
      ? `.env file (${dotenvPath || '.env'})`
      : keyPersistence === 'memory-only'
        ? 'Current backend session only'
        : 'Disabled';

  return (
    <div className="glass-panel" style={{ padding: '2.5rem', maxWidth: '860px', margin: '0 auto', width: '100%', borderRadius: '16px' }}>
      <h1 style={{ marginBottom: '1rem', fontSize: '1.8rem', borderBottom: '2px solid var(--shadow-light)', paddingBottom: '1rem' }}>Engine Settings</h1>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '2rem', lineHeight: 1.7 }}>
        The backend uses an OpenAI Chat Completions compatible protocol and can target DeepSeek, LiteLLM, or another compatible gateway.
        API keys are never written into the task database. You can keep a key only in the current backend process or write it into the local <code>.env</code> file, which is already ignored by Git.
      </p>

      <div className="glass-panel" style={{ padding: '1rem 1.25rem', marginBottom: '1rem', borderRadius: '14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.4rem', fontWeight: 600 }}>
          <KeyRound size={16} /> Key status
        </div>
        <div style={{ color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          <div>{keyStatusText}{maskedKey ? `, current mask: ${maskedKey}` : ''}</div>
          <div>Persistence: {persistenceText}</div>
          <div>Storage path: {dotenvPath || '.env'}</div>
        </div>
      </div>

      <div className="glass-panel" style={{ padding: '1rem 1.25rem', marginBottom: '1rem', borderRadius: '14px' }}>
        <div style={{ fontWeight: 600, marginBottom: '0.4rem' }}>Currently effective configuration</div>
        <div style={{ color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          <div>Provider: {activeProvider}</div>
          <div>Model: {activeModel}</div>
          <div>Request endpoint: {effectiveApiEndpoint || 'Not configured'}</div>
          <div>Key source: {describeKeySource(keySource, keyStorageKey)}</div>
        </div>
      </div>

      <div className="glass-panel" style={{ padding: '1rem 1.25rem', marginBottom: '1.5rem', borderRadius: '14px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', marginBottom: '0.75rem' }}>
          <div style={{ fontWeight: 600 }}>Connection test</div>
          <button type="button" className="glass-button" onClick={handleTestConnection} disabled={testingConnection} style={{ padding: '0.7rem 1.4rem' }}>
            {testingConnection ? 'Testing...' : 'Test effective configuration'}
          </button>
        </div>
        {connectionTest ? (
          <div style={{ color: connectionTest.result.ok ? 'var(--success-color)' : 'var(--danger-color)', lineHeight: 1.8, wordBreak: 'break-word' }}>
            <div>Result: {connectionTest.result.ok ? 'Connected' : 'Failed'}</div>
            <div>Request URL: {connectionTest.result.url || connectionTest.effectiveApiEndpoint || 'Not configured'}</div>
            <div>HTTP status: {connectionTest.result.status || 'No response'}</div>
            <div>Latency: {connectionTest.result.latencyMs || 0} ms</div>
            <div>Tested at: {new Date(connectionTest.testedAt).toLocaleString()}</div>
            {connectionTest.result.preview ? <div>Response preview: {connectionTest.result.preview}</div> : null}
            {connectionTest.result.error ? <div>Error: {connectionTest.result.error}</div> : null}
          </div>
        ) : (
          <div style={{ color: 'var(--text-secondary)', lineHeight: 1.7 }}>
            This sends one minimal Chat Completions request with the currently saved provider, model, base URL, and key so you can verify the exact endpoint and response status.
          </div>
        )}
      </div>

      <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
          <div>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>API Provider</label>
            <select className="glass-input" value={settings.apiProvider} onChange={(event) => setSettings({ ...settings, apiProvider: event.target.value })}>
              <option value="DeepSeek">DeepSeek</option>
              <option value="LiteLLM">LiteLLM</option>
              <option value="OpenAI-Compatible">OpenAI-Compatible</option>
            </select>
          </div>

          <div>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>Model</label>
            <input type="text" className="glass-input" value={settings.model} onChange={(event) => setSettings({ ...settings, model: event.target.value })} placeholder="deepseek-chat" />
          </div>
        </div>

        <div>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>API Base URL</label>
          <input
            type="text"
            className="glass-input"
            value={settings.apiBaseUrl}
            onChange={(event) => setSettings({ ...settings, apiBaseUrl: event.target.value })}
            placeholder="http://127.0.0.1:4000/v1"
          />
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '0.5rem' }}>
            Enter the gateway root, for example <code>http://127.0.0.1:4000/v1</code>. The backend appends <code>/chat/completions</code> automatically.
          </p>
        </div>

        <div>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>API Key</label>
          <input
            type="password"
            className="glass-input"
            value={settings.apiKey}
            onChange={(event) => setSettings({ ...settings, apiKey: event.target.value })}
            placeholder={hasKey ? 'Leave blank to keep the current key' : 'sk-xxxxxxxxxxxxxxxxxxxxxxxx'}
            required={!hasKey}
          />
          <p style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: hasKey ? 'var(--text-secondary)' : 'var(--danger-color)', fontSize: '0.85rem', marginTop: '0.5rem' }}>
            <AlertCircle size={14} />
            {hasKey
              ? 'Save injects the entered key into the current backend session. Write to .env file persists it locally across restarts.'
              : 'An API key is required before starting translation.'}
          </p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
          <div>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>Target Language</label>
            <input type="text" className="glass-input" value={settings.targetLanguage} onChange={(event) => setSettings({ ...settings, targetLanguage: event.target.value })} />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>Style Prompt</label>
            <input type="text" className="glass-input" value={settings.style} onChange={(event) => setSettings({ ...settings, style: event.target.value })} />
          </div>
        </div>

        <div>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>Concurrency</label>
          <input
            type="number"
            min={1}
            className="glass-input"
            value={settings.concurrency}
            onChange={(event) => setSettings({ ...settings, concurrency: Number(event.target.value) || 1 })}
          />
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
          <button type="submit" className="glass-button primary" disabled={saving} style={{ padding: '0.8rem 2rem' }}>
            <Save size={18} />
            {saving ? 'Saving...' : 'Save to current session'}
          </button>

          <button
            type="button"
            className="glass-button"
            disabled={persistingDotenv}
            onClick={handlePersistDotenv}
            style={{ padding: '0.8rem 2rem' }}
          >
            <KeyRound size={18} />
            {persistingDotenv ? 'Writing...' : 'Write to .env file'}
          </button>

          <button
            type="button"
            className="glass-button"
            disabled={clearingKey || !hasKey}
            onClick={handleClearKey}
            style={{ padding: '0.8rem 2rem' }}
          >
            <Trash2 size={18} />
            {clearingKey ? 'Clearing...' : 'Delete current key'}
          </button>
        </div>
      </form>
    </div>
  );
}
