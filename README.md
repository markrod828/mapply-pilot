# mapply

Applies to jobs, unattended, from a jobright feed.

It reads a posting, scores your resume against it, rewrites the resume for the
job when that is worth doing, fills the employer's application form, and submits
it — stopping and asking only when it meets a question it cannot honestly answer.

Everything runs on your own machine, in your own copy of Chrome. Nothing about
your profile leaves it except the application itself.

---

## What it does, in order

```
jobright  →  score  →  tailor  →  fill  →  verify  →  submit  →  confirm
                ↓                    ↓                              ↓
             skipped            needs_review                    submitted
```

An application only reaches `submitted` when at least **two independent signals**
agree that the form actually arrived. Anything uncertain is parked for you rather
than guessed at, and everything it could not fill is recorded on the application
so nothing goes out silently incomplete.

## Getting started

```bash
npm install
npx playwright install chromium      # optional: your installed Chrome is used first
```

**1. Give it your details.** In the Chrome extension, *Settings → Export for
orchestrator*, then:

```bash
npx tsx apps/orchestrator/src/cli.ts import ~/Downloads/mapply-identity-*.json
npx tsx apps/orchestrator/src/cli.ts whoami
```

**2. Turn on scoring and tailoring** (optional — without a key it sends your base
resume unchanged):

```bash
export OPENAI_API_KEY=sk-...
```

**3. Sign in to jobright once**, in the browser profile the crawler uses. The
crawl will tell you if the session has lapsed; it never attempts a login itself.

**4. Fill the queue and work it.**

```bash
npx tsx apps/orchestrator/src/cli.ts crawl --limit 25
npx tsx apps/orchestrator/src/cli.ts run --limit 10        # dry run
npx tsx apps/orchestrator/src/cli.ts run --limit 10 --submit
```

**5. Clear what stopped.**

```bash
npx tsx apps/orchestrator/src/cli.ts dashboard             # http://127.0.0.1:4600
```

## Commands

| | |
|---|---|
| `import <file>` | Load the profile and resume exported from the extension |
| `whoami` | Show what it knows about you |
| `crawl [--limit N]` | Read new jobs from jobright into the queue |
| `run [--limit N] [--submit] [--budget $]` | Work the queue. Dry run unless `--submit` |
| `apply --url <url> [--submit]` | Apply to one posting directly |
| `questions` | What stopped applications, commonest first |
| `answer "<question>" "<answer>"` | Teach it one, reused everywhere after |
| `bank` | What it has been taught |
| `status` · `recover` · `dashboard` | Recent applications · re-queue abandoned work · review UI |

## The answer bank

This is what makes it unattended. The first time a form asks something it cannot
work out from your profile, it stops and records the question. You answer once —
in the dashboard or with `mapply answer` — and every later form asking the same
thing is filled without you.

It never invents an answer. In particular, any answer containing a **number about
you** — years with a technology, salary, notice period — must come from your
profile or from an answer you approved. An application is a document you are
signing; a plausible guess on one is not a small thing.

## Safety

The parts that exist because getting them wrong is expensive:

- **Dry run is the default.** `--submit` has to be asked for.
- **A form must earn the right to submit itself.** Each form's shape gets a
  fingerprint, and it may only auto-submit after three consecutive clean runs;
  one park or failure spends that entirely. When an ATS changes its markup the
  fingerprint changes with it, so the worst case is applications queueing for
  review rather than going out wrong.
- **Nothing is trusted after it is written.** Every field is read back, and the
  whole form is re-read once more before submitting — because uploading a resume
  makes some ATSs re-render and quietly empty fields that were correct a moment
  earlier.
- **Two signals to confirm.** A URL change, a "thank you", a 2xx/3xx on the POST,
  the form disappearing — any one of them lies on its own.
- **`submit_attempted_at` is written before the click.** If the process dies
  mid-submit, recovery parks it for a person instead of trying again. Applying
  twice reads as spam.
- **One application per job, ever**, plus a content hash that recognises the same
  role relisted under a new id.
- **Waived, not ignored.** When a form says a field is optional in practice — as
  Greenhouse does when its location service is down — that is recorded on the
  application, not skipped silently.
- **Hosts are paced, and left alone when they object.** Requests to one host are
  spaced with jitter; five failures running puts it in cooldown rather than
  working the whole queue against a host that is refusing.
- **A CAPTCHA or a login wall is parked, not failed.** No machine gets past
  those, but the person sitting at this browser clears one in seconds — and a
  failed application is written off where a parked one is waiting for help.

## Layout

```
packages/core         Resume tailoring, ATS scoring, screening answers. No platform APIs.
packages/db           SQLite: jobs, applications, the answer bank, form templates.
packages/filler       The form engine: find fields, resolve values, write, verify.
packages/discovery    The jobright crawl and apply-link resolution.
apps/orchestrator     The runner and CLI.
apps/dashboard        The review queue.
extension/            The original Chrome extension, kept for applying by hand.
```

`packages/core` compiles with no DOM or Chrome types on purpose — it is shared by
the extension, the runner and the dashboard, and a platform call there would
break one of them.

## Tests

```bash
npm test --workspaces
```

The form engine is tested against saved fixtures in `packages/filler/test/fixtures`:
an ordinary form, one embedded in an iframe, one with an unanswerable required
question, and one built from the widgets that usually defeat a filler — a radio
whose real input hides behind its label, a consent checkbox, and inputs inside
open and closed shadow roots. A change that breaks label attribution, the
parking rules or the trust gate fails locally rather than on a real application.

## What it does not do

- **Sign in anywhere.** jobright is signed into by hand, once.
- **Solve CAPTCHAs.** They park for you.
- **Handle every ATS.** Greenhouse is templated; others fall back to the generic
  engine and park more often. `mapply status` shows what came back
  `unsupported_ats` — that is the list of what to template next.
- **Read a calendar widget.** Native date inputs and masked text boxes are
  handled, including matching the order the box asks for; a pop-up calendar
  parks. Writing a date in the wrong order is not rejected, it is accepted as
  the wrong day, so it declines rather than guesses.
- **Answer for you.** It fills what it can prove; the rest is yours.
