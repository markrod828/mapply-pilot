/**
 * Schema history.
 *
 * Each entry is applied once, in order, inside a transaction, and the file's
 * index is recorded in SQLite's own `user_version`. Migrations are append-only:
 * edit one that has shipped and databases in the wild silently disagree with the
 * code that reads them.
 */
export const MIGRATIONS: readonly string[] = [
  // 1 - the Phase 1 shape: a job, an application, and everything needed to
  // decide whether the application may submit itself.
  `
  CREATE TABLE jobs (
    id            INTEGER PRIMARY KEY,
    source        TEXT    NOT NULL,          -- jobright | url
    source_id     TEXT    NOT NULL,
    -- Soft dedupe across re-listings: sha1(company_key|title_key|location).
    job_hash      TEXT    NOT NULL,
    url           TEXT    NOT NULL,
    -- Where Apply actually led, resolved at fill time.
    apply_url     TEXT,
    ats_kind      TEXT,
    company       TEXT    NOT NULL,
    company_key   TEXT    NOT NULL,
    title         TEXT    NOT NULL,
    title_key     TEXT    NOT NULL,
    location      TEXT,
    remote        INTEGER,
    description   TEXT,
    posted_at     INTEGER,
    discovered_at INTEGER NOT NULL,
    closed_at     INTEGER,
    ats_score     INTEGER,
    ats_score_json TEXT,
    scored_at     INTEGER
  );
  CREATE UNIQUE INDEX idx_jobs_source ON jobs(source, source_id);
  CREATE INDEX idx_jobs_hash ON jobs(job_hash);

  CREATE TABLE form_templates (
    fingerprint    TEXT    PRIMARY KEY,
    ats_kind       TEXT,
    origin         TEXT,
    field_count    INTEGER NOT NULL,
    plan_json      TEXT    NOT NULL,
    -- Flipped on only after clean_runs consecutive clean dry runs, and reset
    -- to 0 by any park or failure. This is what stops an ATS redesign from
    -- silently submitting garbage.
    auto_submit_ok INTEGER NOT NULL DEFAULT 0,
    clean_runs     INTEGER NOT NULL DEFAULT 0,
    hits           INTEGER NOT NULL DEFAULT 0,
    fails          INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    last_used_at   INTEGER
  );

  CREATE TABLE applications (
    id                 INTEGER PRIMARY KEY,
    -- One application per job, ever. The first and cheapest duplicate guard.
    job_id             INTEGER NOT NULL UNIQUE REFERENCES jobs(id),
    state              TEXT    NOT NULL,
    reason             TEXT,
    reason_detail      TEXT,
    priority           INTEGER NOT NULL DEFAULT 0,
    attempt_count      INTEGER NOT NULL DEFAULT 0,
    max_attempts       INTEGER NOT NULL DEFAULT 3,
    next_attempt_at    INTEGER,
    lease_owner        TEXT,
    lease_expires_at   INTEGER,
    form_fingerprint   TEXT REFERENCES form_templates(fingerprint),
    tailor_tier        TEXT,
    resume_path        TEXT,
    cover_letter_path  TEXT,
    tailored_json      TEXT,
    -- The resolved field plan that was executed, and what was actually written.
    plan_json          TEXT,
    filled_json        TEXT,
    dry_run            INTEGER NOT NULL DEFAULT 1,
    -- Written BEFORE the submit click. A row with this set is never retried
    -- automatically: double-submitting is worse than not applying.
    submit_attempted_at INTEGER,
    submitted_at       INTEGER,
    confirmation_kind  TEXT,
    confirmation_text  TEXT,
    submit_http_status INTEGER,
    screenshot_path    TEXT,
    llm_cost_usd       REAL    NOT NULL DEFAULT 0,
    duration_ms        INTEGER,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
  );
  CREATE INDEX idx_app_claim  ON applications(state, next_attempt_at, priority DESC);
  CREATE INDEX idx_app_review ON applications(state, updated_at) WHERE state = 'needs_review';

  CREATE TABLE answers (
    id            INTEGER PRIMARY KEY,
    question_key  TEXT    NOT NULL,
    -- 'global', 'ats:greenhouse' or 'company:<key>'. Lets a company-specific
    -- answer coexist with a general one for the same question.
    scope         TEXT    NOT NULL DEFAULT 'global',
    question_text TEXT    NOT NULL,
    control       TEXT    NOT NULL,
    value_key     TEXT,
    answer_text   TEXT,
    answer_json   TEXT,
    source        TEXT    NOT NULL,
    confidence    REAL    NOT NULL DEFAULT 1.0,
    approved      INTEGER NOT NULL DEFAULT 0,
    times_used    INTEGER NOT NULL DEFAULT 0,
    last_used_at  INTEGER,
    created_at    INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX idx_answers_key ON answers(question_key, scope);

  CREATE TABLE application_events (
    id             INTEGER PRIMARY KEY,
    application_id INTEGER NOT NULL REFERENCES applications(id),
    at             INTEGER NOT NULL,
    from_state     TEXT,
    to_state       TEXT,
    kind           TEXT    NOT NULL,
    detail_json    TEXT
  );
  CREATE INDEX idx_events_app ON application_events(application_id, at);

  CREATE TABLE llm_calls (
    id                INTEGER PRIMARY KEY,
    application_id    INTEGER REFERENCES applications(id),
    job_id            INTEGER REFERENCES jobs(id),
    purpose           TEXT    NOT NULL,
    model             TEXT    NOT NULL,
    prompt_tokens     INTEGER,
    completion_tokens INTEGER,
    cost_usd          REAL,
    latency_ms        INTEGER,
    ok                INTEGER NOT NULL,
    error             TEXT,
    at                INTEGER NOT NULL
  );
  CREATE INDEX idx_llm_at ON llm_calls(at);

  CREATE TABLE sessions (
    id               INTEGER PRIMARY KEY,
    platform         TEXT    NOT NULL UNIQUE,
    profile_dir      TEXT    NOT NULL,
    logged_in        INTEGER NOT NULL DEFAULT 0,
    last_verified_at INTEGER,
    daily_cap        INTEGER NOT NULL DEFAULT 40,
    used_today       INTEGER NOT NULL DEFAULT 0,
    cap_reset_at     INTEGER,
    cooldown_until   INTEGER
  );

  CREATE TABLE domain_limits (
    domain               TEXT    PRIMARY KEY,
    min_interval_ms      INTEGER NOT NULL,
    max_concurrent       INTEGER NOT NULL DEFAULT 2,
    last_request_at      INTEGER,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    circuit_open_until   INTEGER
  );

  -- The profile and resume the filler draws on. Single row, id = 1: this is one
  -- person's job search, and pretending otherwise would cost a join on every fill.
  CREATE TABLE identity (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    profile_json TEXT    NOT NULL,
    resume_json  TEXT,
    resume_path  TEXT,
    updated_at   INTEGER NOT NULL
  );
  `,
];
