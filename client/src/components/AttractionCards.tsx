import { AttractionCard } from '../api';

const CATEGORY_EMOJI: Record<string, string> = {
  nature: '🌿',
  culture: '🏛️',
  food: '🍜',
  shopping: '🛍️',
  activity: '🎭',
  other: '📍',
};

interface Props {
  cards: AttractionCard[];
  selected: Set<string>;
  onToggle: (name: string) => void;
}

export function AttractionCards({ cards, selected, onToggle }: Props) {
  if (!cards.length) return null;

  return (
    <div className="attraction-cards">
      <p className="cards-hint">点击卡片选择景点，也可以直接在输入框中回复</p>
      <div className="cards-grid">
        {cards.map(card => {
          const isSelected = selected.has(card.name);
          return (
            <button
              key={card.id}
              className={`attraction-card ${isSelected ? 'selected' : ''}`}
              onClick={() => onToggle(card.name)}
              type="button"
            >
              <div className="card-header">
                <span className="card-emoji">{CATEGORY_EMOJI[card.category] ?? '📍'}</span>
                <span className="card-name">{card.name}</span>
                <span className={`card-check ${isSelected ? 'visible' : ''}`}>✓</span>
              </div>
              <p className="card-desc">{card.description}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}
