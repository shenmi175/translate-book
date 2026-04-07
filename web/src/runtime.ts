export type AppRuntimeConfig = {
  basePath: string;
  apiBasePath: string;
  publicBaseUrl: string;
};

declare global {
  interface Window {
    __TRANSLATE_BOOK_RUNTIME__?: Partial<AppRuntimeConfig>;
  }
}

function normalizeBasePath(value = '') {
  const trimmed = String(value || '').trim();
  if (!trimmed || trimmed === '/') {
    return '';
  }

  const normalized = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return normalized.replace(/\/+$/, '') || '';
}

function resolveRuntimeConfig(): AppRuntimeConfig {
  if (typeof window === 'undefined') {
    return {
      basePath: '',
      apiBasePath: '/api',
      publicBaseUrl: ''
    };
  }

  const payload = window.__TRANSLATE_BOOK_RUNTIME__ || {};
  const basePath = normalizeBasePath(payload.basePath || '');
  const apiBasePath = normalizeBasePath(payload.apiBasePath || `${basePath}/api`) || '/api';
  const publicBaseUrl = String(payload.publicBaseUrl || `${window.location.origin}${basePath}`).replace(/\/+$/, '');

  return {
    basePath,
    apiBasePath,
    publicBaseUrl
  };
}

const runtimeConfig = resolveRuntimeConfig();

export function getAppRuntimeConfig() {
  return runtimeConfig;
}
