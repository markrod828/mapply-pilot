import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatDateFor } from '../src/dates';
import { equivalent } from '../src/write';
import { comparatorFor, resolveValue, type FillContext } from '../src/values';
import type { Profile } from '@mapply/core';

describe('equivalent', () => {
  it('accepts a phone the form reformatted', () => {
    // The single most common false failure: you write digits, the mask hands
    // back punctuation, and a naive check calls a good write a bad one.
    assert.ok(equivalent('(512) 555-0147', '5125550147', 'digits'));
    assert.ok(equivalent('+1 512-555-0147', '15125550147', 'digits'));
  });

  it('rejects a phone that is actually different', () => {
    assert.ok(!equivalent('(512) 555-0148', '5125550147', 'digits'));
  });

  it('accepts a salary the form decorated', () => {
    assert.ok(equivalent('$180,000', '180000', 'money'));
  });

  it('ignores case and surrounding space by default', () => {
    assert.ok(equivalent('  Austin, TX ', 'austin, tx', 'loose'));
  });

  it('holds an email to the character', () => {
    // Loose matching would let a trailing character through on the one field
    // where a near miss means the application is unreachable.
    assert.ok(!equivalent('test@example.com ', 'test@example.co', 'exact'));
    assert.ok(equivalent('test@example.com', 'test@example.com', 'exact'));
  });

  it('treats an empty read-back as a failed write', () => {
    assert.ok(!equivalent('', 'Austin', 'loose'));
  });
});

describe('comparatorFor', () => {
  it('picks the comparator from what the value is, not where it lands', () => {
    assert.equal(comparatorFor('phone'), 'digits');
    assert.equal(comparatorFor('salaryExpectation'), 'money');
    assert.equal(comparatorFor('firstName'), 'loose');
  });
});

const profile: Profile = {
  firstName: 'Test', middleName: '', lastName: 'Candidate', pronouns: '',
  email: 'test@example.com', phone: '5125550147', preferredContact: 'Email',
  address: {
    line1: '100 Congress Ave', line2: '', city: 'Austin',
    state: 'TX', postalCode: '78701', country: 'United States',
  },
  gender: '', ethnicity: '', veteranStatus: '', disabilityStatus: '',
  linkedin: 'https://linkedin.com/in/test', github: '', portfolio: '',
  currentTitle: 'Backend Engineer', yearsExperience: '8',
  workAuthorization: 'US Citizen', requiresSponsorship: 'no',
  salaryExpectation: '180000', noticePeriod: '2 weeks',
  availableStartDate: '2026-09-15', willingToRelocate: 'no', workPreference: 'Remote',
  referralSource: '', previouslyEmployed: 'no', isOver18: 'yes',
  hasRelativesAtCompany: 'no', relativesDetail: 'N/A', agreeToTerms: 'yes',
  screeningAnswers: [],
};

const ctx: FillContext = {
  profile,
  job: { jobKey: 'k', url: '', title: '', company: '', location: '', description: '', capturedAt: 0 },
  resumeText: 'resume text',
};

describe('resolveValue', () => {
  it('assembles the names a form asks for', () => {
    assert.equal(resolveValue('fullName', ctx), 'Test Candidate');
    assert.equal(resolveValue('firstName', ctx), 'Test');
  });

  it('gives a location picker a place, not a street', () => {
    // Country included on purpose: a location picker reworks 'Austin, TX, United
    // States' into its own canonical option, where a bare city often matches nothing.
    assert.equal(resolveValue('location', ctx), 'Austin, TX, United States');
    assert.match(resolveValue('fullAddress', ctx), /100 Congress Ave/);
  });

  it('turns a tri-state into the word a form expects', () => {
    assert.equal(resolveValue('requiresSponsorship', ctx), 'No');
    assert.equal(resolveValue('isOver18', ctx), 'Yes');
  });

  it('leaves unset as empty rather than guessing', () => {
    // Unset is not "no". A blank left blank is a question a reviewer answers;
    // a blank written over a form's default is a wrong answer nobody notices.
    assert.equal(resolveValue('gender', ctx), '');
    assert.equal(resolveValue('veteranStatus', ctx), '');
  });
});

describe('formatDateFor', () => {
  const iso = '2026-09-05';

  it('follows the order the box asks for', () => {
    // The failure this prevents is silent: ISO typed into a DD/MM box is not
    // rejected, it is accepted as the fifth of September or the ninth of May
    // depending on which way round the form reads it.
    assert.equal(formatDateFor('MM/DD/YYYY', iso), '09/05/2026');
    assert.equal(formatDateFor('DD/MM/YYYY', iso), '05/09/2026');
    assert.equal(formatDateFor('YYYY-MM-DD', iso), '2026-09-05');
  });

  it('keeps the separator the box uses', () => {
    assert.equal(formatDateFor('DD.MM.YYYY', iso), '05.09.2026');
    assert.equal(formatDateFor('DD-MM-YYYY', iso), '05-09-2026');
  });

  it('handles the spelled-out month forms', () => {
    assert.equal(formatDateFor('DD-MMM-YYYY', iso), '05-Sep-2026');
    assert.equal(formatDateFor('MMM D, YYYY', iso), 'Sep 5, 2026');
  });

  it('declines rather than guesses when the box says nothing useful', () => {
    // Writing something unreadable into a date field is worse than leaving it
    // for a person: the application goes out with a date nobody chose.
    assert.equal(formatDateFor('', iso), null);
    assert.equal(formatDateFor('enter your start date', iso), null);
  });

  it('declines a value that is not a date', () => {
    assert.equal(formatDateFor('MM/DD/YYYY', 'next Tuesday'), null);
    assert.equal(formatDateFor('MM/DD/YYYY', ''), null);
  });
});
