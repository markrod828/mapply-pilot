import type { FormRoot } from './templates/index';

export type ControlKind =
  | 'text'
  | 'textarea'
  | 'select'
  | 'combobox'
  | 'checkbox'
  | 'radiogroup'
  | 'file'
  | 'other';

export interface DiscoveredField {
  /** Stamped on the element so it can be addressed again without re-searching. */
  ref: string;
  label: string;
  labelSource: string;
  labelScore: number;
  control: ControlKind;
  required: boolean;
  hasValue: boolean;
  /** Present for native selects; a combobox has to be opened to learn its options. */
  options?: string[];
}

/**
 * Finds the fields a template did not claim, and works out what each one is asking.
 *
 * The hard part is not finding the controls, it is deciding which words belong to
 * which one. The approach this replaces concatenated every possible label source
 * into a single string and matched against the lot, which meant two fields
 * sharing a wrapper each inherited the other's words - so a rule written to
 * exclude "email" would fire on a phone box merely because the email label was
 * nearby.
 *
 * Here each candidate is scored by how directly it names the field, and then
 * assigned exclusively: the best pairing wins, and a label element that has been
 * claimed cannot be claimed again. A second field sharing the wrapper is pushed
 * onto its own next-best source instead of quietly copying its neighbour.
 */
export async function discoverFields(
  root: FormRoot,
  container?: string,
): Promise<DiscoveredField[]> {
  return root.evaluate((scopeSelector) => {
    const CONTROLS = 'input, textarea, select, [role="combobox"], [role="radiogroup"]';
    const SKIP = new Set(['hidden', 'submit', 'button', 'image', 'reset', 'password']);

    // Every matching container, not just the first. A template names its
    // delegate areas as one comma-separated selector, and querySelector would
    // take only the earliest of them - which on Greenhouse is the block holding
    // the name and email, leaving the employer's own questions undiscovered.
    const scopes: ParentNode[] = scopeSelector
      ? Array.from(document.querySelectorAll(scopeSelector))
      : [document];
    if (!scopes.length) scopes.push(document);

    const visible = (element: Element): boolean => {
      const style = getComputedStyle(element as HTMLElement);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      // Not opacity: styled forms routinely hide the real control behind a
      // painted one, and those still need filling.
      return element.getClientRects().length > 0 || style.position === 'fixed';
    };

    const text = (node: Element | null): string =>
      (node?.textContent ?? '').replace(/\s+/g, ' ').trim();

    const found = new Set<Element>();
    for (const scope of scopes) {
      for (const element of Array.from(scope.querySelectorAll(CONTROLS))) found.add(element);
    }

    const controls = Array.from(found).filter((element) => {
      const input = element as HTMLInputElement;
      if (input.type && SKIP.has(input.type)) return false;
      if (input.disabled) return false;
      if (element.getAttribute('aria-hidden') === 'true') return false;
      return visible(element);
    });

    // Every plausible (field, label) pairing, scored. Higher means the words more
    // certainly belong to that field.
    const WEIGHT: Record<string, number> = {
      labelFor: 100,
      ariaLabelledby: 95,
      wrappingLabel: 90,
      ariaLabel: 85,
      fieldsetLegend: 60,
      placeholder: 40,
    };

    interface Pair {
      field: Element;
      node: Element | null;
      source: string;
      text: string;
      score: number;
    }

    const pairs: Pair[] = [];
    const add = (field: Element, node: Element | null, source: string, value: string) => {
      const trimmed = value.replace(/\s+/g, ' ').trim();
      if (!trimmed) return;
      let score = WEIGHT[source] ?? 30;
      // A "label" this long is a wrapper that swallowed its siblings, not a name.
      if (trimmed.length > 120) score -= 30;
      if (trimmed.length > 240) score -= 40;
      pairs.push({ field, node, source, text: trimmed, score });
    };

    for (const field of controls) {
      const id = field.getAttribute('id');
      if (id) {
        const escaped = id.replace(/"/g, '\\"');
        add(field, document.querySelector(`label[for="${escaped}"]`), 'labelFor',
          text(document.querySelector(`label[for="${escaped}"]`)));
      }

      const labelledBy = field.getAttribute('aria-labelledby');
      if (labelledBy) {
        for (const target of labelledBy.split(/\s+/)) {
          const node = document.getElementById(target);
          add(field, node, 'ariaLabelledby', text(node));
        }
      }

      const wrapping = field.closest('label');
      if (wrapping) add(field, wrapping, 'wrappingLabel', text(wrapping));

      add(field, null, 'ariaLabel', field.getAttribute('aria-label') ?? '');
      add(field, null, 'placeholder', (field as HTMLInputElement).placeholder ?? '');

      const legend = field.closest('fieldset')?.querySelector('legend');
      if (legend) add(field, legend, 'fieldsetLegend', text(legend));
    }

    pairs.sort((a, b) => b.score - a.score);

    const assigned = new Map<Element, Pair>();
    const taken = new Set<Element>();
    for (const pair of pairs) {
      if (assigned.has(pair.field)) continue;
      // One label element names one field. Without this, two inputs in a shared
      // wrapper both take the same words and one of them is silently mislabelled.
      if (pair.node && taken.has(pair.node)) continue;
      assigned.set(pair.field, pair);
      if (pair.node) taken.add(pair.node);
    }

    const kindOf = (element: Element): string => {
      if (element.getAttribute('role') === 'radiogroup') return 'radiogroup';
      if (element.getAttribute('role') === 'combobox') return 'combobox';
      if (element.tagName === 'TEXTAREA') return 'textarea';
      if (element.tagName === 'SELECT') return 'select';
      const type = (element as HTMLInputElement).type;
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radiogroup';
      if (type === 'file') return 'file';
      if (element.hasAttribute('aria-haspopup') || element.hasAttribute('aria-autocomplete')) {
        return 'combobox';
      }
      return 'text';
    };

    let counter = 0;
    const out: unknown[] = [];
    for (const field of controls) {
      const pair = assigned.get(field);
      if (!pair) continue;

      const ref = `mp${(counter += 1)}`;
      field.setAttribute('data-mp-ref', ref);

      const input = field as HTMLInputElement;
      const kind = kindOf(field);
      const required =
        input.required ||
        field.getAttribute('aria-required') === 'true' ||
        /\*/.test(pair.text);

      out.push({
        ref,
        label: pair.text.replace(/\s*\*\s*$/, '').trim(),
        labelSource: pair.source,
        labelScore: pair.score,
        control: kind,
        required,
        hasValue:
          kind === 'checkbox'
            ? input.checked
            : kind === 'select'
              ? (field as unknown as HTMLSelectElement).selectedIndex > 0
              : Boolean(input.value),
        options:
          kind === 'select'
            ? Array.from((field as unknown as HTMLSelectElement).options)
                .filter((option) => option.value !== '')
                .map((option) => option.text.replace(/\s+/g, ' ').trim())
            : undefined,
      });
    }
    return out as never;
  }, container ?? null);
}
