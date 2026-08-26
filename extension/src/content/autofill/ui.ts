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
.title { font-size: 12px; font-weight: 700; margin-bottom: 8px; }
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

  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = 'ApplyPilot';

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

  panel.append(title, button, status);
  shadow.append(style, panel);
  document.documentElement.appendChild(host);
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

  if (result.coverLetterAttached) {
    lines.push('Cover letter attached.');
  }

  if (result.resumeWarning) {
    lines.push(`<span class="warn">${escapeHtml(result.resumeWarning)}</span>`);
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
