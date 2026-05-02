import { BrowserRouter as Router, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Sun, Moon, LayoutDashboard, List, LogOut, PanelLeftClose, PanelLeftOpen, Settings, ShieldCheck } from 'lucide-react';
import { Client, type AdminAuthState } from './api';
import Dashboard from './pages/Dashboard';
import TaskList from './pages/TaskList';
import TaskDetail from './pages/TaskDetail';
import SettingsPage from './pages/Settings';
import { clearStoredAccessToken, getStoredAccessToken, subscribeAuthRequired, setStoredAccessToken } from './auth';
import { useI18n } from './i18n';
import { getAppRuntimeConfig } from './runtime';
import './App.css';

const runtime = getAppRuntimeConfig();
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'translate-book.sidebar-collapsed';

function extractAuthError(error: any, fallback: string) {
  return error?.response?.data?.error?.message || error?.message || fallback;
}

function AuthGate({
  auth,
  onAuthenticated
}: {
  auth: AdminAuthState | null;
  onAuthenticated: (auth: AdminAuthState) => void;
}) {
  const { t } = useI18n();
  const setupMode = !auth?.configured;
  const locked = Boolean(auth?.locked);
  const [username, setUsername] = useState(auth?.username || 'admin');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setUsername(auth?.username || 'admin');
  }, [auth?.username]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (locked) {
      return;
    }
    if (setupMode && password !== confirmPassword) {
      setError(t('auth.passwordMismatch'));
      return;
    }

    setBusy(true);
    setError('');
    try {
      const res = setupMode
        ? await Client.registerAdmin({ username, password })
        : await Client.loginAdmin({ username, password });
      if (res.success && res.data?.token) {
        setStoredAccessToken(res.data.token);
        onAuthenticated(res.data.auth);
        return;
      }
      setError(res.error?.message || t('auth.failed'));
    } catch (loginError: any) {
      setError(extractAuthError(loginError, t('auth.failed')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '1.5rem' }}>
      <form className="glass-panel" onSubmit={handleSubmit} style={{ width: '100%', maxWidth: '460px', padding: '2rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem' }}>
          <div className="glass-button primary" style={{ padding: '0.75rem', borderRadius: '16px' }}>
            <ShieldCheck size={22} />
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: '1.45rem' }}>{setupMode ? t('auth.registerTitle') : t('auth.loginTitle')}</h1>
            <p style={{ margin: '0.45rem 0 0', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
              {locked ? t('auth.lockedDescription') : setupMode ? t('auth.registerDescription') : t('auth.loginDescription')}
            </p>
          </div>
        </div>

        {locked ? (
          <div style={{ color: 'var(--danger-color)', lineHeight: 1.8 }}>
            <div>{t('auth.lockedTitle')}</div>
            <pre style={{ whiteSpace: 'pre-wrap', margin: '0.75rem 0 0', padding: '0.9rem', borderRadius: '12px', background: 'var(--shadow-light)', color: 'var(--text-primary)' }}>
              docker exec -it translate-book node scripts/reset-admin-password.js --username {username || 'admin'} --generate
            </pre>
          </div>
        ) : (
          <>
            <div>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 700 }}>{t('auth.username')}</label>
              <input className="glass-input" value={username} onChange={(event) => setUsername(event.target.value)} autoFocus />
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 700 }}>{t('auth.password')}</label>
              <input className="glass-input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
            </div>
            {setupMode ? (
              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 700 }}>{t('auth.confirmPassword')}</label>
                <input className="glass-input" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
              </div>
            ) : null}
          </>
        )}

        {error ? <div style={{ color: 'var(--danger-color)', lineHeight: 1.7 }}>{error}</div> : null}

        {!locked ? (
          <button type="submit" className="glass-button primary" disabled={busy || !username.trim() || !password} style={{ padding: '0.85rem 1.4rem', justifyContent: 'center' }}>
            {busy ? t('auth.submitting') : setupMode ? t('auth.registerAction') : t('auth.loginAction')}
          </button>
        ) : null}
      </form>
    </div>
  );
}

function App() {
  const { locale, setLocale, t } = useI18n();
  const [authPromptOpen, setAuthPromptOpen] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [adminAuth, setAdminAuth] = useState<AdminAuthState | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const stored = window.localStorage.getItem('translate-book.theme');
    return stored === 'dark' ? 'dark' : 'light';
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    const stored = window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY);
    return stored === '1';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    window.localStorage.setItem('translate-book.theme', theme);
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);

  useEffect(() => {
    document.title = t('app.title');
  }, [t]);

  useEffect(() => subscribeAuthRequired(() => {
    clearStoredAccessToken();
    setAuthPromptOpen(true);
  }), []);

  useEffect(() => {
    let cancelled = false;
    void Client.getServiceOverview()
      .then((res) => {
        if (cancelled || !res.success) {
          return;
        }
        setAuthRequired(Boolean(res.data?.authRequired));
        setAdminAuth(res.data?.adminAuth || null);
        if (res.data?.authRequired && !getStoredAccessToken()) {
          setAuthPromptOpen(true);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'light' ? 'dark' : 'light'));
  };

  const handleLogout = async () => {
    try {
      await Client.logoutAdmin();
    } catch {
      // The local token must still be cleared even if the server session already expired.
    }
    clearStoredAccessToken();
    setAuthPromptOpen(true);
  };

  const shouldShowAuthGate = authRequired && (authPromptOpen || !getStoredAccessToken());

  if (shouldShowAuthGate) {
    return (
      <AuthGate
        auth={adminAuth}
        onAuthenticated={(nextAuth) => {
          setAdminAuth(nextAuth);
          setAuthRequired(true);
          setAuthPromptOpen(false);
        }}
      />
    );
  }

  return (
    <Router basename={runtime.basePath || undefined}>
      <div className="app-container">
        {!sidebarCollapsed && (
          <aside className="sidebar glass-panel">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
              <h2 style={{ fontSize: '1.25rem' }}>{t('app.title')}</h2>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <button
                  onClick={() => setSidebarCollapsed(true)}
                  className="glass-button"
                  style={{ padding: '0.5rem', borderRadius: '50%' }}
                  title={t('app.hideSidebar')}
                >
                  <PanelLeftClose size={18} />
                </button>
                <button
                  onClick={toggleTheme}
                  className="glass-button"
                  style={{ padding: '0.5rem', borderRadius: '50%' }}
                  title={t('app.toggleTheme')}
                >
                  {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
                </button>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: 600 }}>{t('app.language')}</span>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                {(['zh-CN', 'en'] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={`glass-button ${locale === option ? 'primary' : ''}`}
                    onClick={() => setLocale(option)}
                    style={{ padding: '0.55rem 0.75rem' }}
                  >
                    {t(`app.language.${option}`)}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ height: '2px', background: 'var(--shadow-light)', margin: '0.5rem 0' }} />

            <nav style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
              <NavLink
                to="/"
                className={({ isActive }) => `glass-button ${isActive ? 'primary' : ''}`}
                style={{ justifyContent: 'flex-start' }}
              >
                <LayoutDashboard size={18} />
                <span>{t('app.newTask')}</span>
              </NavLink>
              <NavLink
                to="/tasks"
                className={({ isActive }) => `glass-button ${isActive ? 'primary' : ''}`}
                style={{ justifyContent: 'flex-start' }}
              >
                <List size={18} />
                <span>{t('app.taskList')}</span>
              </NavLink>
              <NavLink
                to="/settings"
                className={({ isActive }) => `glass-button ${isActive ? 'primary' : ''}`}
                style={{ justifyContent: 'flex-start' }}
              >
                <Settings size={18} />
                <span>{t('app.settings')}</span>
              </NavLink>
            </nav>

            <div
              id="sidebar-tool-slot"
              style={{
                marginTop: 'auto',
                minHeight: '0',
                display: 'flex',
                flexDirection: 'column',
                gap: '1rem'
              }}
            />
            {authRequired ? (
              <button type="button" className="glass-button" onClick={() => void handleLogout()} style={{ justifyContent: 'flex-start' }}>
                <LogOut size={18} />
                <span>{t('auth.logout')}</span>
              </button>
            ) : null}
          </aside>
        )}

        <main className="main-content" style={{ position: 'relative' }}>
          {sidebarCollapsed && (
            <button
              type="button"
              className="glass-button"
              onClick={() => setSidebarCollapsed(false)}
              title={t('app.showSidebar')}
              style={{
                position: 'sticky',
                top: 0,
                alignSelf: 'flex-start',
                zIndex: 40,
                padding: '0.6rem 0.9rem'
              }}
            >
              <PanelLeftOpen size={18} />
              <span>{t('app.showSidebar')}</span>
            </button>
          )}
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/tasks" element={<TaskList />} />
            <Route path="/tasks/:taskId/focus" element={<Navigate to="/tasks" replace />} />
            <Route path="/tasks/:taskId" element={<TaskDetail />} />
            <Route path="/settings/*" element={<SettingsPage />} />
          </Routes>
        </main>
      </div>
    </Router>
  );
}

export default App;
