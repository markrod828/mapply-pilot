import { formatAddress, formatLocation } from '@mapply/core/profile';
import type { JobPosting, Profile } from '@mapply/core';

/**
 * Every piece of the candidate a form might ask for, named once.
 *
 * These names come from the rule table the extension used, which had already
 * learned the distinctions that matter - that "address line 2" is not "address",
 * that a location picker wants a different string than a city box - and they are
 * kept so that work is not repeated.
 */
export type ValueKey =
  | 'firstName' | 'middleName' | 'lastName' | 'fullName' | 'preferredName' | 'pronouns'
  | 'email' | 'phone' | 'preferredContact'
  | 'linkedin' | 'github' | 'portfolio'
  | 'addressLine1' | 'addressLine2' | 'city' | 'state' | 'postalCode' | 'country'
  | 'fullAddress' | 'location'
  | 'currentTitle' | 'yearsExperience' | 'salaryExpectation' | 'noticePeriod'
  | 'availableStartDate'
  | 'workAuthorization' | 'requiresSponsorship' | 'willingToRelocate' | 'workPreference'
  | 'gender' | 'ethnicity' | 'veteranStatus' | 'disabilityStatus'
  | 'referralSource' | 'previouslyEmployed' | 'isOver18'
  | 'hasRelativesAtCompany' | 'relativesDetail' | 'agreeToTerms'
  | 'resumeText';

/** An answer a person has already given to this question, if there is one. */
export interface BankedAnswer {
  answer: string;
  source: string;
  approved: boolean;
}

export type AnswerLookup = (key: string, label: string) => Promise<BankedAnswer | null>;

export interface FillContext {
  profile: Profile;
  job: JobPosting;
  resumeText: string;
  /** Absolute path on disk. Playwright uploads by path, so nothing is base64'd. */
  resumePath?: string;
  coverLetterPath?: string;
  /**
   * Looks up what has already been answered for a question like this one.
   * Absent until a bank exists, in which case only the rules apply.
   */
  lookupAnswer?: AnswerLookup;
}

/**
 * Resolves one named value, or the empty string when the profile has nothing.
 *
 * Empty is meaningful and must not be written: a blank left blank is a question
 * the reviewer can answer, where a blank written over a form's own default is a
 * wrong answer nobody notices.
 */
export function resolveValue(key: ValueKey, ctx: FillContext): string {
  const p = ctx.profile;
  const address = p.address;

  switch (key) {
    case 'firstName': return p.firstName;
    case 'middleName': return p.middleName;
    case 'lastName': return p.lastName;
    case 'preferredName': return p.firstName;
    case 'fullName': return [p.firstName, p.lastName].filter(Boolean).join(' ');
    case 'pronouns': return p.pronouns;

    case 'email': return p.email;
    case 'phone': return p.phone;
    case 'preferredContact': return p.preferredContact;

    case 'linkedin': return p.linkedin;
    case 'github': return p.github;
    case 'portfolio': return p.portfolio;

    case 'addressLine1': return address.line1;
    case 'addressLine2': return address.line2;
    case 'city': return address.city;
    case 'state': return address.state;
    case 'postalCode': return address.postalCode;
    case 'country': return address.country;
    case 'fullAddress': return formatAddress(address);
    // "Austin, TX" rather than a street: what a location picker expects, and
    // what it will reword to "Austin, TX, USA" once chosen.
    case 'location': return formatLocation(address);

    case 'currentTitle': return p.currentTitle;
    case 'yearsExperience': return p.yearsExperience;
    case 'salaryExpectation': return p.salaryExpectation;
    case 'noticePeriod': return p.noticePeriod;
    case 'availableStartDate': return p.availableStartDate;

    case 'workAuthorization': return p.workAuthorization;
    case 'requiresSponsorship': return yesNo(p.requiresSponsorship);
    case 'willingToRelocate': return yesNo(p.willingToRelocate);
    case 'workPreference': return p.workPreference;

    case 'gender': return p.gender;
    case 'ethnicity': return p.ethnicity;
    case 'veteranStatus': return p.veteranStatus;
    case 'disabilityStatus': return p.disabilityStatus;

    case 'referralSource': return p.referralSource;
    case 'previouslyEmployed': return yesNo(p.previouslyEmployed);
    case 'isOver18': return yesNo(p.isOver18);
    case 'hasRelativesAtCompany': return yesNo(p.hasRelativesAtCompany);
    case 'relativesDetail': return p.relativesDetail;
    case 'agreeToTerms': return yesNo(p.agreeToTerms);

    case 'resumeText': return ctx.resumeText;
  }
}

/** Unset stays unset. Only an explicit yes or no becomes a word. */
function yesNo(value: '' | 'yes' | 'no'): string {
  return value === 'yes' ? 'Yes' : value === 'no' ? 'No' : '';
}

/**
 * Which comparator proves this value was written.
 *
 * Attached to the value rather than the field because it follows from what the
 * value *is*: a phone number is worth comparing by digits wherever it lands.
 */
export function comparatorFor(key: ValueKey): 'exact' | 'loose' | 'digits' | 'money' {
  if (key === 'phone') return 'digits';
  if (key === 'salaryExpectation') return 'money';
  return 'loose';
}
