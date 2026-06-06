import { useEffect, useRef, useState } from 'react';
import { Message, getMessages, streamChat, updateThreadTitle } from '../api';

interface LocalMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
}

interface Props {
  threadId: string | null;
  threadTitle: string;
  onTitleChange: (title: string) => void;
}

function MarkdownText({ text }: { text: string }) {
  const html = text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br />');
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

export function ChatPanel({ threadId, threadTitle, onTitleChange }: Props) {
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Track message count at submit time to decide auto-titling
  const msgCountAtSubmit = useRef(0);

  useEffect(() => {
    if (!threadId) {
      setMessages([]);
      return;
    }
    setMessages([]);
    getMessages(threadId).then(msgs => {
      setMessages(
        msgs.map(m => ({
          id: m.id,
          role: m.role,
          content: typeof m.content === 'string' ? m.content : m.content?.content ?? '',
        })),
      );
    });
  }, [threadId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!threadId || !input.trim() || loading) return;

    const userText = input.trim();
    setInput('');
    setLoading(true);

    const userMsg: LocalMessage = { id: crypto.randomUUID(), role: 'user', content: userText };
    const assistantId = crypto.randomUUID();
    const assistantMsg: LocalMessage = { id: assistantId, role: 'assistant', content: '', streaming: true };

    msgCountAtSubmit.current = messages.length;
    setMessages(prev => [...prev, userMsg, assistantMsg]);

    let fullText = '';
    let textDone = false;

    try {
      for await (const event of streamChat(threadId, userText)) {
        if (event.kind === 'text') {
          fullText += event.text;
          setMessages(prev =>
            prev.map(m => m.id === assistantId ? { ...m, content: fullText } : m),
          );
          bottomRef.current?.scrollIntoView({ behavior: 'smooth' });

        } else if (event.kind === 'text-done') {
          // Text output is complete — release the input immediately.
          // Background work (working memory update) continues in the stream.
          textDone = true;
          setMessages(prev =>
            prev.map(m => m.id === assistantId ? { ...m, streaming: false } : m),
          );
          setLoading(false);
          textareaRef.current?.focus();

          // Auto-title the thread on the first exchange
          if (msgCountAtSubmit.current === 0 && threadTitle === 'New Chat') {
            const title = userText.slice(0, 40) + (userText.length > 40 ? '…' : '');
            updateThreadTitle(threadId, title).then(() => onTitleChange(title));
          }

        } else if (event.kind === 'error') {
          const errorMsg = `[Error: ${event.message}]`;
          setMessages(prev =>
            prev.map(m => m.id === assistantId
              ? { ...m, content: fullText || errorMsg, streaming: false }
              : m),
          );
          if (!textDone) setLoading(false);
        }
        // 'done' — stream fully closed; nothing extra to do
      }
    } finally {
      // Ensure loading/streaming flags are always cleared
      if (!textDone) {
        setMessages(prev =>
          prev.map(m => m.id === assistantId ? { ...m, streaming: false } : m),
        );
        setLoading(false);
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  if (!threadId) {
    return (
      <main className="chat-panel empty-state">
        <div className="empty-state-content">
          <h2>Mastra QA</h2>
          <p>Select a chat or click <strong>+</strong> to start a new conversation.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="chat-panel">
      <header className="chat-header">
        <span className="chat-title">{threadTitle}</span>
      </header>

      <div className="message-list">
        {messages.length === 0 && (
          <p className="empty-hint center">No messages yet. Ask something below.</p>
        )}
        {messages.map(msg => (
          <div key={msg.id} className={`message ${msg.role}`}>
            <div className="message-bubble">
              <MarkdownText text={msg.content} />
              {msg.streaming && <span className="cursor-blink" />}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <form className="input-area" onSubmit={handleSubmit}>
        <div className="input-row">
        <textarea
          ref={textareaRef}
          className="chat-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask a question… (Enter to send, Shift+Enter for newline)"
          rows={1}
          disabled={loading}
        />
        <button className="send-btn" type="submit" disabled={loading || !input.trim()}>
          {loading ? '…' : '→'}
        </button>
        </div>
      </form>
    </main>
  );
}
