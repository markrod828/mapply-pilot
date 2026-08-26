import type { AutofillResponse } from '../../lib/messages';
import { runAutofill, type AutofillResult } from './engine';

const STYLE = `
:host { all: initial; }
.panel {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 2147483600;
  width: 250px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: #0f172a;
  color: #f8fafc;
  border-radius: 12px;
  border: 1px solid rgba(148, 163, 184, 0.3);
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.35);
  padding: 12px;
}
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
  cursor: grab;
  user-select: none;
  /* Let the pointer drag rather than scroll the page under it. */
  touch-action: none;
}
.header:active { cursor: grabbing; }
.title { font-size: 12px; font-weight: 700; }
.close {
  width: auto;
  flex: none;
  background: transparent;
  color: #94a3b8;
  font-size: 16px;
  line-height: 1;
  padding: 0 2px;
  border-radius: 4px;
}
.close:hover { background: rgba(148, 163, 184, 0.2); color: #f8fafc; }
button {
  width: 100%;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  color: #0f172a;
  background: #38bdf8;
  border: 0;
  border-radius: 8px;
  padding: 8px 10px;
  cursor: pointer;
}
button:hover { background: #7dd3fc; }
button:disabled { opacity: 0.6; cursor: default; }
.status { font-size: 11px; line-height: 1.45; margin-top: 8px; opacity: 0.85; }
.status ul { margin: 4px 0 0; padding-left: 16px; }
.warn { color: #fbbf24; }
`;

let mounted = false;

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

  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = 'ApplyPilot';
  title.title = 'Drag to move';

  const close = document.createElement('button');
  close.className = 'close';
  close.textContent = '×';
  close.title = 'Hide this panel';
  close.setAttribute('aria-label', 'Hide ApplyPilot');
  close.addEventListener('click', () => {
    host.remove();
    // Allow it back when autofill is asked for again.
    mounted = false;
  });

  header.append(title, close);

  const button = document.createElement('button');
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

  panel.append(header, button, status);
  shadow.append(style, panel);
  document.documentElement.appendChild(host);

  makeDraggable(panel, header);
  void restorePosition(panel);
}

const POSITION_KEY = 'autofillPanelPosition';
/** Keep this much of a gap so the panel cannot be dragged off the viewport. */
const EDGE = 8;

interface PanelPosition {
  left: number;
  top: number;
}

/**
 * The panel sits over the form, so it has to be movable - otherwise it covers the
 * very buttons you are trying to press. Dragging is by the header only, leaving the
 * autofill button and the status text clickable and selectable.
 */
function makeDraggable(panel: HTMLElement, handle: HTMLElement): void {
  let activePointer: number | null = null;
  let grabX = 0;
  let grabY = 0;

  handle.addEventListener('pointerdown', (event) => {
    // Left button only, and never start a drag from the close button.
    if (event.button !== 0 || (event.target as HTMLElement).closest('.close')) return;

    const rect = panel.getBoundingClientRect();
    grabX = event.clientX - rect.left;
    grabY = event.clientY - rect.top;
    activePointer = event.pointerId;
    handle.setPointerCapture(activePointer);
    // Swap the right/bottom anchoring for explicit coordinates before moving.
    place(panel, rect.left, rect.top);
    event.preventDefault();
  });

  handle.addEventListener('pointermove', (event) => {
    if (activePointer === null || event.pointerId !== activePointer) return;
    place(panel, event.clientX - grabX, event.clientY - grabY);
  });

  const release = (event: PointerEvent) => {
    if (activePointer === null || event.pointerId !== activePointer) return;
    handle.releasePointerCapture(activePointer);
    activePointer = null;
    void savePosition(panel);
  };

  handle.addEventListener('pointerup', release);
  handle.addEventListener('pointercancel', release);

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
  return runAutofill(response.payload);
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

  lines.push('<span class="warn">Check everything, then submit yourself.</span>');
  return lines.join('<br>');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) =>
    char === '&' ? '&amp;' : char === '<' ? '&lt;' : char === '>' ? '&gt;' : '&quot;',
  );
}
