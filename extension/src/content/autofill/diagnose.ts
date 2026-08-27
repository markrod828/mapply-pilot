import type { AutofillPayload } from '../../lib/messages';
import { findAdapter } from './adapters';
import { collectChoiceGroups } from './choices';
import { isCombobox } from './combobox';
import { collectFields, describeField, hasValue, wasTouched, type Fillable } from './fill';
import { buildRules } from './rules';

/**
 * What the extension can actually see on this page.
 *
 * Every ATS that has needed fixing so far took a round trip: a screenshot or a hand-copied
 * chunk of markup, then a guess at the rest. This reports the same view the filler works
 * from — the label it computed for each control, and the rule that claimed it — so a form
 * that fills badly can be diagnosed from one paste instead of an inspect-element session.
 *
 * Deliberately read-only: it fills nothing and clicks nothing.
 */
export function buildFieldReport(payload: AutofillPayload): string {
  const rules = buildRules(payload.profile, payload.resumeText);
  const fields = collectFields();

  const lines = [
    'ApplyPilot field report',
    `url      : ${location.href}`,
    `adapter  : ${findAdapter(location.hostname)?.name ?? 'Generic (label rules only)'}`,
    `<form>   : ${document.querySelector('form, [role="form"]') ? 'present' : 'none'}`,
    `frame    : ${window.top === window.self ? 'top' : 'iframe'}`,
    '',
    `${fields.length} visible field(s)   [kind | state | rule | label as the filler reads it]`,
  ];

  for (const field of fields) {
    lines.push(`  ${kindOf(field)} | ${stateOf(field)} | ${ruleFor(rules, field)} | ${labelOf(field)}`);
  }

  const groups = collectChoiceGroups();
  lines.push('', `${groups.length} choice group(s)   [options | state | question]`);
  for (const group of groups) {
    const options = group.options.slice(0, 6).join(' / ').slice(0, 80);
    lines.push(`  [${options}] | ${group.answered() ? 'answered' : 'empty'} | ${group.label.slice(0, 120)}`);
  }

  const boxes = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
  lines.push('', `${boxes.length} checkbox(es)   [state | label]`);
  for (const box of boxes) {
    lines.push(`  ${box.checked ? 'ticked ' : 'unticked'} | ${describeField(box).slice(0, 120)}`);
  }

  return lines.join('\n');
}

function kindOf(field: Fillable): string {
  if (field instanceof HTMLSelectElement) return `select(${field.options.length})`;
  if (field instanceof HTMLTextAreaElement) return 'textarea';
  // Read the type first: isCombobox narrows to HTMLInputElement, which leaves the
  // negative branch as `never` for something already known to be an input.
  const type = field.type || 'text';
  return isCombobox(field) ? 'combobox' : `input[${type}]`;
}

function stateOf(field: Fillable): string {
  if (hasValue(field)) return wasTouched(field) ? 'filled by us' : 'already filled';
  return wasTouched(field) ? 'cleared since' : 'empty';
}

/** The rule that would claim this field, which is the question when one fills wrongly. */
function ruleFor(rules: ReturnType<typeof buildRules>, field: Fillable): string {
  const label = describeField(field);
  const rule = rules.find((candidate) => {
    if (candidate.longForm && !(field instanceof HTMLTextAreaElement)) return false;
    if (candidate.exclude?.test(label)) return false;
    return candidate.test.test(label);
  });
  return (rule?.key ?? '-').padEnd(18);
}

function labelOf(field: Fillable): string {
  const label = describeField(field);
  return label ? label.slice(0, 140) : '(no label found)';
}
