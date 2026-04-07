import { BrowserRouter as Router, Routes, Route, NavLink } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Sun, Moon, LayoutDashboard, List, Settings } from 'lucide-react';
import { Client } from './api';
import Dashboard from './pages/Dashboard';
import TaskList from './pages/TaskList';
import TaskDetail from './pages/TaskDetail';
import SettingsPage from './pages/Settings';
import { clearStoredAccessToken, getStoredAccessToken, subscribeAuthRequired, setStoredAccessToken } from './auth';
import { useI18n } from './i18n';
import { getAppRuntimeConfig } from './runtime';
import './App.css';

const runtime = getAppRuntimeConfig();

function App() {
  const { locale, setLocale, t } = useI18n();
  const [authPromptOpen, setAuthPromptOpen] = useState(false);
  const [browserAccessToken, setBrowserAccessToken] = useState(() => getStoredAccessToken());
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const stored = window.localStorage.getItem('translate-book.theme');
    return stored === 'dark' ? 'dark' : 'light';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    window.localStorage.setItem('translate-book.theme', theme);
  }, [theme]);

  useEffect(() => {
    document.title = t('app.title');
  }, [t]);

  useEffect(() => subscribeAuthRequired(() => {
    setBrowserAccessToken(getStoredAccessToken());
    setAuthPromptOpen(true);
  }), []);

  useEffect(() => {
    let cancelled = false;
    void Client.getServiceOverview()
      .then((res) => {
        if (cancelled || !res.success || !res.data?.authRequired || getStoredAccessToken()) {
          return;
        }
        setBrowserAccessToken('');
        setAuthPromptOpen(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'light' ? 'dark' : 'light'));
  };

  const handleAuthSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    setStoredAccessToken(browserAccessToken);
    setAuthPromptOpen(false);
    window.location.reload();
  };

  const handleAuthClear = () => {
    clearStoredAccessToken();
    setBrowserAccessToken('');
  };

  return (
    <Router basename={runtime.basePath || undefined}>
      <div className="app-container">
        <aside className="sidebar glass-panel">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
            <h2 style={{ fontSize: '1.25rem' }}>{t('app.title')}</h2>
            <button
              onClick={toggleTheme}
              className="glass-button"
              style={{ padding: '0.5rem', borderRadius: '50%' }}
              title={t('app.toggleTheme')}
            >
              {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
            </button>
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
        </aside>

        <main className="main-content">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/tasks" element={<TaskList />} />
            <Route path="/tasks/:taskId" element={<TaskDetail />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </main>
      </div>
      {authPromptOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.42)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1.5rem', zIndex: 1000000 }}>
          <form className="glass-panel" onSubmit={handleAuthSubmit} style={{ width: '100%', maxWidth: '440px', padding: '1.75rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div>
              <h2 style={{ margin: 0, fontSize: '1.35rem' }}>{t('auth.title')}</h2>
              <p style={{ margin: '0.75rem 0 0', color: 'var(--text-secondary)', lineHeight: 1.7 }}>{t('auth.description')}</p>
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>{t('auth.input')}</label>
              <input
                type="password"
                className="glass-input"
                value={browserAccessToken}
                onChange={(event) => setBrowserAccessToken(event.target.value)}
                placeholder="translator-access-token"
                autoFocus
              />
            </div>
            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
              <button type="submit" className="glass-button primary" style={{ padding: '0.75rem 1.4rem' }}>
                {t('auth.save')}
              </button>
              <button type="button" className="glass-button" onClick={handleAuthClear} style={{ padding: '0.75rem 1.4rem' }}>
                {t('auth.clear')}
              </button>
              <button type="button" className="glass-button" onClick={() => setAuthPromptOpen(false)} style={{ padding: '0.75rem 1.4rem' }}>
                {t('auth.cancel')}
              </button>
            </div>
          </form>
        </div>
      )}
    </Router>
  );
}

export default App;
