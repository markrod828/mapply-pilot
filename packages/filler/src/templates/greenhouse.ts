import type { FormTemplate } from './types';

/** What a form calls "would rather not say", in the wordings actually seen. */
const DECLINE = /decline|prefer not|do(?:n't| not) wish|not to (?:answer|disclose|identify)|rather not/i;

/**
 * Greenhouse, both generations.
 *
 * Checked against a live posting rather than assumed, which changed the shape of
 * it. Two things the current form does that the old one did not:
 *
 * - Only the core details keep stable ids. Everything the employer configures -
 *   the voluntary questions above all - is numbered per posting, so `4033064002`
 *   is "Gender" on one job and absent from the next. Those are addressed by
 *   label, which is the only durable handle they have.
 * - Every dropdown is react-select, not `<select>`. The options do not exist in
 *   the document until the menu is opened, so they cannot be chosen by value.
 */
export const GREENHOUSE: FormTemplate = {
  id: 'greenhouse.v2',
  atsKind: 'greenhouse',
  urlPattern: /(^|\.)(job-)?boards\.greenhouse\.io|greenhouse\.io\/(embed|jobs)/i,
  // Matched when the URL does not give it away, which is the embedded case: a
  // company serves the form from their own domain inside an iframe.
  domSignature:
    '#application_form, #application-form, .application--form, form[action*="greenhouse"], [data-source="greenhouse"]',

  fields: [
    { kind: 'text', selector: '#first_name, input[name="first_name"]', value: 'firstName', required: true },
    { kind: 'text', selector: '#last_name, input[name="last_name"]', value: 'lastName', required: true },
    {
      kind: 'text',
      selector: '#email, input[name="email"]',
      value: 'email',
      required: true,
      comparator: 'exact',
    },
    { kind: 'text', selector: '#phone, input[name="phone"]', value: 'phone', comparator: 'digits' },

    // Pickers that reword what they are given: "Austin, TX, United States"
    // becomes whatever canonical entry the control holds, so the first offered
    // match is the right answer rather than a guess.
    //
    // Not marked required even though most postings demand them, because
    // `required` here means "this template cannot proceed without it" and some
    // Greenhouse forms simply have no location field. What the form itself
    // insists on is read from its own validation at the end, which is both more
    // accurate and self-updating - and react-select backs each picker with a
    // real hidden required input, so an unset one is caught there.
    // Addressed by id, not by label: the accessible name "Country" also belongs
    // to the phone number's dialing-code picker, and by label the wrong one wins.
    // This is that picker - its options read "United States +1" - so the profile
    // country is the right thing to put in it.
    { kind: 'choice', selector: '#country', value: 'country', allowFirst: true },
    // Greenhouse resolves this through its own geocoding proxy, which has been
    // answering 401, so no options ever arrive and there is nothing to pick.
    // Left in because the field behaves normally when that service is up; while
    // it is not, the form's own required check catches the empty box and the
    // application parks - which is the right outcome rather than a guessed city.
    {
      kind: 'choice',
      label: /location\s*\(city\)|^location\b/i,
      value: 'location',
      allowFirst: true,
      waivable: true,
    },

    { kind: 'text', label: /linkedin/i, value: 'linkedin' },
    { kind: 'text', label: /^website|personal site|portfolio/i, value: 'portfolio' },

    // Voluntary self-identification. Answered only from the profile; where the
    // profile is silent the decline option is taken. None of these is marked
    // required, so an unanswerable one can never park an application - these
    // are protected characteristics and a guess is not a small error.
    { kind: 'choice', label: /gender/i, value: 'gender', fallback: DECLINE },
    { kind: 'choice', label: /race|ethnic/i, value: 'ethnicity', fallback: DECLINE },
    { kind: 'choice', label: /veteran/i, value: 'veteranStatus', fallback: DECLINE },
    { kind: 'choice', label: /disab/i, value: 'disabilityStatus', fallback: DECLINE },

    // Uploads go last, deliberately. Greenhouse parses the resume the moment it
    // is attached and rewrites parts of the form from what it read, detaching
    // controls while they are being used - so everything else is set first and
    // the upload is the last thing that happens before submit.
    {
      kind: 'file',
      selector: '#resume, input[type="file"][name*="resume" i], input[type="file"][id*="resume" i]',
      artifact: 'resume',
      required: true,
    },
    {
      kind: 'file',
      selector: '#cover_letter, input[type="file"][name*="cover" i], input[type="file"][id*="cover" i]',
      artifact: 'coverLetter',
    },

    // Whatever the employer added themselves. Recorded, not answered: those need
    // the answer bank, and until it exists they are what a person reviews.
    { kind: 'delegate', container: '.application--questions, #custom_fields, [class*="custom-question" i]' },
  ],

  // Greenhouse prints this itself when its geocoder is unavailable, and says in
  // the same breath that the application may go without one. Taking the form at
  // its word here is the difference between applying and not applying at all
  // while the outage lasts.
  waivableErrors: /location service is temporarily unavailable/i,

  submitSelector: 'button[type="submit"], #submit_app, input[type="submit"]',

  confirm: {
    responseUrl: /greenhouse\.io\/.*(applications|apply|submit)/i,
    urlPattern: /(confirmation|thank|success|applied|submitted)/i,
    textPattern:
      /thank you for applying|application (has been )?(received|submitted)|we('ve| have) received your application|your application (is|was) (complete|submitted)/i,
  },
};
