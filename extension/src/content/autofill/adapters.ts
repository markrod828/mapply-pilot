import type { Profile } from '../../lib/types';

export type ValueKey =
  | 'firstName'
  | 'lastName'
  | 'fullName'
  | 'email'
  | 'phone'
  | 'linkedin'
  | 'github'
  | 'portfolio'
  | 'city'
  | 'location'
  | 'currentTitle';

export interface AdapterField {
  selector: string;
  key: ValueKey;
}

export interface SiteAdapter {
  name: string;
  matches: RegExp;
  fields: AdapterField[];
}

export const ADAPTERS: SiteAdapter[] = [
  {
    name: 'Greenhouse',
    matches: /greenhouse\.io$/,
    fields: [
      { selector: '#first_name, input[name="first_name"]', key: 'firstName' },
      { selector: '#last_name, input[name="last_name"]', key: 'lastName' },
      { selector: '#email, input[name="email"]', key: 'email' },
      { selector: '#phone, input[name="phone"]', key: 'phone' },
      { selector: 'input[name*="linkedin" i], #job_application_answers_attributes_0_text_value', key: 'linkedin' },
    ],
  },
  {
    name: 'Lever',
    matches: /lever\.co$/,
    fields: [
      { selector: 'input[name="name"]', key: 'fullName' },
      { selector: 'input[name="email"]', key: 'email' },
      { selector: 'input[name="phone"]', key: 'phone' },
      { selector: 'input[name="location"]', key: 'location' },
      { selector: 'input[name="urls[LinkedIn]"]', key: 'linkedin' },
      { selector: 'input[name="urls[GitHub]"], input[name="urls[Github]"]', key: 'github' },
      { selector: 'input[name="urls[Portfolio]"]', key: 'portfolio' },
    ],
  },
  {
    name: 'Ashby',
    matches: /ashbyhq\.com$/,
    fields: [
      { selector: '#_systemfield_name, input[name="_systemfield_name"]', key: 'fullName' },
      { selector: '#_systemfield_email, input[name="_systemfield_email"]', key: 'email' },
      { selector: '#_systemfield_phone, input[name="_systemfield_phone"]', key: 'phone' },
      { selector: 'input[name*="linkedin" i]', key: 'linkedin' },
      { selector: 'input[name*="github" i]', key: 'github' },
    ],
  },
  {
    name: 'Rippling',
    matches: /(^|\.)rippling\.com$/,
    fields: [
      { selector: 'input[name*="first" i][name*="name" i], input[autocomplete="given-name"]', key: 'firstName' },
      { selector: 'input[name*="last" i][name*="name" i], input[autocomplete="family-name"]', key: 'lastName' },
      { selector: 'input[type="email"], input[name*="email" i], input[autocomplete="email"]', key: 'email' },
      { selector: 'input[type="tel"], input[name*="phone" i], input[autocomplete="tel"]', key: 'phone' },
      { selector: 'input[name*="linkedin" i], input[placeholder*="linkedin" i]', key: 'linkedin' },
      { selector: 'input[name*="github" i], input[placeholder*="github" i]', key: 'github' },
      { selector: 'input[name*="city" i], input[autocomplete="address-level2"]', key: 'city' },
      { selector: 'input[name*="location" i], input[placeholder*="location" i]', key: 'location' },
    ],
  },
];

export function findAdapter(hostname: string): SiteAdapter | null {
  return ADAPTERS.find((adapter) => adapter.matches.test(hostname)) ?? null;
}

export function resolveValue(profile: Profile, key: ValueKey): string {
  switch (key) {
    case 'fullName':
      return `${profile.firstName} ${profile.lastName}`.trim();
    case 'location':
      return [profile.city, profile.state, profile.country].filter(Boolean).join(', ');
    default:
      return profile[key];
  }
}
