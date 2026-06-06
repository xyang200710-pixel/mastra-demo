import { useState } from 'react';
import { Thread } from './api';
import { ChatPanel } from './components/ChatPanel';
import { Sidebar } from './components/Sidebar';
import { TravelPanel } from './components/TravelPanel';

type View = 'chat' | 'travel';

export default function App() {
  const [view, setView] = useState<View>('chat');
  const [activeThread, setActiveThread] = useState<Thread | null>(null);
  const [refreshSignal, setRefreshSignal] = useState(0);

  const handleTitleChange = (title: string) => {
    if (activeThread) {
      setActiveThread(prev => prev ? { ...prev, title } : null);
      setRefreshSignal(s => s + 1);
    }
  };

  return (
    <div className="app-layout">
      <Sidebar
        view={view}
        onViewChange={v => { setView(v); if (v === 'chat') setActiveThread(null); }}
        activeThreadId={activeThread?.id ?? null}
        onSelect={t => { setActiveThread(t); setView('chat'); }}
        onNew={t => { setActiveThread(t); setView('chat'); }}
        onDelete={id => { if (activeThread?.id === id) setActiveThread(null); }}
        refreshSignal={refreshSignal}
      />
      {view === 'travel' ? (
        <TravelPanel />
      ) : (
        <ChatPanel
          threadId={activeThread?.id ?? null}
          threadTitle={activeThread?.title ?? ''}
          onTitleChange={handleTitleChange}
        />
      )}
    </div>
  );
}
