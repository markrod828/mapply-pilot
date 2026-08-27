import { truncate } from './atsScore';
import { chatJson } from './openai';
import { parseStructured, type RawTailored } from './tailor';
import type { StructuredResume } from './types';

/**
 * Transcription, not rewriting. Everything the tailor prompts are allowed to do —
 * reword, trim, position for a job — is forbidden here, because this output is the
 * record of what the candidate actually wrote.
 */
const PARSE_PROMPT = `Extract this resume into structured fields. Transcribe only: never invent,
summarise away, reorder or improve anything. Copy employers, titles, locations, dates, degrees
and certifications exactly as written.

- experience: every paid role, most recent first, with its original bullets (drop leading bullet
  markers, keep the wording). location is the city/state the role was based in, or "".
  Split the date range into halves in the resume's own wording: "June 2022 - Present" gives
  startDate "June 2022" and endDate "Present". A role still held ends with "Present".
- projects: personal or academic projects only, never employment. tech is the stack line the
  resume shows for it, or "".
- education: one entry per school. Most resumes show only a completion year: put it in endDate
  and leave startDate "". details holds coursework or honours lines, or [].
- skillGroups: reuse the resume's own category names where it groups skills; otherwise group them
  sensibly. Never add a skill the resume does not list.
- certifications: one credential per string.
- sections: anything that belongs to none of the above — awards, publications, volunteering,
  target roles, additional strengths — each with its own heading and its lines. [] if nothing.
- headline: a title or positioning line under the name, or "" when the resume has none.
- Any field the resume does not show: "" or [].

Respond ONLY with JSON:
{
  "headline": string,
  "summary": string,
  "skillGroups": [{ "category": string, "items": string[] }],
  "experience": [{ "title": string, "company": string, "location": string, "startDate": string, "endDate": string, "bullets": string[] }],
  "projects": [{ "name": string, "tech": string, "bullets": string[] }],
  "education": [{ "school": string, "location": string, "degree": string, "startDate": string, "endDate": string, "details": string[] }],
  "certifications": string[],
  "sections": [{ "heading": string, "bullets": string[] }]
}`;

/**
 * Parses a resume's raw text into fields.
 *
 * Returns null rather than throwing on any failure — a bad key, a rate limit, a model
 * that returns nothing usable. Every caller keeps the raw text as its fallback, so a
 * null here costs one wasted round-trip and changes nothing else.
 */
export async function parseResumeDocument(request: {
  apiKey: string;
  model: string;
  resumeText: string;
}): Promise<StructuredResume | null> {
  if (!request.apiKey || !request.resumeText.trim()) return null;

  try {
    const raw = await chatJson<RawTailored>({
      apiKey: request.apiKey,
      model: request.model,
      system: PARSE_PROMPT,
      user: truncate(request.resumeText, 16000),
      temperature: 0,
      maxTokens: 4000,
    });

    const parsed = parseStructured(raw);
    // A parse that found no history is worse than no parse: it would silently lock the
    // tailor to an empty skeleton. Fall back to the text path instead.
    return parsed.experience.length > 0 || parsed.education.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}
