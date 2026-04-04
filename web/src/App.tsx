import { BrowserRouter as Router, Routes, Route, NavLink } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { Sun, Moon, LayoutDashboard, List, Settings } from 'lucide-react';
import Dashboard from './pages/Dashboard';
import TaskList from './pages/TaskList';
import TaskDetail from './pages/TaskDetail';
import SettingsPage from './pages/Settings';
import './App.css';

function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prev => prev === 'light' ? 'dark' : 'light');
  };

  return (
    <Router>
      <div className="app-container">
        <aside className="sidebar glass-panel">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h2 style={{ fontSize: '1.25rem' }}>Auto Translator</h2>
            <button onClick={toggleTheme} className="glass-button" style={{ padding: '0.5rem', borderRadius: '50%' }} title="Toggle Theme">
              {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
            </button>
          </div>
          
          <div style={{ height: '2px', background: 'var(--shadow-light)', margin: '0.5rem 0' }} />

          <nav style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
            <NavLink 
              to="/" 
              className={({ isActive }) => `glass-button ${isActive ? 'primary' : ''}`} 
              style={{ justifyContent: 'flex-start' }}
            >
               <LayoutDashboard size={18} /> 
               <span>New Task</span>
            </NavLink>
            <NavLink 
              to="/tasks" 
              className={({ isActive }) => `glass-button ${isActive ? 'primary' : ''}`} 
              style={{ justifyContent: 'flex-start' }}
            >
               <List size={18} /> 
               <span>Task List</span>
            </NavLink>
            <NavLink 
              to="/settings" 
              className={({ isActive }) => `glass-button ${isActive ? 'primary' : ''}`} 
              style={{ justifyContent: 'flex-start' }}
            >
               <Settings size={18} /> 
               <span>Settings</span>
            </NavLink>
          </nav>
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
    </Router>
  );
}

export default App;
