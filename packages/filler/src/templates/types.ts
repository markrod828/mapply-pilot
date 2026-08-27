import type { AtsKind } from '@mapply/core/application';
import type { Comparator } from '../write';
import type { ValueKey } from '../values';

/**
 * How to find a field.
 *
 * A CSS selector where the ATS gives a stable id, and the label where it does
 * not. Greenhouse needs both: the core details keep ids like `#first_name`
 * forever, while the voluntary questions are numbered per posting - `4033064002`
 * is "Gender" on one job and nothing at all on the next. Only the label is
 * stable there, and Playwright resolves `aria-labelledby` for us.
 */
export interface Target {
  selector?: string;
  label?: RegExp;
}

/**
 * A form we already know the shape of.
 *
 * The observation this rests on: on a templated ATS roughly seven fields in ten
 * are the same on every posting, and the rest are the employer's own questions.
 * A template answers the seven at no cost and says plainly where it stops - the
 * `delegate` entries are what the answer bank and the generic engine take over,
 * rather than a silent gap.
 */
export type TemplatePlan =
  | (Target & {
      kind: 'text';
      value: ValueKey;
      required?: boolean;
      comparator?: Comparator;
      /** Fetches its options as you type; needs real keystrokes. */
      typeahead?: boolean;
    })
  | (Target & { kind: 'file'; artifact: 'resume' | 'coverLetter'; required?: boolean })
  | (Target & {
      /**
       * A pick-one field, whether the page draws it as a `<select>` or as a
       * custom widget. Which it is gets decided by looking, not by declaring:
       * the same question is a native select on the old Greenhouse form and
       * react-select on the new one.
       */
      kind: 'choice';
      value: ValueKey;
      required?: boolean;
      /** Chosen when the profile is silent - the decline option on an EEOC question. */
      fallback?: RegExp;
      /** Accept the first option if nothing matches. Only for pickers that reword. */
      allowFirst?: boolean;
      /**
       * Failing this field does not have to stop a submission.
       *
       * For fields the form itself says are optional in practice - a picker
       * whose backing service is down, where the form prints "you can submit
       * without this". Recorded as waived rather than silently ignored, so what
       * was skipped stays on the application record.
       */
      waivable?: boolean;
    })
  | { kind: 'delegate'; container: string };

export interface ConfirmSpec {
  /** A 2xx or 3xx on this means the server took the application. */
  responseUrl: RegExp;
  urlPattern: RegExp;
  textPattern: RegExp;
}

export interface FormTemplate {
  id: string;
  atsKind: AtsKind;
  /** URL test first, then a DOM signature - so a form embedded in a company's
   *  own careers page under their domain still matches. */
  urlPattern: RegExp;
  domSignature: string;
  fields: TemplatePlan[];
  /**
   * Complaints from the form that do not have to stop a submission, because
   * the form itself says so. Matched against its own validation text.
   */
  waivableErrors?: RegExp;
  submitSelector: string;
  confirm: ConfirmSpec;
}
