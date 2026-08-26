import { truncate } from './atsScore';
import { chatJson } from './openai';
import type { JobPosting, Profile } from './types';

const SYSTEM_PROMPT = `You are helping a candidate fill in the screening questions on a job
application. You are given the job, the candidate's resume, and the questions the form is asking.

Answer as the candidate, in the first person.

Hard rules:
- Use ONLY what the resume and profile actually say. Never invent employers, job titles, dates,
  degrees, certifications, metrics, tools or years of experience.
- If the resume and profile give you no basis for an answer, return an empty string for that
  question. An unanswered question the candidate can fill in themselves is far better than a
  confident false claim on a job application.
- When a question lists options, return exactly one of those options, copied verbatim. If none of
  them is supportable, return an empty string.
- For yes/no questions, answer from evidence: count real years from the dates on the resume, and
  read work authorization and location from the profile. Do not guess.
- Never answer questions about gender, race, ethnicity, veteran status, disability, age or any
  other protected characteristic. Return an empty string for those.

Length is set by the field, not by how much you have to say:
- "text" is a single-line box. Answer in one short phrase or sentence, under 200 characters — even
  when the question invites detail ("briefly describe your experience with X, including years").
  A paragraph typed into a one-line input is unreadable to whoever opens the application.
- "textarea" is a multi-line box: 2-5 sentences unless the question clearly asks for more.
- "choice": exactly one of the given options, copied verbatim.
- Never exceed maxCharacters when it is given.

Style for free-text answers:
- Specific and concrete.
- Lead with the directly relevant experience, name the real technologies from the resume, and give
  a truthful result where the resume provides one.
- Plain professional prose in the first person. No markdown, no headings, no bullet points unless
  the question asks for a list.
- Do not open with "I am writing to" or other filler. Answer the question that was asked.
- Do not repeat the whole resume; answer this question.

Respond ONLY with JSON of the shape:
{ "answers": [{ "id": number, "answer": string }] }
Every question id you were given must appear exactly once. Use "" for anything you cannot support.`;

export interface FormQuestion {
  id: number;
  label: string;
  /** "text" for one-liners, "textarea" for essays, "choice" when options are listed. */
  kind: 'text' | 'textarea' | 'choice';
  options?: string[];
  maxLength?: number;
}

export interface QuestionAnswer {
  id: number;
  answer: string;
}

export interface AnswerRequest {
  apiKey: string;
  model: string;
  job: JobPosting;
  profile: Profile;
  resumeText: string;
  questions: FormQuestion[];
}

export async function answerFormQuestions(request: AnswerRequest): Promise<QuestionAnswer[]> {
  if (!request.questions.length) return [];

  const user = [
    `JOB TITLE: ${request.job.title || 'Unknown'}`,
    `COMPANY: ${request.job.company || 'Unknown'}`,
    `LOCATION: ${request.job.location || 'Unknown'}`,
    '',
    'JOB DESCRIPTION:',
    truncate(request.job.description, 8000),
    '',
    'CANDIDATE PROFILE:',
    describeProfile(request.profile),
    '',
    'CANDIDATE RESUME:',
    truncate(request.resumeText, 10000),
    '',
    'QUESTIONS:',
    JSON.stringify(
      request.questions.map((question) => ({
        id: question.id,
        question: question.label,
        type: question.kind,
        ...(question.options?.length ? { options: question.options } : {}),
        ...(question.maxLength ? { maxCharacters: question.maxLength } : {}),
      })),
      null,
      2,
    ),
  ].join('\n');

  const raw = await chatJson<{ answers?: unknown }>({
    apiKey: request.apiKey,
    model: request.model,
    system: SYSTEM_PROMPT,
    user,
    temperature: 0.3,
    maxTokens: 2500,
    truncationHint: 'Try autofilling again, or answer the longest questions yourself.',
  });

  return readAnswers(raw.answers, request.questions);
}

function describeProfile(profile: Profile): string {
  const lines = [
    profile.currentTitle && `Current title: ${profile.currentTitle}`,
    profile.yearsExperience && `Years of experience: ${profile.yearsExperience}`,
    [profile.city, profile.state, profile.country].filter(Boolean).join(', ') &&
      `Location: ${[profile.city, profile.state, profile.country].filter(Boolean).join(', ')}`,
    profile.workAuthorization && `Work authorization: ${profile.workAuthorization}`,
    profile.requiresSponsorship && `Requires visa sponsorship: ${profile.requiresSponsorship}`,
    profile.salaryExpectation && `Salary expectation: ${profile.salaryExpectation}`,
    profile.noticePeriod && `Notice period: ${profile.noticePeriod}`,
  ].filter(Boolean);

  // Previously saved answers are the candidate's own words; reuse their substance.
  for (const saved of profile.screeningAnswers) {
    if (saved.question.trim() && saved.answer.trim()) {
      lines.push(`Previously answered "${saved.question.trim()}": ${saved.answer.trim()}`);
    }
  }

  return lines.length ? lines.join('\n') : 'No profile details provided.';
}

function readAnswers(value: unknown, questions: FormQuestion[]): QuestionAnswer[] {
  if (!Array.isArray(value)) return [];

  const byId = new Map(questions.map((question) => [question.id, question]));
  const answers: QuestionAnswer[] = [];
  const seen = new Set<number>();

  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as { id?: unknown; answer?: unknown };
    const id = typeof entry.id === 'number' ? entry.id : Number(entry.id);
    if (!Number.isInteger(id) || seen.has(id)) continue;

    const question = byId.get(id);
    if (!question) continue;

    const answer = typeof entry.answer === 'string' ? entry.answer.trim() : '';
    if (!answer) continue;

    // A choice has to be one of the offered options, whatever the model returned.
    if (question.kind === 'choice' && question.options?.length) {
      const match = question.options.find(
        (option) => option.trim().toLowerCase() === answer.toLowerCase(),
      );
      if (!match) continue;
      seen.add(id);
      answers.push({ id, answer: match });
      continue;
    }

    seen.add(id);
    answers.push({ id, answer: question.maxLength ? answer.slice(0, question.maxLength) : answer });
  }

  return answers;
}
