import type { LlmPort } from './ports';
import { truncate } from './atsScore';
import type { ChatTurn, JobPosting, Profile } from './types';

export type { ChatTurn };

/**
 * How much of the conversation is sent back with each question.
 *
 * Enough to follow a thread of two or three follow-ups, which is what these
 * conversations actually are, without the cost of a long history growing on
 * every turn.
 */
export const HISTORY_TURNS = 12;

const SYSTEM_PROMPT = `You are helping someone decide whether to apply for a specific job, and
how to present themselves if they do. You have the job posting and their resume.

Ground every answer in those two documents.

- When the posting states something, say so and quote or paraphrase the wording.
- When the posting does NOT say, say plainly that it does not say. Do not infer
  a salary band, a visa policy, a remote policy, a team size or an interview
  process from what is typical. The person is deciding based on your answer, and
  "the posting doesn't mention it" is a useful answer where a plausible guess is
  a harmful one.
- When asked how they match, compare against their actual resume. Name the real
  gaps. Someone who hears only encouragement cannot judge whether to spend an
  hour on this application.
- Never invent experience, employers, dates or numbers on their behalf. If they
  ask you to draft something that would claim experience the resume does not
  show, write the draft without that claim and say what you left out.

Be brief and specific. Two or three short paragraphs at most, or a short list.
No preamble, no restating the question, no closing offers of further help.`;

export interface JobChatRequest {
  llm: LlmPort;
  model: string;
  job: JobPosting;
  resumeText: string;
  profile?: Profile;
  /** Earlier turns, oldest first. Trimmed to the most recent few. */
  history: ChatTurn[];
  question: string;
}

/**
 * Answers a question about one posting.
 *
 * The whole conversation is re-sent each time rather than kept on a server: the
 * extension holds no session, and a posting's chat has to survive the side panel
 * being closed, which local history does for free.
 */
export async function askAboutJob(request: JobChatRequest): Promise<string> {
  const question = request.question.trim();
  if (!question) throw new Error('Ask a question first.');

  const recent = request.history.slice(-HISTORY_TURNS);
  const conversation = recent
    .map((turn) => `${turn.role === 'you' ? 'CANDIDATE' : 'YOU'}: ${turn.text}`)
    .join('\n\n');

  const user = [
    `JOB TITLE: ${request.job.title || 'Unknown'}`,
    `COMPANY: ${request.job.company || 'Unknown'}`,
    `LOCATION: ${request.job.location || 'Not stated'}`,
    '',
    'JOB POSTING:',
    truncate(request.job.description, 12000),
    '',
    'THEIR RESUME:',
    truncate(request.resumeText, 8000),
    ...(request.profile ? ['', 'ALSO KNOWN:', describeProfile(request.profile)] : []),
    ...(conversation ? ['', 'CONVERSATION SO FAR:', conversation] : []),
    '',
    `CANDIDATE ASKS: ${question}`,
  ].join('\n');

  return request.llm.chatText({
    purpose: 'chat',
    model: request.model,
    system: SYSTEM_PROMPT,
    user,
    temperature: 0.3,
    maxTokens: 900,
    truncationHint: 'Ask a narrower question, or start a new conversation.',
  });
}

/**
 * The handful of profile facts a question about a job might turn on.
 *
 * Not the whole profile: the voluntary self-identification answers have no
 * bearing on whether a job is worth applying for, and there is no reason to send
 * them anywhere.
 */
function describeProfile(profile: Profile): string {
  return [
    profile.currentTitle && `Current title: ${profile.currentTitle}`,
    profile.yearsExperience && `Years of experience: ${profile.yearsExperience}`,
    profile.workAuthorization && `Work authorization: ${profile.workAuthorization}`,
    profile.requiresSponsorship && `Needs visa sponsorship: ${profile.requiresSponsorship}`,
    profile.nationality && `Nationality: ${profile.nationality}`,
    profile.workPreference && `Prefers: ${profile.workPreference}`,
    profile.willingToRelocate && `Willing to relocate: ${profile.willingToRelocate}`,
    profile.salaryExpectation && `Salary expectation: ${profile.salaryExpectation}`,
    profile.noticePeriod && `Notice period: ${profile.noticePeriod}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Questions worth offering before somebody has thought of their own. */
export const STARTER_QUESTIONS: readonly string[] = [
  'What are the hard requirements, and do I meet them?',
  'What does this posting not tell me that I should ask about?',
  'Where is my resume weakest against this role?',
  'What should I emphasise if I apply?',
];
