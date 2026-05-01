import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import {
  Activity,
  AlertCircle,
  Bot,
  Globe,
  KeyRound,
  Languages,
  LayoutDashboard,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2
} from 'lucide-react';
import { NavLink, Navigate, useLocation } from 'react-router-dom';
import { Client, type ConnectionTestResult } from '../api';
import { clearStoredAccessToken, setStoredAccessToken } from '../auth';
import { useI18n } from '../i18n';
import { getAppRuntimeConfig } from '../runtime';

type SettingsForm = {
  apiProvider: string;
  apiBaseUrl: string;
  apiProtocol: string;
  apiKey: string;
  accessToken: string;
  model: string;
  targetLanguage: string;
  style: string;
  concurrency: number;
  publicBaseUrl: string;
  trustProxyHeaders: boolean;
};

type KeySource = 'none' | 'dotenv' | 'session' | 'environment' | 'database';
type SettingsSectionKey = 'overview' | 'engine' | 'translation' | 'security' | 'network' | 'diagnostics';

type SettingsResponse = {
  apiProvider?: string;
  apiBaseUrl?: string;
  apiProtocol?: string;
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
  apiKeySource?: 'none' | 'dotenv' | 'session' | 'env' | 'environment' | 'database';
  apiKeyStorageKey?: string;
  apiKeyPersistence?: string;
  apiKeyDotenvPath?: string;
  hasAccessToken?: boolean;
  maskedAccessToken?: string;
  accessTokenSource?: 'none' | 'dotenv' | 'session' | 'env' | 'environment' | 'database';
  accessTokenStorageKey?: string;
  accessTokenPersistence?: string;
  accessTokenDotenvPath?: string;
  stateStorePath?: string;
  authRequired?: boolean;
  effectiveApiEndpoint?: string;
};

const runtime = getAppRuntimeConfig();

const DEFAULT_FORM: SettingsForm = {
  apiProvider: 'DeepSeek',
  apiBaseUrl: 'https://api.deepseek.com',
  apiProtocol: 'chat_completions',
  apiKey: '',
  accessToken: '',
  model: 'deepseek-chat',
  targetLanguage: 'Chinese',
  style: 'Accurate, natural, professional, concise',
  concurrency: 4,
  publicBaseUrl: '',
  trustProxyHeaders: false
};

function normalizeKeySource(source?: 'none' | 'dotenv' | 'session' | 'env' | 'environment' | 'database'): KeySource {
  if (source === 'env' || source === 'environment') {
    return 'environment';
  }
  if (source === 'dotenv' || source === 'session' || source === 'database') {
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

function extractApiErrorMessage(error: any, fallback: string) {
  return error?.response?.data?.error?.message || error?.message || fallback;
}

function SettingsSummaryCard({
  title,
  icon,
  children,
  minHeight = '150px'
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  minHeight?: string;
}) {
  return (
    <div
      className="glass-panel"
      style={{
        padding: '1.15rem 1.35rem',
        borderRadius: '16px',
        minHeight
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.45rem', fontWeight: 700 }}>
        {icon}
        <span>{title}</span>
      </div>
      <div style={{ color: 'var(--text-secondary)', lineHeight: 1.75, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
        {children}
      </div>
    </div>
  );
}

function SettingsSectionCard({
  title,
  description,
  children
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="glass-panel" style={{ padding: '1.5rem', borderRadius: '18px', display: 'flex', flexDirection: 'column', gap: '1.2rem' }}>
      <div>
        <div style={{ fontSize: '1.08rem', fontWeight: 700 }}>{title}</div>
        {description ? (
          <div style={{ marginTop: '0.4rem', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
            {description}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export default function Settings() {
  const { t, dateLocale } = useI18n();
  const location = useLocation();
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
  const [stateStorePath, setStateStorePath] = useState('');
  const [effectiveApiEndpoint, setEffectiveApiEndpoint] = useState('');
  const [activeProvider, setActiveProvider] = useState('DeepSeek');
  const [activeModel, setActiveModel] = useState('deepseek-chat');
  const [activeProtocol, setActiveProtocol] = useState('chat_completions');
  const [publicApiBaseUrl, setPublicApiBaseUrl] = useState('');
  const [publicBasePath, setPublicBasePath] = useState('/');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [savingSection, setSavingSection] = useState<SettingsSectionKey | null>(null);
  const [persistingAccessTokenDotenv, setPersistingAccessTokenDotenv] = useState(false);
  const [clearingKey, setClearingKey] = useState(false);
  const [clearingAccessToken, setClearingAccessToken] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionTest, setConnectionTest] = useState<ConnectionTestResult | null>(null);
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1440));

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
    setStateStorePath(data?.stateStorePath || '');
    setEffectiveApiEndpoint(data?.effectiveApiEndpoint || '');
    setActiveProvider(data?.apiProvider || 'DeepSeek');
    setActiveModel(data?.model || 'deepseek-chat');
    setActiveProtocol(data?.apiProtocol || DEFAULT_FORM.apiProtocol);
    setPublicApiBaseUrl(data?.publicApiBaseUrl || '');
    setPublicBasePath(data?.publicBasePath || '/');
    setSettings({
      apiProvider: data?.apiProvider || DEFAULT_FORM.apiProvider,
      apiBaseUrl: data?.apiBaseUrl || DEFAULT_FORM.apiBaseUrl,
      apiProtocol: data?.apiProtocol || DEFAULT_FORM.apiProtocol,
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
    void loadSettings();
  }, []);

  useEffect(() => {
    const handleResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const publicUrls = useMemo(() => derivePublicUrls(settings.publicBaseUrl), [settings.publicBaseUrl]);
  const activeProtocolLabel = activeProtocol === 'responses' ? t('settings.protocolResponses') : t('settings.protocolChatCompletions');

  const savePatch = async (section: SettingsSectionKey, payload: Record<string, unknown>, options: { storeAccessToken?: string } = {}) => {
    setSavingSection(section);
    try {
      const res = await Client.updateSettings(payload);
      if (res.success && res.data) {
        if (options.storeAccessToken) {
          setStoredAccessToken(options.storeAccessToken);
        }
        syncFromResponse(res.data);
        alert(t('settings.saved'));
      } else {
        alert(t('settings.saveFailed', { message: res.error?.message || t('common.failed') }));
      }
    } catch (error) {
      console.error(error);
      alert(extractApiErrorMessage(error, t('settings.saveNetworkError')));
    } finally {
      setSavingSection((current) => (current === section ? null : current));
    }
  };

  const handleSaveEngine = async () => {
    const payload: Record<string, unknown> = {
      apiProvider: settings.apiProvider,
      apiBaseUrl: settings.apiBaseUrl,
      apiProtocol: settings.apiProtocol,
      model: settings.model
    };

    if (settings.apiKey.trim()) {
      payload.apiKey = settings.apiKey.trim();
    }

    await savePatch('engine', payload);
  };

  const handleSaveTranslation = async () => {
    await savePatch('translation', {
      targetLanguage: settings.targetLanguage,
      style: settings.style,
      concurrency: settings.concurrency
    });
  };

  const handleSaveNetwork = async () => {
    await savePatch('network', {
      publicBaseUrl: settings.publicBaseUrl.trim(),
      trustProxyHeaders: settings.trustProxyHeaders
    });
  };

  const handleSaveSecurity = async () => {
    if (!settings.accessToken.trim()) {
      return;
    }

    await savePatch(
      'security',
      { accessToken: settings.accessToken.trim() },
      { storeAccessToken: settings.accessToken.trim() }
    );
  };

  const handleClearKey = async () => {
    setClearingKey(true);
    try {
      const scope = 'all';
      const res = await Client.clearApiKey({ scope });
      if (res.success && res.data) {
        syncFromResponse(res.data);
        setConnectionTest(null);
        alert(t('settings.keyClearedAll'));
      } else {
        alert(t('settings.keyDeleteFailed', { message: res.error?.message || t('common.failed') }));
      }
    } catch (error) {
      console.error(error);
      alert(extractApiErrorMessage(error, t('settings.keyDeleteNetworkError')));
    } finally {
      setClearingKey(false);
    }
  };

  const handleClearAccessToken = async () => {
    setClearingAccessToken(true);
    try {
      const scope = accessTokenSource === 'dotenv' ? 'all' : accessTokenSource === 'database' ? 'database' : 'session';
      const res = await Client.clearAccessToken({ scope });
      if (res.success && res.data) {
        syncFromResponse(res.data);
        clearStoredAccessToken();
        setSettings((current) => ({ ...current, accessToken: '' }));
        alert(scope === 'all' ? t('settings.accessTokenClearedAll') : scope === 'database' ? t('settings.accessTokenClearedDatabase') : t('settings.accessTokenClearedSession'));
      } else {
        alert(t('settings.accessTokenDeleteFailed', { message: res.error?.message || t('common.failed') }));
      }
    } catch (error) {
      console.error(error);
      alert(extractApiErrorMessage(error, t('settings.accessTokenDeleteNetworkError')));
    } finally {
      setClearingAccessToken(false);
    }
  };

  const handlePersistAccessTokenDotenv = async () => {
    const trimmedAccessToken = settings.accessToken.trim();
    if (!trimmedAccessToken) {
      alert(t('settings.enterAccessTokenFirst'));
      return;
    }

    setPersistingAccessTokenDotenv(true);
    try {
      const settingsRes = await Client.updateSettings({ accessToken: trimmedAccessToken });
      if (!settingsRes.success || !settingsRes.data) {
        alert(t('settings.saveProviderFirst', { message: settingsRes.error?.message || t('common.failed') }));
        return;
      }

      syncFromResponse(settingsRes.data);
      setStoredAccessToken(trimmedAccessToken);

      const res = await Client.persistAccessTokenToDotenv({ accessToken: trimmedAccessToken });
      if (res.success && res.data) {
        syncFromResponse(res.data);
        setStoredAccessToken(trimmedAccessToken);
        alert(t('settings.accessTokenDotenvSaved'));
      } else {
        alert(t('settings.accessTokenDotenvFailed', { message: res.error?.message || t('common.failed') }));
      }
    } catch (error) {
      console.error(error);
      alert(extractApiErrorMessage(error, t('settings.accessTokenDotenvNetworkError')));
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
      : keyPersistence === 'sqlite-db'
        ? t('settings.key.database')
        : keyPersistence === 'environment'
          ? t('settings.key.environment', { suffix: buildSuffix(keyStorageKey) })
          : keySource === 'dotenv'
            ? t('settings.key.dotenv', { suffix: buildSuffix(keyStorageKey) })
            : keySource === 'session'
              ? t('settings.key.session')
              : t('settings.key.none');

  const persistenceText =
    keyPersistence === 'sqlite-db'
      ? t('settings.persistence.sqlite-db', { path: stateStorePath || t('settings.notConfigured') })
      : keyPersistence === 'environment'
        ? t('settings.persistence.environment', { suffix: buildSuffix(keyStorageKey) })
        : keyPersistence === 'dotenv-file'
          ? t('settings.persistence.dotenv-file', { path: dotenvPath || '.env' })
          : keyPersistence === 'memory-only'
            ? t('settings.persistence.memory-only')
            : t('settings.persistence.none');

  const keySourceText =
    keySource === 'database'
      ? t('settings.keySource.database', { path: stateStorePath || t('settings.notConfigured') })
      : keySource === 'dotenv'
        ? t('settings.keySource.dotenv', { suffix: buildSuffix(keyStorageKey) })
        : keySource === 'session'
          ? t('settings.keySource.session')
          : keyPersistence === 'environment'
            ? t('settings.keySource.environment', { suffix: buildSuffix(keyStorageKey) })
            : t('settings.keySource.none');

  const accessTokenStatusText =
    !hasAccessToken
      ? t('settings.accessToken.none')
      : accessTokenPersistence === 'sqlite-db'
        ? t('settings.accessToken.database')
        : accessTokenPersistence === 'environment'
          ? t('settings.accessToken.environment', { suffix: buildSuffix(accessTokenStorageKey) })
          : accessTokenSource === 'dotenv'
            ? t('settings.accessToken.dotenv', { suffix: buildSuffix(accessTokenStorageKey) })
            : accessTokenSource === 'session'
              ? t('settings.accessToken.session')
              : t('settings.accessToken.none');

  const accessTokenPersistenceText =
    accessTokenPersistence === 'sqlite-db'
      ? t('settings.persistence.sqlite-db', { path: stateStorePath || t('settings.notConfigured') })
      : accessTokenPersistence === 'environment'
        ? t('settings.persistence.environment', { suffix: buildSuffix(accessTokenStorageKey) })
        : accessTokenPersistence === 'dotenv-file'
          ? t('settings.persistence.dotenv-file', { path: dotenvPath || '.env' })
          : accessTokenPersistence === 'memory-only'
            ? t('settings.persistence.memory-only')
            : t('settings.persistence.none');

  const keyStorageLocation =
    keyPersistence === 'sqlite-db'
      ? stateStorePath || t('settings.notConfigured')
      : keyPersistence === 'dotenv-file'
        ? dotenvPath || '.env'
        : keyPersistence === 'environment'
          ? keyStorageKey || t('settings.notConfigured')
          : t('settings.notConfigured');

  const accessTokenStorageLocation =
    accessTokenPersistence === 'sqlite-db'
      ? stateStorePath || t('settings.notConfigured')
      : accessTokenPersistence === 'dotenv-file'
        ? dotenvPath || '.env'
        : accessTokenPersistence === 'environment'
          ? accessTokenStorageKey || t('settings.notConfigured')
          : t('settings.notConfigured');

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

  const sectionItems = useMemo(
    () => [
      {
        key: 'overview' as SettingsSectionKey,
        to: '/settings',
        end: true,
        label: t('settings.section.overview'),
        description: t('settings.section.overviewHint'),
        icon: <LayoutDashboard size={16} />
      },
      {
        key: 'engine' as SettingsSectionKey,
        to: '/settings/engine',
        label: t('settings.section.engine'),
        description: t('settings.section.engineHint'),
        icon: <Bot size={16} />
      },
      {
        key: 'translation' as SettingsSectionKey,
        to: '/settings/translation',
        label: t('settings.section.translation'),
        description: t('settings.section.translationHint'),
        icon: <Languages size={16} />
      },
      {
        key: 'security' as SettingsSectionKey,
        to: '/settings/security',
        label: t('settings.section.security'),
        description: t('settings.section.securityHint'),
        icon: <ShieldCheck size={16} />
      },
      {
        key: 'network' as SettingsSectionKey,
        to: '/settings/network',
        label: t('settings.section.network'),
        description: t('settings.section.networkHint'),
        icon: <Globe size={16} />
      },
      {
        key: 'diagnostics' as SettingsSectionKey,
        to: '/settings/diagnostics',
        label: t('settings.section.diagnostics'),
        description: t('settings.section.diagnosticsHint'),
        icon: <Activity size={16} />
      }
    ],
    [t]
  );

  const activeSection = useMemo<SettingsSectionKey | null>(() => {
    const trimmed = location.pathname.replace(/\/+$/, '');
    const segments = trimmed.split('/').filter(Boolean);
    if (segments.length === 1 && segments[0] === 'settings') {
      return 'overview';
    }
    if (segments[0] !== 'settings') {
      return null;
    }
    const matched = sectionItems.find((item) => item.key === segments[1]);
    return matched?.key || null;
  }, [location.pathname, sectionItems]);

  const activeSectionMeta = sectionItems.find((item) => item.key === activeSection) || sectionItems[0];
  const compactLayout = viewportWidth < 980;

  const overviewGridStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))',
    gap: '1rem'
  };

  const twoColumnGridStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))',
    gap: '1rem'
  };

  const snippetGridStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))',
    gap: '1rem'
  };

  const sectionHeader = (
    <div className="glass-panel" style={{ padding: '1.35rem 1.5rem', borderRadius: '18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', fontWeight: 700, fontSize: '1.1rem' }}>
        {activeSectionMeta.icon}
        <span>{activeSectionMeta.label}</span>
      </div>
      <div style={{ marginTop: '0.55rem', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
        {activeSectionMeta.description}
      </div>
    </div>
  );

  const summaryCards = (
    <div style={overviewGridStyle}>
      <SettingsSummaryCard title={t('settings.keyStatus')} icon={<KeyRound size={16} />}>
        <div>{keyStatusText}{maskedKey ? `, ${t('settings.currentMask')}: ${maskedKey}` : ''}</div>
        <div>{t('settings.persistence')}: {persistenceText}</div>
        <div>{t('settings.storagePath')}: {keyStorageLocation}</div>
      </SettingsSummaryCard>

      <SettingsSummaryCard title={t('settings.effectiveConfig')} icon={<Bot size={16} />}>
        <div>{t('settings.provider')}: {activeProvider}</div>
        <div>{t('settings.apiProtocol')}: {activeProtocolLabel}</div>
        <div>{t('settings.model')}: {activeModel}</div>
        <div>{t('settings.endpoint')}: {effectiveApiEndpoint || t('settings.notConfigured')}</div>
        <div>{t('settings.keySource')}: {keySourceText}</div>
      </SettingsSummaryCard>

      <SettingsSummaryCard title={t('settings.reverseProxy')} icon={<Globe size={16} />}>
        <div>{t('settings.publicEntry')}: {previewPublicEntry || t('settings.notConfigured')}</div>
        <div>{t('settings.publicApi')}: {previewPublicApi || t('settings.notConfigured')}</div>
        <div>{t('settings.publicBasePath')}: {previewPublicBasePath}</div>
      </SettingsSummaryCard>

      <SettingsSummaryCard title={t('settings.accessProtection')} icon={<ShieldCheck size={16} />}>
        <div>{t('settings.authRequired')}: {authRequired ? t('common.enabled') : t('common.disabled')}</div>
        <div>{accessTokenStatusText}{maskedAccessToken ? `, ${t('settings.currentMask')}: ${maskedAccessToken}` : ''}</div>
        <div>{t('settings.persistence')}: {accessTokenPersistenceText}</div>
        <div>{t('settings.storagePath')}: {accessTokenStorageLocation}</div>
      </SettingsSummaryCard>
    </div>
  );

  const connectionPanel = (
    <SettingsSectionCard title={t('settings.connectionTest')} description={t('settings.connectionHint')}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
        <div style={{ color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          {connectionTest ? t('settings.result') : t('settings.connectionIdle')}
        </div>
        <button type="button" className="glass-button" onClick={handleTestConnection} disabled={testingConnection} style={{ padding: '0.75rem 1.3rem' }}>
          {testingConnection ? t('settings.connectionTesting') : t('settings.connectionTestAction')}
        </button>
      </div>
      {connectionTest ? (
        <div style={{ color: connectionTest.result.ok ? 'var(--success-color)' : 'var(--danger-color)', lineHeight: 1.8, wordBreak: 'break-word' }}>
          <div>{t('settings.result')}: {connectionTest.result.ok ? t('settings.connected') : t('common.failed')}</div>
          <div>{t('settings.apiProtocol')}: {activeProtocolLabel}</div>
          <div>{t('settings.requestUrl')}: {connectionTest.result.url || connectionTest.effectiveApiEndpoint || t('settings.notConfigured')}</div>
          <div>{t('settings.httpStatus')}: {connectionTest.result.status || t('common.notAvailable')}</div>
          <div>{t('settings.latency')}: {connectionTest.result.latencyMs || 0} {t('common.ms')}</div>
          <div>{t('settings.testedAt')}: {new Date(connectionTest.testedAt).toLocaleString(dateLocale)}</div>
          {connectionTest.result.preview ? <div>{t('settings.responsePreview')}: {connectionTest.result.preview}</div> : null}
          {connectionTest.result.error ? <div>{t('settings.error')}: {connectionTest.result.error}</div> : null}
        </div>
      ) : null}
    </SettingsSectionCard>
  );

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
        <button className="glass-button" onClick={() => void loadSettings()} style={{ padding: '0.8rem 1.4rem' }}>
          <RefreshCw size={16} /> {t('common.retry')}
        </button>
      </div>
    );
  }

  if (!activeSection) {
    return <Navigate to="/settings" replace />;
  }

  const renderSectionContent = () => {
    switch (activeSection) {
      case 'overview':
        return (
          <>
            {summaryCards}
            <SettingsSectionCard title={t('settings.quickActions')} description={t('settings.overviewLead')}>
              <div style={overviewGridStyle}>
                {sectionItems.filter((item) => item.key !== 'overview').map((item) => (
                  <NavLink
                    key={item.key}
                    to={item.to}
                    className="glass-button"
                    style={{
                      justifyContent: 'flex-start',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      textDecoration: 'none',
                      padding: '1rem',
                      minHeight: '126px',
                      gap: '0.45rem'
                    }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', fontWeight: 700 }}>
                      {item.icon}
                      {item.label}
                    </span>
                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.88rem', lineHeight: 1.6 }}>
                      {item.description}
                    </span>
                  </NavLink>
                ))}
              </div>
            </SettingsSectionCard>
            {connectionPanel}
          </>
        );
      case 'engine':
        return (
          <>
            <div style={overviewGridStyle}>
              <SettingsSummaryCard title={t('settings.keyStatus')} icon={<KeyRound size={16} />}>
                <div>{keyStatusText}{maskedKey ? `, ${t('settings.currentMask')}: ${maskedKey}` : ''}</div>
                <div>{t('settings.persistence')}: {persistenceText}</div>
                <div>{t('settings.storagePath')}: {keyStorageLocation}</div>
              </SettingsSummaryCard>
              <SettingsSummaryCard title={t('settings.effectiveConfig')} icon={<Bot size={16} />}>
                <div>{t('settings.provider')}: {activeProvider}</div>
                <div>{t('settings.apiProtocol')}: {activeProtocolLabel}</div>
                <div>{t('settings.model')}: {activeModel}</div>
                <div>{t('settings.endpoint')}: {effectiveApiEndpoint || t('settings.notConfigured')}</div>
                <div>{t('settings.keySource')}: {keySourceText}</div>
              </SettingsSummaryCard>
            </div>
            <SettingsSectionCard title={t('settings.section.engine')} description={t('settings.section.engineHint')}>
              <div style={twoColumnGridStyle}>
                <div>
                  <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>{t('settings.apiProvider')}</label>
                  <select className="glass-input" value={settings.apiProvider} onChange={(event) => setSettings((current) => ({ ...current, apiProvider: event.target.value }))}>
                    <option value="DeepSeek">DeepSeek</option>
                    <option value="LiteLLM">LiteLLM</option>
                    <option value="OpenAI-Compatible">OpenAI-Compatible</option>
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>{t('settings.apiProtocol')}</label>
                  <select className="glass-input" value={settings.apiProtocol} onChange={(event) => setSettings((current) => ({ ...current, apiProtocol: event.target.value }))}>
                    <option value="chat_completions">{t('settings.protocolChatCompletions')}</option>
                    <option value="responses">{t('settings.protocolResponses')}</option>
                  </select>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '0.5rem' }}>{t('settings.apiProtocolHint')}</p>
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>{t('settings.model')}</label>
                  <input type="text" className="glass-input" value={settings.model} onChange={(event) => setSettings((current) => ({ ...current, model: event.target.value }))} placeholder={settings.apiProtocol === 'responses' ? 'gpt-5.4' : 'deepseek-chat'} />
                </div>
              </div>

              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>{t('settings.apiBaseUrl')}</label>
                <input
                  type="text"
                  className="glass-input"
                  value={settings.apiBaseUrl}
                  onChange={(event) => setSettings((current) => ({ ...current, apiBaseUrl: event.target.value }))}
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
                  onChange={(event) => setSettings((current) => ({ ...current, apiKey: event.target.value }))}
                  placeholder={hasKey ? t('settings.keepCurrentKey') : t('settings.apiKeyPlaceholder')}
                />
                <p style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: hasKey ? 'var(--text-secondary)' : 'var(--danger-color)', fontSize: '0.85rem', marginTop: '0.5rem' }}>
                  <AlertCircle size={14} />
                  {hasKey ? t('settings.apiKeyHintSaved') : t('settings.apiKeyHintMissing')}
                </p>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', marginTop: '0.35rem', lineHeight: 1.6 }}>
                  {t('settings.dotenvLocalOnlyHint')}
                </p>
              </div>

              <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                <button type="button" className="glass-button primary" disabled={savingSection === 'engine'} onClick={() => void handleSaveEngine()} style={{ padding: '0.8rem 1.6rem' }}>
                  <Save size={18} />
                  {savingSection === 'engine' ? t('settings.saving') : t('settings.saveEngine')}
                </button>
                <button type="button" className="glass-button" disabled={clearingKey || !hasKey} onClick={() => void handleClearKey()} style={{ padding: '0.8rem 1.6rem' }}>
                  <Trash2 size={18} />
                  {clearingKey ? t('settings.clearingKey') : t('settings.deleteKey')}
                </button>
              </div>
            </SettingsSectionCard>
          </>
        );
      case 'translation':
        return (
          <SettingsSectionCard title={t('settings.section.translation')} description={t('settings.section.translationHint')}>
            <div style={twoColumnGridStyle}>
              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>{t('settings.targetLanguage')}</label>
                <input type="text" className="glass-input" value={settings.targetLanguage} onChange={(event) => setSettings((current) => ({ ...current, targetLanguage: event.target.value }))} />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>{t('settings.concurrency')}</label>
                <input
                  type="number"
                  min={1}
                  className="glass-input"
                  value={settings.concurrency}
                  onChange={(event) => setSettings((current) => ({ ...current, concurrency: Number(event.target.value) || 1 }))}
                />
              </div>
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>{t('settings.style')}</label>
              <input type="text" className="glass-input" value={settings.style} onChange={(event) => setSettings((current) => ({ ...current, style: event.target.value }))} />
            </div>

            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
              <button type="button" className="glass-button primary" disabled={savingSection === 'translation'} onClick={() => void handleSaveTranslation()} style={{ padding: '0.8rem 1.6rem' }}>
                <Save size={18} />
                {savingSection === 'translation' ? t('settings.saving') : t('settings.saveTranslation')}
              </button>
            </div>
          </SettingsSectionCard>
        );
      case 'security':
        return (
          <>
            <div style={overviewGridStyle}>
              <SettingsSummaryCard title={t('settings.accessProtection')} icon={<ShieldCheck size={16} />}>
                <div>{t('settings.authRequired')}: {authRequired ? t('common.enabled') : t('common.disabled')}</div>
                <div>{accessTokenStatusText}{maskedAccessToken ? `, ${t('settings.currentMask')}: ${maskedAccessToken}` : ''}</div>
                <div>{t('settings.persistence')}: {accessTokenPersistenceText}</div>
                <div>{t('settings.storagePath')}: {accessTokenStorageLocation}</div>
              </SettingsSummaryCard>
            </div>
            <SettingsSectionCard title={t('settings.section.security')} description={t('settings.section.securityHint')}>
              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>{t('settings.accessToken')}</label>
                <input
                  type="password"
                  className="glass-input"
                  value={settings.accessToken}
                  onChange={(event) => setSettings((current) => ({ ...current, accessToken: event.target.value }))}
                  placeholder={hasAccessToken ? t('settings.keepCurrentAccessToken') : 'translator-access-token'}
                />
                <p style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '0.5rem', lineHeight: 1.7 }}>
                  <AlertCircle size={14} />
                  {t('settings.accessTokenHint')}
                </p>
              </div>

              <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="glass-button primary"
                  disabled={savingSection === 'security' || !settings.accessToken.trim()}
                  onClick={() => void handleSaveSecurity()}
                  style={{ padding: '0.8rem 1.6rem' }}
                >
                  <Save size={18} />
                  {savingSection === 'security' ? t('settings.saving') : t('settings.saveSecurity')}
                </button>
                <button
                  type="button"
                  className="glass-button"
                  disabled={persistingAccessTokenDotenv}
                  onClick={() => void handlePersistAccessTokenDotenv()}
                  style={{ padding: '0.8rem 1.6rem' }}
                >
                  <KeyRound size={18} />
                  {persistingAccessTokenDotenv ? t('settings.writingDotenv') : t('settings.writeAccessTokenDotenv')}
                </button>
                <button
                  type="button"
                  className="glass-button"
                  disabled={clearingAccessToken || !hasAccessToken}
                  onClick={() => void handleClearAccessToken()}
                  style={{ padding: '0.8rem 1.6rem' }}
                >
                  <Trash2 size={18} />
                  {clearingAccessToken ? t('settings.clearingAccessToken') : t('settings.deleteAccessToken')}
                </button>
              </div>
            </SettingsSectionCard>
          </>
        );
      case 'network':
        return (
          <>
            <SettingsSectionCard title={t('settings.section.network')} description={t('settings.section.networkHint')}>
              <div style={twoColumnGridStyle}>
                <div>
                  <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>{t('settings.publicBaseUrl')}</label>
                  <input
                    type="text"
                    className="glass-input"
                    value={settings.publicBaseUrl}
                    onChange={(event) => setSettings((current) => ({ ...current, publicBaseUrl: event.target.value }))}
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
                      onChange={(event) => setSettings((current) => ({ ...current, trustProxyHeaders: event.target.checked }))}
                    />
                    <span>{settings.trustProxyHeaders ? t('common.enabled') : t('common.disabled')}</span>
                  </label>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '0.5rem', lineHeight: 1.7 }}>{t('settings.trustProxyHeadersHint')}</p>
                </div>
              </div>

              <div style={{ color: 'var(--text-secondary)', lineHeight: 1.8 }}>
                <div>{t('settings.publicEntry')}: {publicUrls.publicEntryUrl || t('settings.notConfigured')}</div>
                <div>{t('settings.publicApi')}: {publicUrls.publicApiUrl || t('settings.notConfigured')}</div>
                <div>{t('settings.publicBasePath')}: {publicUrls.publicBasePath}</div>
              </div>

              <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                <button type="button" className="glass-button primary" disabled={savingSection === 'network'} onClick={() => void handleSaveNetwork()} style={{ padding: '0.8rem 1.6rem' }}>
                  <Save size={18} />
                  {savingSection === 'network' ? t('settings.saving') : t('settings.saveNetwork')}
                </button>
              </div>
            </SettingsSectionCard>

            <SettingsSectionCard title={t('settings.reverseProxy')} description={t('settings.proxySnippetHint')}>
              <div style={snippetGridStyle}>
                <div>
                  <div style={{ fontWeight: 700, marginBottom: '0.5rem' }}>{t('settings.nginxSnippet')}</div>
                  <pre style={{ margin: 0, padding: '1rem', borderRadius: '12px', background: 'var(--shadow-light)', boxShadow: 'var(--neu-shadow-inset)', overflowX: 'auto', whiteSpace: 'pre-wrap' }}>
                    {nginxSnippet}
                  </pre>
                </div>
                <div>
                  <div style={{ fontWeight: 700, marginBottom: '0.5rem' }}>{t('settings.caddySnippet')}</div>
                  <pre style={{ margin: 0, padding: '1rem', borderRadius: '12px', background: 'var(--shadow-light)', boxShadow: 'var(--neu-shadow-inset)', overflowX: 'auto', whiteSpace: 'pre-wrap' }}>
                    {caddySnippet}
                  </pre>
                </div>
              </div>
            </SettingsSectionCard>
          </>
        );
      case 'diagnostics':
        return (
          <>
            <div style={overviewGridStyle}>
              <SettingsSummaryCard title={t('settings.effectiveConfig')} icon={<Bot size={16} />}>
                <div>{t('settings.provider')}: {activeProvider}</div>
                <div>{t('settings.apiProtocol')}: {activeProtocolLabel}</div>
                <div>{t('settings.model')}: {activeModel}</div>
                <div>{t('settings.endpoint')}: {effectiveApiEndpoint || t('settings.notConfigured')}</div>
                <div>{t('settings.keySource')}: {keySourceText}</div>
              </SettingsSummaryCard>
              <SettingsSummaryCard title={t('settings.reverseProxy')} icon={<Globe size={16} />}>
                <div>{t('settings.publicEntry')}: {previewPublicEntry || t('settings.notConfigured')}</div>
                <div>{t('settings.publicApi')}: {previewPublicApi || t('settings.notConfigured')}</div>
                <div>{t('settings.publicBasePath')}: {previewPublicBasePath}</div>
              </SettingsSummaryCard>
            </div>
            {connectionPanel}
          </>
        );
    }
  };

  return (
    <div
      className="glass-panel"
      style={{
        padding: compactLayout ? '1.25rem' : '2rem',
        maxWidth: 'none',
        margin: 0,
        width: '100%',
        minWidth: 0,
        borderRadius: '22px',
        boxSizing: 'border-box'
      }}
    >
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.8rem' }}>{t('settings.title')}</h1>
        <p style={{ color: 'var(--text-secondary)', margin: '0.85rem 0 0', lineHeight: 1.8, maxWidth: '1180px' }}>{t('settings.description')}</p>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: compactLayout ? '1fr' : '300px minmax(0, 1fr)',
          gap: '1.4rem',
          alignItems: 'start'
        }}
      >
        <aside
          className="glass-panel"
          style={{
            padding: '1.1rem',
            borderRadius: '18px',
            position: compactLayout ? 'static' : 'sticky',
            top: compactLayout ? undefined : '1rem'
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: '0.85rem' }}>{t('settings.moduleNavigation')}</div>
          <div
            style={{
              display: 'flex',
              flexDirection: compactLayout ? 'row' : 'column',
              gap: '0.65rem',
              overflowX: compactLayout ? 'auto' : 'visible',
              paddingBottom: compactLayout ? '0.25rem' : 0
            }}
          >
            {sectionItems.map((item) => (
              <NavLink
                key={item.key}
                to={item.to}
                end={item.end}
                className={`glass-button ${activeSection === item.key ? 'primary' : ''}`}
                style={{
                  justifyContent: 'flex-start',
                  minWidth: compactLayout ? '220px' : '100%',
                  textDecoration: 'none',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: '0.4rem',
                  padding: '0.9rem 1rem'
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', fontWeight: 700 }}>
                  {item.icon}
                  {item.label}
                </span>
                <span style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', lineHeight: 1.55 }}>
                  {item.description}
                </span>
              </NavLink>
            ))}
          </div>
        </aside>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', minWidth: 0 }}>
          {sectionHeader}
          {renderSectionContent()}
        </div>
      </div>
    </div>
  );
}
