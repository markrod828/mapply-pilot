import type { AutofillResponse } from '../../lib/messages';
import { runAutofill, watchForNewFields, type AutofillResult } from './engine';

const STYLE = `
:host { all: initial; }
.panel {
  /* Same palette as the side panel's dark theme, so the two read as one product. */
  --surface: #111a2c;
  --surface-2: #172236;
  --border: #22304a;
  --border-strong: #33456a;
  --text: #e7eefb;
  --muted: #96a5c0;
  --faint: #6d7d9b;
  --accent: #38bdf8;
  --accent-hover: #7dd3fc;
  --accent-text: #062435;
  --accent-ring: rgba(56, 189, 248, 0.35);
  --warn: #fcd34d;

  user-select: none;
  /* Let the pointer drag rather than scroll the page under it. */
  touch-action: none;
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 2147483600;
  width: 260px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
  font-size: 13px;
  background: var(--surface);
  color: var(--text);
  border-radius: 14px;
  /* Strong enough to hold an edge against a dark page, where the shadow cannot. */
  border: 1px solid var(--border-strong);
  box-shadow: 0 18px 40px rgba(2, 6, 23, 0.55), 0 2px 10px rgba(2, 6, 23, 0.4),
    0 0 0 1px rgba(148, 163, 184, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.06);
  /* The title bar is full bleed, so the padding lives on .body instead. */
  padding: 0;
  cursor: grab;
  overflow: hidden;
}
.panel:active { cursor: grabbing; }
.header {
  display: flex;
  align-items: center;
  gap: 9px;
  /* A real title bar: tall enough to grab without aiming. */
  padding: 9px 10px 9px 11px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
  transition: background 140ms ease;
}
.header:hover { background: #1c2942; }
.grip {
  flex: none;
  width: 10px;
  height: 16px;
  color: var(--faint);
  background-image: radial-gradient(currentColor 1px, transparent 1.2px);
  background-size: 5px 5px;
  background-position: center;
}
.title {
  flex: 1;
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.01em;
  color: var(--text);
}
.body { padding: 12px; }
button {
  font: inherit;
  border: 0;
  cursor: pointer;
  transition: background 140ms ease, color 140ms ease, transform 140ms ease;
}
button:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--accent-ring);
}
.close {
  flex: none;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  background: transparent;
  color: var(--faint);
  font-size: 16px;
  line-height: 1;
  border-radius: 6px;
}
.close:hover { background: rgba(148, 163, 184, 0.16); color: var(--text); }
.fill {
  width: 100%;
  font-size: 13px;
  font-weight: 650;
  color: var(--accent-text);
  background: var(--accent);
  border-radius: 9px;
  padding: 9px 12px;
}
.fill:hover:not(:disabled) { background: var(--accent-hover); }
.fill:active:not(:disabled) { transform: translateY(1px); }
.fill:disabled { opacity: 0.55; cursor: default; }
/* Results are worth reading and copying, so this block is not a drag surface. */
.status {
  font-size: 11.5px;
  line-height: 1.5;
  margin-top: 10px;
  color: var(--muted);
  cursor: auto;
  user-select: text;
}
.status strong { color: var(--text); font-weight: 650; }
/* Findings read as a list, not one run-on paragraph. */
.line + .line { margin-top: 6px; }
.foot {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
  color: var(--faint);
}
.status ul { margin: 4px 0 0; padding-left: 15px; }
.status li { margin-top: 2px; }
.status li::marker { color: var(--faint); }
.warn { color: var(--warn); }
@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; }
}
`;

let mounted = false;
/** Stops the sweep that keeps filling later wizard steps. Null when nothing is watching. */
let stopWatching: (() => void) | null = null;
/** Set while the panel is up, so a later sweep has somewhere to report. */
let showProgress: ((html: string) => void) | null = null;

export function startAutofillUi(): void {
  if (mounted) return;
  mounted = true;

  const host = document.createElement('div');
  host.id = 'applypilot-autofill';
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = STYLE;

  const panel = document.createElement('div');
  panel.className = 'panel';

  const header = document.createElement('div');
  header.className = 'header';

  const grip = document.createElement('div');
  grip.className = 'grip';

  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = 'ApplyPilot';

  header.title = 'Drag to move';

  const close = document.createElement('button');
  close.className = 'close';
  close.textContent = '×';
  close.title = 'Hide this panel';
  close.setAttribute('aria-label', 'Hide ApplyPilot');
  close.addEventListener('click', () => {
    host.remove();
    // Closing the panel is also how you say "stop touching this form".
    stopWatching?.();
    stopWatching = null;
    showProgress = null;
    // Allow it back when autofill is asked for again.
    mounted = false;
  });

  header.append(grip, title, close);

  const button = document.createElement('button');
  button.className = 'fill';
  button.textContent = 'Autofill this application';

  const status = document.createElement('div');
  status.className = 'status';
  status.textContent = 'Review every field before you submit.';

  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = 'Filling…';
    try {
      const result = await autofillNow();
      status.innerHTML = renderResult(result);
    } catch (error) {
      status.innerHTML = `<span class="warn">${escapeHtml((error as Error).message)}</span>`;
    } finally {
      button.disabled = false;
    }
  });

  showProgress = (html: string) => {
    status.innerHTML = html;
  };

  const body = document.createElement('div');
  body.className = 'body';
  body.append(button, status);

  panel.append(header, body);
  shadow.append(style, panel);
  document.documentElement.appendChild(host);

  makeDraggable(panel);
  void restorePosition(panel);
}

const POSITION_KEY = 'autofillPanelPosition';
/** Keep this much of a gap so the panel cannot be dragged off the viewport. */
const EDGE = 8;

interface PanelPosition {
  left: number;
  top: number;
}

/** Anything you can click, type in or read closely is not a drag surface. */
const CONTROLS = 'button, a, input, textarea, select, .status';

/**
 * The panel sits over the form, so it has to be movable - otherwise it covers the
 * very buttons you are trying to press. The whole panel is the handle, since a thin
 * title strip is easy to miss; only the controls and the result text are exempt.
 */
function makeDraggable(panel: HTMLElement): void {
  let activePointer: number | null = null;
  let grabX = 0;
  let grabY = 0;

  panel.addEventListener('pointerdown', (event) => {
    // Left button only, and never start a drag from a control.
    if (event.button !== 0 || (event.target as HTMLElement).closest(CONTROLS)) return;

    const rect = panel.getBoundingClientRect();
    grabX = event.clientX - rect.left;
    grabY = event.clientY - rect.top;
    activePointer = event.pointerId;
    panel.setPointerCapture(activePointer);
    // Swap the right/bottom anchoring for explicit coordinates before moving.
    place(panel, rect.left, rect.top);
    event.preventDefault();
  });

  panel.addEventListener('pointermove', (event) => {
    if (activePointer === null || event.pointerId !== activePointer) return;
    place(panel, event.clientX - grabX, event.clientY - grabY);
  });

  const release = (event: PointerEvent) => {
    if (activePointer === null || event.pointerId !== activePointer) return;
    panel.releasePointerCapture(activePointer);
    activePointer = null;
    void savePosition(panel);
  };

  panel.addEventListener('pointerup', release);
  panel.addEventListener('pointercancel', release);

  // A window that shrinks must not strand the panel outside the viewport.
  window.addEventListener('resize', () => {
    if (panel.style.left) place(panel, parseFloat(panel.style.left), parseFloat(panel.style.top));
  });
}

function place(panel: HTMLElement, left: number, top: number): void {
  const maxLeft = Math.max(EDGE, window.innerWidth - panel.offsetWidth - EDGE);
  const maxTop = Math.max(EDGE, window.innerHeight - panel.offsetHeight - EDGE);

  panel.style.left = `${clamp(left, EDGE, maxLeft)}px`;
  panel.style.top = `${clamp(top, EDGE, maxTop)}px`;
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

async function savePosition(panel: HTMLElement): Promise<void> {
  const position: PanelPosition = {
    left: parseFloat(panel.style.left),
    top: parseFloat(panel.style.top),
  };
  if (!Number.isFinite(position.left) || !Number.isFinite(position.top)) return;

  try {
    await chrome.storage.local.set({ [POSITION_KEY]: position });
  } catch {
    // Extension reloaded; the panel still works, it just will not remember.
  }
}

/** Put the panel back where it was last left, on this and every other form. */
async function restorePosition(panel: HTMLElement): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(POSITION_KEY);
    const position = stored[POSITION_KEY] as PanelPosition | undefined;
    if (position && Number.isFinite(position.left) && Number.isFinite(position.top)) {
      place(panel, position.left, position.top);
    }
  } catch {
    // No stored position, or the extension reloaded: leave the default corner.
  }
}

export async function autofillNow(): Promise<AutofillResult> {
  const response = (await chrome.runtime.sendMessage({ type: 'GET_AUTOFILL_PAYLOAD' })) as AutofillResponse;
  if (!response?.ok || !response.payload) {
    throw new Error(response?.error ?? 'ApplyPilot could not load your profile.');
  }

  const payload = response.payload;
  const result = await runAutofill(payload);

  /*
   * The rest of the application arrives after this pass: a wizard routes in its next
   * step, an answer reveals the question under it. Watching starts only here, once
   * filling has been asked for, so the extension never types into a form on its own.
   */
  stopWatching?.();
  stopWatching = watchForNewFields(payload, (keys) => {
    showProgress?.(
      `<strong>${keys.length}</strong> more field(s) filled as the form continued. ` +
        'Review every field before you submit.',
    );
  });

  return result;
}

function renderResult(result: AutofillResult): string {
  const lines = [
    `<strong>${result.filled.length}</strong> field(s) filled via ${escapeHtml(result.adapter)}.`,
    result.resumeAttached
      ? `Attached ${escapeHtml(result.resumeLabel)}.`
      : 'No resume upload field found.',
  ];

  if (result.coverLetter === 'text') {
    lines.push('Cover letter written and pasted in — read it before submitting.');
  } else if (result.coverLetter === 'file') {
    lines.push('Cover letter written and attached — read it before submitting.');
  }

  if (result.coverLetterWarning) {
    lines.push(`<span class="warn">${escapeHtml(result.coverLetterWarning)}</span>`);
  }

  if (result.resumeWarning) {
    lines.push(`<span class="warn">${escapeHtml(result.resumeWarning)}</span>`);
  }

  if (result.answered.length) {
    lines.push(
      `<strong>${result.answered.length}</strong> question(s) answered from your resume — outlined amber, read them.`,
    );
  }

  if (result.ownWordsAsked.length) {
    const items = result.ownWordsAsked
      .slice(0, 3)
      .map((label) => `<li>${escapeHtml(label)}</li>`)
      .join('');
    lines.push(
      `<span class="warn">This employer asked for your own words on:</span><ul>${items}</ul>` +
        '<span class="warn">Rewrite these yourself before submitting.</span>',
    );
  }

  if (result.answerWarning) {
    lines.push(`<span class="warn">${escapeHtml(result.answerWarning)}</span>`);
  }

  if (result.skipped.length) {
    const items = result.skipped
      .slice(0, 5)
      .map((label) => `<li>${escapeHtml(label)}</li>`)
      .join('');
    lines.push(`<span class="warn">Still required:</span><ul>${items}</ul>`);
  }

  // Divs, not <p>: a <ul> inside a paragraph closes it and strands the markup.
  return (
    lines.map((line) => `<div class="line">${line}</div>`).join('') +
    '<div class="foot">Check everything, then submit yourself.</div>'
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) =>
    char === '&' ? '&amp;' : char === '<' ? '&lt;' : char === '>' ? '&gt;' : '&quot;',
  );
}
