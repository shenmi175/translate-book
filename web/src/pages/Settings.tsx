import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { AlertCircle, Globe, KeyRound, RefreshCw, Save, Trash2 } from 'lucide-react';
import { Client, type ConnectionTestResult } from '../api';
import { clearStoredAccessToken, setStoredAccessToken } from '../auth';
import { useI18n } from '../i18n';
import { getAppRuntimeConfig } from '../runtime';

type SettingsForm = {
  apiProvider: string;
  apiBaseUrl: string;
  apiKey: string;
  accessToken: string;
  model: string;
  targetLanguage: string;
  style: string;
  concurrency: number;
  publicBaseUrl: string;
  trustProxyHeaders: boolean;
};

type KeySource = 'none' | 'dotenv' | 'session' | 'environment';

type SettingsResponse = {
  apiProvider?: string;
  apiBaseUrl?: string;
  model?: string;
  targetLanguage?: string;
  style?: string;
  concurrency?: number;
  publicBaseUrl?: string;
  publicApiBaseUrl?: string;
  publicBasePath?: string;
  trustProxyHeaders?: boolean;
  hasApiKey?: boolean;
  maskedApiKey?: string;
  apiKeySource?: 'none' | 'dotenv' | 'session' | 'env' | 'environment';
  apiKeyStorageKey?: string;
  apiKeyPersistence?: string;
  apiKeyDotenvPath?: string;
  hasAccessToken?: boolean;
  maskedAccessToken?: string;
  accessTokenSource?: 'none' | 'dotenv' | 'session' | 'env' | 'environment';
  accessTokenStorageKey?: string;
  accessTokenPersistence?: string;
  accessTokenDotenvPath?: string;
  authRequired?: boolean;
  effectiveApiEndpoint?: string;
};

const runtime = getAppRuntimeConfig();

const DEFAULT_FORM: SettingsForm = {
  apiProvider: 'DeepSeek',
  apiBaseUrl: 'https://api.deepseek.com',
  apiKey: '',
  accessToken: '',
  model: 'deepseek-chat',
  targetLanguage: 'Chinese',
  style: 'Accurate, natural, professional, concise',
  concurrency: 4,
  publicBaseUrl: '',
  trustProxyHeaders: false
};

function normalizeKeySource(source?: 'none' | 'dotenv' | 'session' | 'env' | 'environment'): KeySource {
  if (source === 'env' || source === 'environment') {
    return 'environment';
  }
  if (source === 'dotenv' || source === 'session') {
    return source;
  }
  return 'none';
}

function normalizeBasePath(value = '') {
  const trimmed = String(value || '').trim();
  if (!trimmed || trimmed === '/') {
    return '';
  }
  const normalized = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return normalized.replace(/\/+$/, '') || '';
}

function derivePublicUrls(publicBaseUrl: string) {
  const fallback = runtime.publicBaseUrl || window.location.origin;
  const normalized = String(publicBaseUrl || fallback).trim().replace(/\/+$/, '');

  try {
    const parsed = new URL(normalized);
    const basePath = normalizeBasePath(parsed.pathname);
    const entry = basePath ? `${parsed.origin}${basePath}` : parsed.origin;
    return {
      publicEntryUrl: entry,
      publicApiUrl: `${entry}/api`,
      publicBasePath: basePath || '/'
    };
  } catch {
    return {
      publicEntryUrl: normalized,
      publicApiUrl: normalized ? `${normalized}/api` : '',
      publicBasePath: '/'
    };
  }
}

function buildSuffix(value: string) {
  return value ? ` (${value})` : '';
}

function parsePublicUrlForSnippet(publicBaseUrl: string) {
  const fallback = new URL('https://books.example.com');
  const candidate = publicBaseUrl.trim();

  if (!candidate) {
    return fallback;
  }

  try {
    return new URL(candidate.startsWith('http://') || candidate.startsWith('https://') ? candidate : `https://${candidate}`);
  } catch {
    return fallback;
  }
}

export default function Settings() {
  const { t, dateLocale } = useI18n();
  const [settings, setSettings] = useState<SettingsForm>(DEFAULT_FORM);
  const [hasKey, setHasKey] = useState(false);
  const [maskedKey, setMaskedKey] = useState('');
  const [keySource, setKeySource] = useState<KeySource>('none');
  const [keyPersistence, setKeyPersistence] = useState('none');
  const [keyStorageKey, setKeyStorageKey] = useState('');
  const [hasAccessToken, setHasAccessToken] = useState(false);
  const [maskedAccessToken, setMaskedAccessToken] = useState('');
  const [accessTokenSource, setAccessTokenSource] = useState<KeySource>('none');
  const [accessTokenPersistence, setAccessTokenPersistence] = useState('none');
  const [accessTokenStorageKey, setAccessTokenStorageKey] = useState('');
  const [authRequired, setAuthRequired] = useState(false);
  const [dotenvPath, setDotenvPath] = useState('');
  const [effectiveApiEndpoint, setEffectiveApiEndpoint] = useState('');
  const [activeProvider, setActiveProvider] = useState('DeepSeek');
  const [activeModel, setActiveModel] = useState('deepseek-chat');
  const [publicApiBaseUrl, setPublicApiBaseUrl] = useState('');
  const [publicBasePath, setPublicBasePath] = useState('/');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [persistingDotenv, setPersistingDotenv] = useState(false);
  const [persistingAccessTokenDotenv, setPersistingAccessTokenDotenv] = useState(false);
  const [clearingKey, setClearingKey] = useState(false);
  const [clearingAccessToken, setClearingAccessToken] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionTest, setConnectionTest] = useState<ConnectionTestResult | null>(null);

  const syncFromResponse = (data: SettingsResponse) => {
    const source = normalizeKeySource(data?.apiKeySource);
    setHasKey(Boolean(data?.hasApiKey));
    setMaskedKey(data?.maskedApiKey || '');
    setKeySource(source);
    setKeyPersistence(data?.apiKeyPersistence || 'none');
    setKeyStorageKey(data?.apiKeyStorageKey || 'MARKDOWN_TRANSLATOR_API_KEY');
    setHasAccessToken(Boolean(data?.hasAccessToken));
    setMaskedAccessToken(data?.maskedAccessToken || '');
    setAccessTokenSource(normalizeKeySource(data?.accessTokenSource));
    setAccessTokenPersistence(data?.accessTokenPersistence || 'none');
    setAccessTokenStorageKey(data?.accessTokenStorageKey || 'MARKDOWN_TRANSLATOR_ACCESS_TOKEN');
    setAuthRequired(Boolean(data?.authRequired));
    setDotenvPath(data?.apiKeyDotenvPath || data?.accessTokenDotenvPath || '.env');
    setEffectiveApiEndpoint(data?.effectiveApiEndpoint || '');
    setActiveProvider(data?.apiProvider || 'DeepSeek');
    setActiveModel(data?.model || 'deepseek-chat');
    setPublicApiBaseUrl(data?.publicApiBaseUrl || '');
    setPublicBasePath(data?.publicBasePath || '/');
    setSettings({
      apiProvider: data?.apiProvider || DEFAULT_FORM.apiProvider,
      apiBaseUrl: data?.apiBaseUrl || DEFAULT_FORM.apiBaseUrl,
      apiKey: '',
      accessToken: '',
      model: data?.model || DEFAULT_FORM.model,
      targetLanguage: data?.targetLanguage || DEFAULT_FORM.targetLanguage,
      style: data?.style || DEFAULT_FORM.style,
      concurrency: Number.isInteger(data?.concurrency) ? Number(data.concurrency) : DEFAULT_FORM.concurrency,
      publicBaseUrl: data?.publicBaseUrl || '',
      trustProxyHeaders: Boolean(data?.trustProxyHeaders)
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
      setLoadError(res.error?.message || t('settings.loadFailed'));
    } catch (error: any) {
      console.error(error);
      setLoadError(error?.response?.data?.error?.message || error?.message || t('settings.loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSettings();
  }, []);

  const publicUrls = useMemo(() => derivePublicUrls(settings.publicBaseUrl), [settings.publicBaseUrl]);

  const saveProviderSettings = async (includeApiKey: boolean) => {
    const payload: Record<string, unknown> = {
      apiProvider: settings.apiProvider,
      apiBaseUrl: settings.apiBaseUrl,
      model: settings.model,
      targetLanguage: settings.targetLanguage,
      style: settings.style,
      concurrency: settings.concurrency,
      publicBaseUrl: settings.publicBaseUrl.trim(),
      trustProxyHeaders: settings.trustProxyHeaders
    };

    if (includeApiKey && settings.apiKey.trim()) {
      payload.apiKey = settings.apiKey.trim();
    }

    if (settings.accessToken.trim()) {
      payload.accessToken = settings.accessToken.trim();
    }

    return Client.updateSettings(payload);
  };

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);

    try {
      const res = await saveProviderSettings(true);
      if (res.success && res.data) {
        if (settings.accessToken.trim()) {
          setStoredAccessToken(settings.accessToken.trim());
        }
        syncFromResponse(res.data);
        alert(t('settings.saved'));
      } else {
        alert(t('settings.saveFailed', { message: res.error?.message || t('common.failed') }));
      }
    } catch (error) {
      console.error(error);
      alert(t('settings.saveNetworkError'));
    } finally {
      setSaving(false);
    }
  };

  const handlePersistDotenv = async () => {
    if (!settings.apiKey.trim()) {
      alert(t('settings.enterApiKeyFirst'));
      return;
    }

    setPersistingDotenv(true);
    try {
      const settingsRes = await saveProviderSettings(false);
      if (!settingsRes.success || !settingsRes.data) {
        alert(t('settings.saveProviderFirst', { message: settingsRes.error?.message || t('common.failed') }));
        return;
      }

      const res = await Client.persistApiKeyToDotenv({ apiKey: settings.apiKey.trim() });
      if (res.success && res.data) {
        syncFromResponse(res.data);
        alert(t('settings.dotenvSaved'));
      } else {
        alert(t('settings.dotenvFailed', { message: res.error?.message || t('common.failed') }));
      }
    } catch (error) {
      console.error(error);
      alert(t('settings.dotenvNetworkError'));
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
        alert(scope === 'all' ? t('settings.keyClearedAll') : t('settings.keyClearedSession'));
      } else {
        alert(t('settings.keyDeleteFailed', { message: res.error?.message || t('common.failed') }));
      }
    } catch (error) {
      console.error(error);
      alert(t('settings.keyDeleteNetworkError'));
    } finally {
      setClearingKey(false);
    }
  };

  const handleClearAccessToken = async () => {
    setClearingAccessToken(true);
    try {
      const scope = accessTokenSource === 'dotenv' ? 'all' : 'session';
      const res = await Client.clearAccessToken({ scope });
      if (res.success && res.data) {
        syncFromResponse(res.data);
        clearStoredAccessToken();
        setSettings((current) => ({ ...current, accessToken: '' }));
        alert(scope === 'all' ? t('settings.accessTokenClearedAll') : t('settings.accessTokenClearedSession'));
      } else {
        alert(t('settings.accessTokenDeleteFailed', { message: res.error?.message || t('common.failed') }));
      }
    } catch (error) {
      console.error(error);
      alert(t('settings.accessTokenDeleteNetworkError'));
    } finally {
      setClearingAccessToken(false);
    }
  };

  const handlePersistAccessTokenDotenv = async () => {
    if (!settings.accessToken.trim()) {
      alert(t('settings.enterAccessTokenFirst'));
      return;
    }

    setPersistingAccessTokenDotenv(true);
    try {
      const settingsRes = await saveProviderSettings(false);
      if (!settingsRes.success || !settingsRes.data) {
        alert(t('settings.saveProviderFirst', { message: settingsRes.error?.message || t('common.failed') }));
        return;
      }

      const res = await Client.persistAccessTokenToDotenv({ accessToken: settings.accessToken.trim() });
      if (res.success && res.data) {
        syncFromResponse(res.data);
        setStoredAccessToken(settings.accessToken.trim());
        alert(t('settings.accessTokenDotenvSaved'));
      } else {
        alert(t('settings.accessTokenDotenvFailed', { message: res.error?.message || t('common.failed') }));
      }
    } catch (error) {
      console.error(error);
      alert(t('settings.accessTokenDotenvNetworkError'));
    } finally {
      setPersistingAccessTokenDotenv(false);
    }
  };

  const handleTestConnection = async () => {
    setTestingConnection(true);
    try {
      const res = await Client.testConnection();
      if (res.success && res.data) {
        setConnectionTest(res.data);
      } else {
        alert(t('settings.connectionFailed', { message: res.error?.message || t('common.failed') }));
      }
    } catch (error) {
      console.error(error);
      alert(t('settings.connectionNetworkError'));
    } finally {
      setTestingConnection(false);
    }
  };

  const keyStatusText =
    !hasKey
      ? t('settings.key.none')
      : keyPersistence === 'environment'
        ? t('settings.key.environment', { suffix: buildSuffix(keyStorageKey) })
        : keySource === 'dotenv'
          ? t('settings.key.dotenv', { suffix: buildSuffix(keyStorageKey) })
          : keySource === 'session'
            ? t('settings.key.session')
            : t('settings.key.none');

  const persistenceText =
    keyPersistence === 'environment'
      ? t('settings.persistence.environment', { suffix: buildSuffix(keyStorageKey) })
      : keyPersistence === 'dotenv-file'
        ? t('settings.persistence.dotenv-file', { path: dotenvPath || '.env' })
        : keyPersistence === 'memory-only'
          ? t('settings.persistence.memory-only')
          : t('settings.persistence.none');

  const keySourceText =
    keySource === 'dotenv'
      ? t('settings.keySource.dotenv', { suffix: buildSuffix(keyStorageKey) })
      : keySource === 'session'
        ? t('settings.keySource.session')
        : keyPersistence === 'environment'
          ? t('settings.keySource.environment', { suffix: buildSuffix(keyStorageKey) })
          : t('settings.keySource.none');

  const accessTokenStatusText =
    !hasAccessToken
      ? t('settings.accessToken.none')
      : accessTokenPersistence === 'environment'
        ? t('settings.accessToken.environment', { suffix: buildSuffix(accessTokenStorageKey) })
        : accessTokenSource === 'dotenv'
          ? t('settings.accessToken.dotenv', { suffix: buildSuffix(accessTokenStorageKey) })
          : accessTokenSource === 'session'
            ? t('settings.accessToken.session')
            : t('settings.accessToken.none');

  const accessTokenPersistenceText =
    accessTokenPersistence === 'environment'
      ? t('settings.persistence.environment', { suffix: buildSuffix(accessTokenStorageKey) })
      : accessTokenPersistence === 'dotenv-file'
        ? t('settings.persistence.dotenv-file', { path: dotenvPath || '.env' })
        : accessTokenPersistence === 'memory-only'
          ? t('settings.persistence.memory-only')
          : t('settings.persistence.none');

  const previewPublicEntry = publicUrls.publicEntryUrl || runtime.publicBaseUrl || window.location.origin;
  const previewPublicApi = settings.publicBaseUrl.trim() ? publicUrls.publicApiUrl : publicApiBaseUrl || publicUrls.publicApiUrl;
  const previewPublicBasePath = settings.publicBaseUrl.trim() ? publicUrls.publicBasePath : publicBasePath || publicUrls.publicBasePath;

  const nginxSnippet = useMemo(() => {
    const parsed = parsePublicUrlForSnippet(settings.publicBaseUrl);
    const host = parsed.host || 'books.example.com';
    const basePath = normalizeBasePath(parsed.pathname);
    const locationPath = basePath ? `${basePath}/` : '/';
    const forwardedPrefix = basePath ? `\n    proxy_set_header X-Forwarded-Prefix ${basePath};` : '';

    return `server {
  listen 80;
  server_name ${host};

  location ${locationPath} {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;${forwardedPrefix}
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}`;
  }, [settings.publicBaseUrl]);

  const caddySnippet = useMemo(() => {
    const parsed = parsePublicUrlForSnippet(settings.publicBaseUrl);
    const host = parsed.host || 'books.example.com';
    const basePath = normalizeBasePath(parsed.pathname);
    const matcher = basePath ? `${basePath}*` : '';
    const prefixHeader = basePath ? `\n      header_up X-Forwarded-Prefix ${basePath}` : '';

    if (basePath) {
      return `${host} {
  handle ${matcher} {
    reverse_proxy 127.0.0.1:8787 {
      header_up X-Forwarded-Host {host}
      header_up X-Forwarded-Proto {scheme}${prefixHeader}
    }
  }
}`;
    }

    return `${host} {
  reverse_proxy 127.0.0.1:8787 {
    header_up X-Forwarded-Host {host}
    header_up X-Forwarded-Proto {scheme}
  }
}`;
  }, [settings.publicBaseUrl]);

  const overviewGridStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 390px), 1fr))',
    gap: '1.25rem',
    marginBottom: '1.5rem'
  };

  const twoColumnGridStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))',
    gap: '1.25rem'
  };

  const snippetGridStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))',
    gap: '1rem',
    marginTop: '1rem'
  };

  const summaryCardStyle: CSSProperties = {
    padding: '1.15rem 1.35rem',
    borderRadius: '16px',
    minHeight: '150px'
  };

  const cardBodyStyle: CSSProperties = {
    color: 'var(--text-secondary)',
    lineHeight: 1.75,
    overflowWrap: 'anywhere',
    wordBreak: 'break-word'
  };

  if (loading) {
    return <div style={{ padding: '2rem', textAlign: 'center' }}>{t('settings.loading')}</div>;
  }

  if (loadError) {
    return (
      <div className="glass-panel" style={{ padding: '2rem', textAlign: 'center', maxWidth: '760px', margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '1rem', color: 'var(--danger-color)' }}>
          <AlertCircle size={24} />
        </div>
        <h1 style={{ marginBottom: '0.75rem', fontSize: '1.4rem' }}>{t('settings.unavailable')}</h1>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.8, marginBottom: '1.25rem', whiteSpace: 'pre-wrap' }}>{loadError}</p>
        <button className="glass-button" onClick={loadSettings} style={{ padding: '0.8rem 1.4rem' }}>
          <RefreshCw size={16} /> {t('common.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="glass-panel" style={{ padding: '2.75rem', maxWidth: '1160px', margin: '0 auto', width: '100%', borderRadius: '20px' }}>
      <h1 style={{ marginBottom: '1rem', fontSize: '1.8rem', borderBottom: '2px solid var(--shadow-light)', paddingBottom: '1rem' }}>{t('settings.title')}</h1>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '2rem', lineHeight: 1.8, maxWidth: '920px' }}>{t('settings.description')}</p>

      <div style={overviewGridStyle}>
        <div className="glass-panel" style={summaryCardStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.4rem', fontWeight: 600 }}>
            <KeyRound size={16} /> {t('settings.keyStatus')}
          </div>
          <div style={cardBodyStyle}>
            <div>{keyStatusText}{maskedKey ? `, ${t('settings.currentMask')}: ${maskedKey}` : ''}</div>
            <div>{t('settings.persistence')}: {persistenceText}</div>
            <div>{t('settings.storagePath')}: {dotenvPath || '.env'}</div>
          </div>
        </div>

        <div className="glass-panel" style={summaryCardStyle}>
          <div style={{ fontWeight: 600, marginBottom: '0.4rem' }}>{t('settings.effectiveConfig')}</div>
          <div style={cardBodyStyle}>
            <div>{t('settings.provider')}: {activeProvider}</div>
            <div>{t('settings.model')}: {activeModel}</div>
            <div>{t('settings.endpoint')}: {effectiveApiEndpoint || t('settings.notConfigured')}</div>
            <div>{t('settings.keySource')}: {keySourceText}</div>
          </div>
        </div>

        <div className="glass-panel" style={summaryCardStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.4rem', fontWeight: 600 }}>
            <Globe size={16} /> {t('settings.reverseProxy')}
          </div>
          <div style={cardBodyStyle}>
            <div>{t('settings.publicEntry')}: {previewPublicEntry || t('settings.notConfigured')}</div>
            <div>{t('settings.publicApi')}: {previewPublicApi || t('settings.notConfigured')}</div>
            <div>{t('settings.publicBasePath')}: {previewPublicBasePath}</div>
          </div>
        </div>

        <div className="glass-panel" style={summaryCardStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.4rem', fontWeight: 600 }}>
            <KeyRound size={16} /> {t('settings.accessProtection')}
          </div>
          <div style={cardBodyStyle}>
            <div>{t('settings.authRequired')}: {authRequired ? t('common.enabled') : t('common.disabled')}</div>
            <div>{accessTokenStatusText}{maskedAccessToken ? `, ${t('settings.currentMask')}: ${maskedAccessToken}` : ''}</div>
            <div>{t('settings.persistence')}: {accessTokenPersistenceText}</div>
          </div>
        </div>
      </div>

      <div className="glass-panel" style={{ padding: '1.25rem 1.5rem', marginBottom: '1.5rem', borderRadius: '16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', marginBottom: '0.75rem' }}>
          <div style={{ fontWeight: 600 }}>{t('settings.connectionTest')}</div>
          <button type="button" className="glass-button" onClick={handleTestConnection} disabled={testingConnection} style={{ padding: '0.7rem 1.4rem' }}>
            {testingConnection ? t('settings.connectionTesting') : t('settings.connectionTestAction')}
          </button>
        </div>
        {connectionTest ? (
          <div style={{ color: connectionTest.result.ok ? 'var(--success-color)' : 'var(--danger-color)', lineHeight: 1.8, wordBreak: 'break-word' }}>
            <div>{t('settings.result')}: {connectionTest.result.ok ? t('settings.connected') : t('common.failed')}</div>
            <div>{t('settings.requestUrl')}: {connectionTest.result.url || connectionTest.effectiveApiEndpoint || t('settings.notConfigured')}</div>
            <div>{t('settings.httpStatus')}: {connectionTest.result.status || t('common.notAvailable')}</div>
            <div>{t('settings.latency')}: {connectionTest.result.latencyMs || 0} {t('common.ms')}</div>
            <div>{t('settings.testedAt')}: {new Date(connectionTest.testedAt).toLocaleString(dateLocale)}</div>
            {connectionTest.result.preview ? <div>{t('settings.responsePreview')}: {connectionTest.result.preview}</div> : null}
            {connectionTest.result.error ? <div>{t('settings.error')}: {connectionTest.result.error}</div> : null}
          </div>
        ) : (
          <div style={{ color: 'var(--text-secondary)', lineHeight: 1.7 }}>{t('settings.connectionHint')}</div>
        )}
      </div>

      <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        <div style={twoColumnGridStyle}>
          <div>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>{t('settings.apiProvider')}</label>
            <select className="glass-input" value={settings.apiProvider} onChange={(event) => setSettings({ ...settings, apiProvider: event.target.value })}>
              <option value="DeepSeek">DeepSeek</option>
              <option value="LiteLLM">LiteLLM</option>
              <option value="OpenAI-Compatible">OpenAI-Compatible</option>
            </select>
          </div>

          <div>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>{t('settings.model')}</label>
            <input type="text" className="glass-input" value={settings.model} onChange={(event) => setSettings({ ...settings, model: event.target.value })} placeholder="deepseek-chat" />
          </div>
        </div>

        <div>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>{t('settings.apiBaseUrl')}</label>
          <input
            type="text"
            className="glass-input"
            value={settings.apiBaseUrl}
            onChange={(event) => setSettings({ ...settings, apiBaseUrl: event.target.value })}
            placeholder="http://127.0.0.1:4000/v1"
          />
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '0.5rem' }}>{t('settings.apiBaseUrlHint')}</p>
        </div>

        <div>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>{t('settings.apiKey')}</label>
          <input
            type="password"
            className="glass-input"
            value={settings.apiKey}
            onChange={(event) => setSettings({ ...settings, apiKey: event.target.value })}
            placeholder={hasKey ? t('settings.keepCurrentKey') : t('settings.apiKeyPlaceholder')}
            required={!hasKey}
          />
          <p style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: hasKey ? 'var(--text-secondary)' : 'var(--danger-color)', fontSize: '0.85rem', marginTop: '0.5rem' }}>
            <AlertCircle size={14} />
            {hasKey ? t('settings.apiKeyHintSaved') : t('settings.apiKeyHintMissing')}
          </p>
        </div>

        <div style={twoColumnGridStyle}>
          <div>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>{t('settings.targetLanguage')}</label>
            <input type="text" className="glass-input" value={settings.targetLanguage} onChange={(event) => setSettings({ ...settings, targetLanguage: event.target.value })} />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>{t('settings.style')}</label>
            <input type="text" className="glass-input" value={settings.style} onChange={(event) => setSettings({ ...settings, style: event.target.value })} />
          </div>
        </div>

        <div>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>{t('settings.concurrency')}</label>
          <input
            type="number"
            min={1}
            className="glass-input"
            value={settings.concurrency}
            onChange={(event) => setSettings({ ...settings, concurrency: Number(event.target.value) || 1 })}
          />
        </div>

        <div className="glass-panel" style={{ padding: '1.5rem', borderRadius: '16px' }}>
          <div style={{ fontWeight: 600, marginBottom: '1rem' }}>{t('settings.reverseProxy')}</div>
          <div style={twoColumnGridStyle}>
            <div>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>{t('settings.publicBaseUrl')}</label>
              <input
                type="text"
                className="glass-input"
                value={settings.publicBaseUrl}
                onChange={(event) => setSettings({ ...settings, publicBaseUrl: event.target.value })}
                placeholder="https://books.example.com/translator"
              />
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '0.5rem', lineHeight: 1.7 }}>{t('settings.publicBaseUrlHint')}</p>
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>{t('settings.trustProxyHeaders')}</label>
              <label className="glass-input" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={settings.trustProxyHeaders}
                  onChange={(event) => setSettings({ ...settings, trustProxyHeaders: event.target.checked })}
                />
                <span>{settings.trustProxyHeaders ? t('common.enabled') : t('common.disabled')}</span>
              </label>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '0.5rem', lineHeight: 1.7 }}>{t('settings.trustProxyHeadersHint')}</p>
            </div>
          </div>

          <div style={{ marginTop: '1rem', color: 'var(--text-secondary)', lineHeight: 1.8 }}>
            <div>{t('settings.publicEntry')}: {publicUrls.publicEntryUrl || t('settings.notConfigured')}</div>
            <div>{t('settings.publicApi')}: {publicUrls.publicApiUrl || t('settings.notConfigured')}</div>
            <div>{t('settings.publicBasePath')}: {publicUrls.publicBasePath}</div>
          </div>

          <p style={{ color: 'var(--text-secondary)', marginTop: '1rem', lineHeight: 1.7 }}>{t('settings.proxySnippetHint')}</p>

          <div style={snippetGridStyle}>
            <div>
              <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>{t('settings.nginxSnippet')}</div>
              <pre style={{ margin: 0, padding: '1rem', borderRadius: '12px', background: 'var(--shadow-light)', boxShadow: 'var(--neu-shadow-inset)', overflowX: 'auto', whiteSpace: 'pre-wrap' }}>
                {nginxSnippet}
              </pre>
            </div>
            <div>
              <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>{t('settings.caddySnippet')}</div>
              <pre style={{ margin: 0, padding: '1rem', borderRadius: '12px', background: 'var(--shadow-light)', boxShadow: 'var(--neu-shadow-inset)', overflowX: 'auto', whiteSpace: 'pre-wrap' }}>
                {caddySnippet}
              </pre>
            </div>
          </div>
        </div>

        <div className="glass-panel" style={{ padding: '1.5rem', borderRadius: '16px' }}>
          <div style={{ fontWeight: 600, marginBottom: '1rem' }}>{t('settings.accessProtection')}</div>
          <div>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>{t('settings.accessToken')}</label>
            <input
              type="password"
              className="glass-input"
              value={settings.accessToken}
              onChange={(event) => setSettings({ ...settings, accessToken: event.target.value })}
              placeholder={hasAccessToken ? t('settings.keepCurrentAccessToken') : 'translator-access-token'}
            />
            <p style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '0.5rem', lineHeight: 1.7 }}>
              <AlertCircle size={14} />
              {t('settings.accessTokenHint')}
            </p>
          </div>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '1rem' }}>
            <button
              type="button"
              className="glass-button"
              disabled={persistingAccessTokenDotenv}
              onClick={handlePersistAccessTokenDotenv}
              style={{ padding: '0.8rem 1.4rem' }}
            >
              <KeyRound size={18} />
              {persistingAccessTokenDotenv ? t('settings.writingDotenv') : t('settings.writeAccessTokenDotenv')}
            </button>
            <button
              type="button"
              className="glass-button"
              disabled={clearingAccessToken || !hasAccessToken}
              onClick={handleClearAccessToken}
              style={{ padding: '0.8rem 1.4rem' }}
            >
              <Trash2 size={18} />
              {clearingAccessToken ? t('settings.clearingAccessToken') : t('settings.deleteAccessToken')}
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
          <button type="submit" className="glass-button primary" disabled={saving} style={{ padding: '0.8rem 2rem' }}>
            <Save size={18} />
            {saving ? t('settings.saving') : t('settings.saveSession')}
          </button>

          <button
            type="button"
            className="glass-button"
            disabled={persistingDotenv}
            onClick={handlePersistDotenv}
            style={{ padding: '0.8rem 2rem' }}
          >
            <KeyRound size={18} />
            {persistingDotenv ? t('settings.writingDotenv') : t('settings.writeDotenv')}
          </button>

          <button
            type="button"
            className="glass-button"
            disabled={clearingKey || !hasKey}
            onClick={handleClearKey}
            style={{ padding: '0.8rem 2rem' }}
          >
            <Trash2 size={18} />
            {clearingKey ? t('settings.clearingKey') : t('settings.deleteKey')}
          </button>
        </div>
      </form>
    </div>
  );
}
