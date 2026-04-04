import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Client } from '../api';
import { AlertCircle, BarChart2, Clock, FileText, RefreshCw, Trash2 } from 'lucide-react';

export default function TaskList() {
  const [tasks, setTasks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');

  const fetchTasks = async () => {
    setLoading(true);
    setErrorMessage('');

    try {
      const res = await Client.getTasks();
      if (res.success && Array.isArray(res.data)) {
        setTasks(res.data.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
        return;
      }

      setTasks([]);
      setErrorMessage(res.error?.message || 'Failed to load the task list.');
    } catch (err: any) {
      console.error(err);
      const message = err?.response?.data?.error?.message || err?.message || 'Failed to load the task list.';
      setTasks([]);
      setErrorMessage(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTasks();
  }, []);

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    if (confirm('Are you sure you want to permanently delete this task?')) {
      try {
        const res = await Client.deleteTask(id);
        if (res.success) {
          fetchTasks();
        } else {
          alert(res.error?.message || 'Failed to delete task');
        }
      } catch (err) {
        console.error(err);
        alert('Failed to delete task.');
      }
    }
  };

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '2rem' }}>Loading task list...</div>;
  }

  if (errorMessage) {
    return (
      <div className="glass-panel" style={{ padding: '2rem', textAlign: 'center', maxWidth: '760px', margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '1rem', color: 'var(--danger-color)' }}>
          <AlertCircle size={24} />
        </div>
        <h1 style={{ marginBottom: '0.75rem', fontSize: '1.4rem' }}>Task list unavailable</h1>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.8, marginBottom: '1.25rem', whiteSpace: 'pre-wrap' }}>{errorMessage}</p>
        <button className="glass-button" onClick={fetchTasks} style={{ padding: '0.8rem 1.4rem' }}>
          <RefreshCw size={16} /> Retry
        </button>
      </div>
    );
  }

  return (
    <div>
      <h1 style={{ marginBottom: '2rem', fontSize: '1.8rem', fontWeight: 600 }}>Your Translation Tasks</h1>

      {tasks.length === 0 ? (
        <div className="glass-panel" style={{ padding: '4rem', textAlign: 'center' }}>
          <p style={{ color: 'var(--text-secondary)', fontSize: '1.2rem' }}>No tasks found. Create one from the Dashboard.</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '2rem' }}>
          {tasks.map((task) => (
            <Link to={`/tasks/${task.id}`} key={task.id} style={{ textDecoration: 'none', color: 'inherit' }}>
              <div
                className="glass-panel"
                style={{
                  padding: '1.5rem',
                  transition: 'all 0.2s ease',
                  cursor: 'pointer',
                  position: 'relative'
                }}
                onMouseOver={(e) => {
                  e.currentTarget.style.boxShadow = 'var(--neu-shadow-hover)';
                  e.currentTarget.style.transform = 'translateY(-2px)';
                }}
                onMouseOut={(e) => {
                  e.currentTarget.style.boxShadow = 'var(--neu-shadow)';
                  e.currentTarget.style.transform = 'none';
                }}
              >
                <button
                  onClick={(e) => handleDelete(e, task.id)}
                  style={{ position: 'absolute', top: '1.2rem', right: '1.2rem', background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', zIndex: 10 }}
                  title="Delete Task"
                >
                  <Trash2 size={18} />
                </button>

                <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', marginBottom: '1.5rem', paddingRight: '2rem' }}>
                  <div style={{ padding: '0.6rem', background: 'var(--shadow-light)', borderRadius: '12px', boxShadow: 'var(--neu-shadow-sm)' }}>
                    <FileText size={22} className="text-primary" />
                  </div>
                  <h3 style={{ fontSize: '1.2rem', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>
                    {task.filename}
                  </h3>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem', fontSize: '0.95rem', color: 'var(--text-secondary)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                    <Clock size={16} />
                    <span>{new Date(task.createdAt).toLocaleString()}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                    <BarChart2 size={16} />
                    Stage:
                    <span
                      style={{
                        textTransform: 'capitalize',
                        fontWeight: 600,
                        color: task.stage === 'review_ready' ? 'var(--success-color)' : 'var(--warning-color)'
                      }}
                    >
                      {task.stage.replace('_', ' ')}
                    </span>
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
