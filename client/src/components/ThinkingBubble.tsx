import { useState } from 'react';

interface ThinkingBubbleProps {
  /** Thinking text. When streaming this is the live accumulation. */
  text: string | undefined;
  /** True while reasoning-delta events are still arriving. */
  isStreaming?: boolean;
}

export function ThinkingBubble({ text, isStreaming = false }: ThinkingBubbleProps) {
  const [expandedManual, setExpandedManual] = useState(false);

  if (!text && !isStreaming) return null;

  // Auto-expanded while streaming; user-controlled after streaming ends.
  const expanded = isStreaming || expandedManual;

  return (
    <div className={`thinking-bubble ${isStreaming ? 'streaming' : ''}`}>
      <button
        className="thinking-bubble-header"
        onClick={() => !isStreaming && setExpandedManual(v => !v)}
        aria-expanded={expanded}
        style={{ cursor: isStreaming ? 'default' : 'pointer' }}
      >
        <span className="thinking-icon">💭</span>
        <span className="thinking-label">
          {isStreaming ? '思考中…' : '查看思考过程'}
        </span>
        {isStreaming && <span className="thinking-spinner" />}
        {!isStreaming && (
          <span className={`thinking-chevron ${expandedManual ? 'expanded' : ''}`}>›</span>
        )}
      </button>

      {expanded && (
        <div className="thinking-body">
          {text ? (
            <pre className="thinking-text">
              {text}
              {isStreaming && <span className="thinking-cursor" />}
            </pre>
          ) : (
            /* No text yet — show animated dots */
            <div className="thinking-stream-placeholder">
              <span className="thinking-dot" />
              <span className="thinking-dot" />
              <span className="thinking-dot" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
