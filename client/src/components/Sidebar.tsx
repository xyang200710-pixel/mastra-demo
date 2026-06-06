import { useEffect, useRef, useState } from 'react';
import { Thread, createThread, deleteThread, listThreads } from '../api';

type View = 'chat' | 'travel';

interface Props {
  view: View;
  onViewChange: (v: View) => void;
  activeThreadId: string | null;
  onSelect: (thread: Thread) => void;
  onNew: (thread: Thread) => void;
  onDelete: (threadId: string) => void;
  refreshSignal: number;
}

export function Sidebar({
  view,
  onViewChange,
  activeThreadId,
  onSelect,
  onNew,
  onDelete,
  refreshSignal,
}: Props) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [creating, setCreating] = useState(false);
  const [deleteHover, setDeleteHover] = useState<string | null>(null);
  const hasMounted = useRef(false);

  const load = async () => {
    const data = await listThreads();
    setThreads(data.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()));
  };

  useEffect(() => { load(); }, [refreshSignal]);

  useEffect(() => {
    if (!hasMounted.current) {
      hasMounted.current = true;
      load();
    }
  }, []);

  const handleNew = async () => {
    setCreating(true);
    try {
      const thread = await createThread('New Chat');
      setThreads(prev => [thread, ...prev]);
      onNew(thread);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (e: React.MouseEvent, threadId: string) => {
    e.stopPropagation();
    await deleteThread(threadId);
    setThreads(prev => prev.filter(t => t.id !== threadId));
    onDelete(threadId);
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 86400000) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (diff < 604800000) return d.toLocaleDateString([], { weekday: 'short' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">Mastra QA</span>
        {view === 'chat' && (
          <button className="new-chat-btn" onClick={handleNew} disabled={creating} title="New Chat">
            {creating ? '…' : '+'}
          </button>
        )}
      </div>

      {/* Mode tabs */}
      <div className="sidebar-tabs">
        <button
          className={`sidebar-tab ${view === 'chat' ? 'active' : ''}`}
          onClick={() => onViewChange('chat')}
        >
          💬 对话
        </button>
        <button
          className={`sidebar-tab ${view === 'travel' ? 'active' : ''}`}
          onClick={() => onViewChange('travel')}
        >
          ✈️ 旅行
        </button>
      </div>

      {view === 'chat' && (
        <nav className="thread-list">
          {threads.length === 0 && (
            <p className="empty-hint">No chats yet.<br />Click + to start.</p>
          )}
          {threads.map(thread => (
            <div
              key={thread.id}
              className={`thread-item ${activeThreadId === thread.id ? 'active' : ''}`}
              onClick={() => onSelect(thread)}
              onMouseEnter={() => setDeleteHover(thread.id)}
              onMouseLeave={() => setDeleteHover(null)}
            >
              <div className="thread-info">
                <span className="thread-title">{thread.title}</span>
                <span className="thread-date">{formatDate(thread.updatedAt)}</span>
              </div>
              {deleteHover === thread.id && (
                <button
                  className="delete-btn"
                  onClick={e => handleDelete(e, thread.id)}
                  title="Delete"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </nav>
      )}

      {view === 'travel' && (
        <div className="travel-sidebar-info">
          <p>旅行助理会通过 3 个步骤帮您规划行程：</p>
          <ol>
            <li>确认目的地</li>
            <li>选择景点</li>
            <li>规划行程</li>
          </ol>
        </div>
      )}
    </aside>
  );
}
