import type { Generated } from 'kysely';

/**
 * The database as Kysely sees it.
 *
 * SQLite has no boolean and no date: flags are 0/1 integers and every timestamp
 * is epoch milliseconds. That is spelled out here rather than hidden behind a
 * codec, so a query reads the way the stored bytes actually are.
 */
export interface Database {
  jobs: JobsTable;
  applications: ApplicationsTable;
  form_templates: FormTemplatesTable;
  answers: AnswersTable;
  application_events: ApplicationEventsTable;
  llm_calls: LlmCallsTable;
  sessions: SessionsTable;
  domain_limits: DomainLimitsTable;
  identity: IdentityTable;
}

export interface JobsTable {
  id: Generated<number>;
  source: string;
  source_id: string;
  job_hash: string;
  url: string;
  apply_url: string | null;
  ats_kind: string | null;
  company: string;
  company_key: string;
  title: string;
  title_key: string;
  location: string | null;
  remote: number | null;
  description: string | null;
  posted_at: number | null;
  discovered_at: number;
  closed_at: number | null;
  ats_score: number | null;
  ats_score_json: string | null;
  scored_at: number | null;
}

export interface ApplicationsTable {
  id: Generated<number>;
  job_id: number;
  state: string;
  reason: string | null;
  reason_detail: string | null;
  priority: Generated<number>;
  attempt_count: Generated<number>;
  max_attempts: Generated<number>;
  next_attempt_at: number | null;
  lease_owner: string | null;
  lease_expires_at: number | null;
  form_fingerprint: string | null;
  tailor_tier: string | null;
  resume_path: string | null;
  cover_letter_path: string | null;
  tailored_json: string | null;
  plan_json: string | null;
  filled_json: string | null;
  dry_run: Generated<number>;
  submit_attempted_at: number | null;
  submitted_at: number | null;
  confirmation_kind: string | null;
  confirmation_text: string | null;
  submit_http_status: number | null;
  screenshot_path: string | null;
  llm_cost_usd: Generated<number>;
  duration_ms: number | null;
  created_at: number;
  updated_at: number;
}

export interface FormTemplatesTable {
  fingerprint: string;
  ats_kind: string | null;
  origin: string | null;
  field_count: number;
  plan_json: string;
  auto_submit_ok: Generated<number>;
  clean_runs: Generated<number>;
  hits: Generated<number>;
  fails: Generated<number>;
  created_at: number;
  last_used_at: number | null;
}

export interface AnswersTable {
  id: Generated<number>;
  question_key: string;
  scope: Generated<string>;
  question_text: string;
  control: string;
  value_key: string | null;
  answer_text: string | null;
  answer_json: string | null;
  source: string;
  confidence: Generated<number>;
  approved: Generated<number>;
  times_used: Generated<number>;
  last_used_at: number | null;
  created_at: number;
}

export interface ApplicationEventsTable {
  id: Generated<number>;
  application_id: number;
  at: number;
  from_state: string | null;
  to_state: string | null;
  kind: string;
  detail_json: string | null;
}

export interface LlmCallsTable {
  id: Generated<number>;
  application_id: number | null;
  job_id: number | null;
  purpose: string;
  model: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_usd: number | null;
  latency_ms: number | null;
  ok: number;
  error: string | null;
  at: number;
}

export interface SessionsTable {
  id: Generated<number>;
  platform: string;
  profile_dir: string;
  logged_in: Generated<number>;
  last_verified_at: number | null;
  daily_cap: Generated<number>;
  used_today: Generated<number>;
  cap_reset_at: number | null;
  cooldown_until: number | null;
}

export interface DomainLimitsTable {
  domain: string;
  min_interval_ms: number;
  max_concurrent: Generated<number>;
  last_request_at: number | null;
  consecutive_failures: Generated<number>;
  circuit_open_until: number | null;
}

export interface IdentityTable {
  id: number;
  profile_json: string;
  resume_json: string | null;
  resume_path: string | null;
  updated_at: number;
}
