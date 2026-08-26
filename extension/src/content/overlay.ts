const STYLE = `
:host { all: initial; }
.card {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 2147483600;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: #0f172a;
  color: #f8fafc;
  border-radius: 12px;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.35);
  padding: 10px 14px;
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  user-select: none;
  border: 1px solid rgba(148, 163, 184, 0.3);
}
.card:hover { background: #1e293b; }
.score {
  font-size: 20px;
  font-weight: 700;
  min-width: 34px;
  text-align: center;
}
.label { font-size: 11px; line-height: 1.35; opacity: 0.85; max-width: 150px; }
.label strong { display: block; font-size: 12px; opacity: 1; }
.hidden { display: none; }
`;

export interface OverlayHandle {
  setScore(score: number | null, note: string): void;
  setStatus(note: string): void;
  hide(): void;
}

export function mountOverlay(onClick: () => void): OverlayHandle {
  const host = document.createElement('div');
  host.id = 'applypilot-overlay';
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = STYLE;

  const card = document.createElement('div');
  card.className = 'card';
  card.addEventListener('click', onClick);

  const scoreEl = document.createElement('div');
  scoreEl.className = 'score';
  scoreEl.textContent = '--';

  const labelEl = document.createElement('div');
  labelEl.className = 'label';
  labelEl.innerHTML = '<strong>ApplyPilot</strong><span>Reading job…</span>';

  card.append(scoreEl, labelEl);
  shadow.append(style, card);
  document.documentElement.appendChild(host);

  const setNote = (note: string) => {
    const span = labelEl.querySelector('span');
    if (span) span.textContent = note;
  };

  return {
    setScore(score, note) {
      card.classList.remove('hidden');
      scoreEl.textContent = score === null ? '--' : String(score);
      scoreEl.style.color =
        score === null ? '#f8fafc' : score >= 75 ? '#4ade80' : score >= 50 ? '#fbbf24' : '#f87171';
      setNote(note);
    },
    setStatus(note) {
      card.classList.remove('hidden');
      setNote(note);
    },
    hide() {
      card.classList.add('hidden');
    },
  };
}
