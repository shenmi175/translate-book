const ACCESS_TOKEN_STORAGE_KEY = 'translate-book.access-token';
const AUTH_REQUIRED_EVENT = 'translate-book.auth-required';

export function getStoredAccessToken() {
  return window.localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY) || '';
}

export function setStoredAccessToken(token: string) {
  const normalized = String(token || '').trim();
  if (!normalized) {
    window.localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, normalized);
}

export function clearStoredAccessToken() {
  window.localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
}

export function emitAuthRequired() {
  window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT));
}

export function subscribeAuthRequired(listener: () => void) {
  const handler = () => listener();
  window.addEventListener(AUTH_REQUIRED_EVENT, handler);
  return () => window.removeEventListener(AUTH_REQUIRED_EVENT, handler);
}
