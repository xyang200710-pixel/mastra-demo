import { useEffect, useRef, useState } from 'react';
import {
  AttractionCard,
  WorkflowSuspendPayload,
  startTravelWorkflow,
  resumeTravelWorkflow,
} from '../api';
import { AttractionCards } from './AttractionCards';
import { ThinkingBubble } from './ThinkingBubble';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isItinerary?: boolean;
  thinking?: string;
}

const STEP_LABELS = ['确认目的地', '选择景点', '规划行程'];

function MarkdownText({ text }: { text: string }) {
  const html = text
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`)
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br />');
  return (
    <div
      className="markdown-content"
      dangerouslySetInnerHTML={{ __html: `<p>${html}</p>` }}
    />
  );
}

export function TravelPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [started, setStarted] = useState(false);

  const runId = useRef<string>(crypto.randomUUID());
  const [currentStep, setCurrentStep] = useState(0);
  const [suspendedStepId, setSuspendedStepId] = useState<string>('');
  const [cards, setCards] = useState<AttractionCard[]>([]);
  const [selectedCards, setSelectedCards] = useState<Set<string>>(new Set());
  const [itineraryGenerated, setItineraryGenerated] = useState(false);

  // Streaming state
  const [streamingText, setStreamingText] = useState('');
  const [streamingThinking, setStreamingThinking] = useState('');
  const [thinkingDone, setThinkingDone] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, cards, streamingText]);

  const appendMessage = (role: 'user' | 'assistant', content: string, isItinerary = false, thinking?: string) => {
    setMessages(prev => [...prev, { id: crypto.randomUUID(), role, content, isItinerary, thinking }]);
  };

  const clearStreamingState = () => {
    setStreamingText('');
    setStreamingThinking('');
    setThinkingDone(false);
  };

  const handleSuspend = (payload: WorkflowSuspendPayload, stepId: string) => {
    setSuspendedStepId(stepId);

    if (payload.stepName === 'destination') {
      setCurrentStep(1);
      appendMessage('assistant', payload.reply, false, payload.thinking);
    } else if (payload.stepName === 'attractions') {
      setCurrentStep(2);
      appendMessage('assistant', payload.reply, false, payload.thinking);
      if (payload.cards?.length) {
        setCards(payload.cards);
        setSelectedCards(new Set());
      }
    } else if (payload.stepName === 'itinerary') {
      if (payload.itinerary) {
        appendMessage('assistant', payload.itinerary, true, payload.thinking);
        appendMessage('assistant', '✅ 行程规划已生成！您可以继续提问或要求调整。');
        setItineraryGenerated(true);
        setCurrentStep(4);
      } else {
        setCurrentStep(3);
        appendMessage('assistant', payload.reply, false, payload.thinking);
      }
    }
  };

  const runStream = async (
    generator: AsyncGenerator<import('../api').WorkflowStreamEvent>,
  ) => {
    setLoading(true);
    clearStreamingState();
    try {
      for await (const event of generator) {
        if (event.kind === 'suspended') {
          clearStreamingState();
          handleSuspend(event.payload, event.stepId);
        } else if (event.kind === 'text-delta') {
          setStreamingText(prev => prev + event.text);
          // Once text starts, thinking phase is done
          setThinkingDone(true);
        } else if (event.kind === 'reasoning-delta') {
          setStreamingThinking(prev => prev + event.text);
        } else if (event.kind === 'error') {
          clearStreamingState();
          appendMessage('assistant', `⚠️ 出错了：${event.message}`);
        }
      }
    } finally {
      clearStreamingState();
      setLoading(false);
      textareaRef.current?.focus();
    }
  };

  const handleStart = async () => {
    const userText = input.trim();
    if (!userText || loading) return;
    setInput('');
    setStarted(true);
    appendMessage('user', userText);
    await runStream(startTravelWorkflow(runId.current, userText));
  };

  const handleResume = async () => {
    const userText = input.trim();
    if (loading || !suspendedStepId) return;

    let resumeData: Record<string, unknown>;

    if (currentStep === 2) {
      resumeData = {
        selectedCards: Array.from(selectedCards),
        userMessage: userText || '',
      };
      if (userText) appendMessage('user', userText);
      else if (selectedCards.size > 0)
        appendMessage('user', `选择了：${Array.from(selectedCards).join('、')}`);
      else appendMessage('user', '（无特别偏好）');
      setCards([]);
      setSelectedCards(new Set());
    } else {
      if (!userText) return;
      resumeData = { userMessage: userText };
      appendMessage('user', userText);
    }

    setInput('');
    await runStream(resumeTravelWorkflow(runId.current, suspendedStepId, resumeData));
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (loading) return;
    if (!started) {
      await handleStart();
    } else {
      await handleResume();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleNewTrip = () => {
    runId.current = crypto.randomUUID();
    setMessages([]);
    setStarted(false);
    setCurrentStep(0);
    setSuspendedStepId('');
    setCards([]);
    setSelectedCards(new Set());
    setItineraryGenerated(false);
    clearStreamingState();
    setInput('');
    textareaRef.current?.focus();
  };

  const isAttractionStep = currentStep === 2 && cards.length > 0;
  const isChatMode = currentStep === 4;
  // Text-delta events don't propagate through workflow stream (Mastra limitation).
  // These states are kept for future compatibility; currently always false during workflow calls.
  const isStreaming = loading && streamingText.length > 0;
  const isThinking = loading && streamingThinking.length > 0 && !thinkingDone;
  const canSend = !loading && (
    !started ||
    input.trim().length > 0 ||
    (isAttractionStep && selectedCards.size > 0)
  );

  return (
    <main className="chat-panel travel-panel">
      <header className="chat-header travel-header">
        <span className="chat-title">✈️ 旅行助理</span>
        {started && (
          <div className="step-indicator">
            {STEP_LABELS.map((label, i) => (
              <span
                key={i}
                className={`step-dot ${currentStep === i + 1 ? 'active' : ''} ${
                  i + 1 < currentStep || itineraryGenerated ? 'done' : ''
                }`}
              >
                {i + 1}. {label}
              </span>
            ))}
          </div>
        )}
        {started && (
          <button className="new-trip-btn" onClick={handleNewTrip} title="开始新行程">
            重新开始
          </button>
        )}
      </header>

      <div className="message-list">
        {!started && (
          <div className="travel-welcome">
            <div className="travel-welcome-icon">✈️</div>
            <h2>旅行助理</h2>
            <p>告诉我你想去哪里，我将帮你规划完整的旅行行程</p>
            <p className="travel-welcome-hint">例如："我想去日本玩一周" 或 "推荐一个适合家庭的目的地"</p>
          </div>
        )}

        {messages.map(msg => (
          <div key={msg.id} className={`message ${msg.role}`}>
            {msg.role === 'assistant' && msg.thinking && (
              <ThinkingBubble text={msg.thinking} />
            )}
            {msg.isItinerary ? (
              <div className="itinerary-result">
                <div className="itinerary-header">📋 您的旅行行程</div>
                <MarkdownText text={msg.content} />
              </div>
            ) : (
              <div className="message-bubble">
                {msg.role === 'assistant' ? (
                  <MarkdownText text={msg.content} />
                ) : (
                  msg.content
                )}
              </div>
            )}
          </div>
        ))}

        {isAttractionStep && !loading && (
          <AttractionCards
            cards={cards}
            selected={selectedCards}
            onToggle={name =>
              setSelectedCards(prev => {
                const next = new Set(prev);
                next.has(name) ? next.delete(name) : next.add(name);
                return next;
              })
            }
          />
        )}

        {/* Live streaming output */}
        {loading && (
          <div className="message assistant">
            {/* ThinkingBubble: auto-expanded + live text while reasoning, collapses when text starts */}
            <ThinkingBubble
              text={streamingThinking || undefined}
              isStreaming={isThinking}
            />

            {/* Text streaming bubble — appears once text-delta events arrive */}
            {isStreaming ? (
              <div className="message-bubble streaming-bubble">
                <MarkdownText text={streamingText} />
                <span className="streaming-cursor" />
              </div>
            ) : !isStreaming && !isThinking ? (
              /* Loading dots while waiting for first chunk */
              <div className="message-bubble thinking">
                <span className="dot-pulse" />
                <span className="dot-pulse" style={{ animationDelay: '0.15s' }} />
                <span className="dot-pulse" style={{ animationDelay: '0.3s' }} />
              </div>
            ) : null}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      <form className="input-area" onSubmit={handleSubmit}>
        {isAttractionStep && selectedCards.size > 0 && (
          <div className="selected-preview">
            已选 {selectedCards.size} 个：{Array.from(selectedCards).join('、')}
          </div>
        )}
        <div className="input-row">
          <textarea
            ref={textareaRef}
            className="chat-input"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              isChatMode
                ? '行程已生成，可以继续提问或要求调整…'
                : !started
                ? '告诉我你想去哪里旅行…'
                : isAttractionStep
                ? '可以选择上方卡片，也可以直接输入偏好…'
                : '继续输入…（Enter 发送，Shift+Enter 换行）'
            }
            rows={1}
            disabled={loading}
          />
          <button className="send-btn" type="submit" disabled={!canSend}>
            {loading ? '…' : '→'}
          </button>
        </div>
      </form>
    </main>
  );
}
