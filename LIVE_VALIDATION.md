# Live validation — Syncore AI Receptionist

Runbook and record for validating the system against **real services** (a Supabase project and the OpenAI API), as
required by Phase 1.5 in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). Runtime behaviour referenced here is
specified in [AI_RUNTIME.md](AI_RUNTIME.md) and [ARCHITECTURE.md](ARCHITECTURE.md); setup basics are in
[README.md](README.md).

Tooling:

| Command | Script | Talks to |
| --- | --- | --- |
| `npm run db:migrate` | `scripts/migrate.ts` | Postgres at `DATABASE_URL` |
| `npm run validate:live` | `scripts/validate-live.ts` | Postgres at `DATABASE_URL` + Supabase Auth. No AI provider calls. |
| `npm run eval:live` | `scripts/eval-live.ts` | The real configured AI providers (OpenAI). Uses an in-memory PGlite database, never `DATABASE_URL`. |
| Manual end-to-end check | the app (`npm run build` + `npm start`, or a deployed preview) | Everything: Supabase Auth + Postgres + OpenAI + a browser |

---

## 1. Status

**As of 2026-11-26: NOT RUN.** No Supabase or OpenAI credentials were available in the build environment. **Nothing
in this document is a live result.** The "Recorded runs" section (§7) is empty.

Offline verification performed in the build environment (no network services, no credentials):

| Check | Command | What it covers | What it does NOT cover |
| --- | --- | --- | --- |
| Typecheck | `npm run typecheck` | Strict TypeScript across app, scripts and tests | — |
| Lint | `npm run lint` | ESLint, zero warnings | — |
| Automated suite | `npm test` | Unit, integration and acceptance tests against **PGlite** (Postgres compiled to WebAssembly, with pgvector) using the real migrations and RLS policies, with **fake** text/embedding providers and injected provider failures | Real model behaviour, real Supabase, real network |
| Production build | `npm run build` | The app compiles without runtime secrets | Runtime configuration |
| validate:live database checks | `tests/integration/live-validation.test.ts` | The script's database checks run against PGlite, with two pre-created users (`auth: null`, so the two Supabase Auth checks are **not** exercised) and a `localhost` URL (so "verified TLS" passes only through the local-host rule); cleanup is asserted | **Not evidence about Supabase, Postgres 17, the Supavisor pooler, TLS or Supabase Auth** |

CI (`.github/workflows/ci.yml`) repeats the offline checks (`npm ci`, typecheck, lint, tests, build; Node 24; no
secrets). Live validation is manual by design.

Phase 1.5's live-validation acceptance stays open until a run is recorded in §7 in which every item of the
verification matrix (§4) is PASS, or any exception is written down with its reason and follow-up.

---

## 2. Prerequisites

### 2.1 Local tools

| Tool | Requirement |
| --- | --- |
| Node.js | ≥ 22.12 (`package.json` engines); 24 LTS recommended (CI uses 24) |
| npm, git | Any current version |
| curl | For the header checks. In Windows PowerShell use `curl.exe` (`curl` is an alias of `Invoke-WebRequest` there). |
| Browser | For sign-up, the admin UI and the widget test page; a private window for the second tenant |
| Static file server | For the widget test page, e.g. `python3 -m http.server 8080` (any server works) |
| SQL access | The Supabase SQL editor (runs as `postgres`, so it can read `app_private` tables), or `psql` |

Shell note: the commands below are POSIX shell (Git Bash works on Windows). In Windows PowerShell 5.1, `&&` is not
available and the `--` in `npm run <script> -- <args>` may not be passed through to the script; if it is not, call
the script directly, e.g. `npx tsx --conditions=react-server scripts/migrate.ts --dry-run` (that is exactly what the
npm script runs).

### 2.2 Supabase project (disposable)

Use a **new project created only for this validation**. Do not use a project that holds real data (§6).

| Item | Where | Setting / action |
| --- | --- | --- |
| Postgres version | Project creation | Postgres 17 is the current default. Record the version that `validate:live` prints. |
| pgvector | SQL editor | Confirm availability before migrating: `select name, default_version, installed_version from pg_available_extensions where name = 'vector';` The migrations create it with `create extension if not exists vector with schema extensions`. |
| CA certificate | Database settings → SSL configuration | Download the CA certificate (`prod-ca-2021.crt`). Keep it outside the repository. It goes into `DATABASE_SSL_CA` (§3.2). |
| Enforce SSL | Database settings → SSL configuration | **Enable.** It covers the direct connection and the poolers. |
| Transaction pooler connection string (port **6543**) | Connect dialog | Used by the app and by `validate:live`. Session state does not survive between transactions here; the code relies only on transaction-local settings and transaction-scoped advisory locks. |
| Session pooler (port **5432**) or direct connection string | Connect dialog | Used by `db:migrate` (the script says: use a session-mode connection). The direct connection is IPv6-only unless the IPv4 add-on is enabled; the poolers are reachable over IPv4. |
| Database password | Project creation / Database settings | URL-encode special characters inside `DATABASE_URL`. |
| Email sign-in | Authentication → Sign In / Providers → Email | Enabled with password sign-in (`validate:live` signs in with `signInWithPassword`). |
| Email confirmations | Same page | **"Confirm email" on**: the manual check signs up through a real confirmation email. The built-in email sender is meant for testing and is rate-limited; if emails do not arrive, check Authentication → Logs or configure SMTP. |
| Redirect URLs | Authentication → URL Configuration | Add `<app-origin>/auth/confirm` for every origin you test, e.g. `http://localhost:3000/auth/confirm` and `https://<preview-host>/auth/confirm`. Keep the default "Confirm signup" template (`{{ .ConfirmationURL }}`): `/auth/confirm` accepts only PKCE `?code=` links (README "Security and deployment notes"). The app sends `emailRedirectTo=<app-origin>/auth/confirm?next=…`; if the confirmation link opens the Site URL instead of `/auth/confirm`, Supabase did not accept the redirect: add a wildcard entry such as `<app-origin>/auth/confirm**`. |
| Publishable key | Project Settings → API Keys | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (public by design). |
| Secret key | Project Settings → API Keys | `SUPABASE_SECRET_KEY`, used **only** by `validate:live` to create and delete its two throwaway users. Never put it in a deployed environment. If the project uses the new API keys, create a dedicated secret key for this run and delete it afterwards. |
| Data API (optional) | API settings | The app never uses PostgREST; removing `public` from the exposed schemas shrinks the attack surface (README). |

Record which JWT signing keys the project uses (asymmetric/JWKS or legacy HS256): `getClaims` verifies asymmetric
tokens locally and calls the Auth server for legacy HS256 tokens. Both paths satisfy the check.

### 2.3 OpenAI project

| Item | Action |
| --- | --- |
| Project | Create a dedicated OpenAI project for validation. |
| API key | Create a project API key → `OPENAI_API_KEY`. Server-side only. |
| Spend limit | **Set a project spend limit in the OpenAI dashboard before the first run.** When an OpenAI spend/quota limit is hit, the API returns HTTP 429 with a billing code (e.g. `project_spend_limit_exceeded`); the app classifies it as a quota failure: no retry, `ai.call.failed` at error level. |
| Model access | If the project restricts models, allow `gpt-6-luna`, `gpt-6.2-sol` and `text-embedding-3-small` (the `.env.example` defaults). |

### 2.4 Environment variables

All scripts load `.env.local`, then `.env`, and **never override a variable already set in the shell** (so a value
given on the command line wins). Next.js loads `.env.local` for `npm run build` / `npm start`.

| Variable | `db:migrate` | `validate:live` | `eval:live` | App (`npm start` / preview) | Notes |
| --- | :-: | :-: | :-: | :-: | --- |
| `DATABASE_URL` | ✔ (session 5432 or direct) | ✔ (transaction pooler 6543) | — | ✔ (6543) | `eval:live` never reads it. TLS parameters in the URL (`?sslmode=…`) are removed; configure TLS with the two variables below. |
| `DATABASE_SSL` | ✔ | ✔ | — | ✔ | `auto` (default): TLS for remote hosts, verified when `DATABASE_SSL_CA` is set. `verify` requires the CA. `require` = encrypted, unverified. |
| `DATABASE_SSL_CA` | ✔ | ✔ | — | ✔ | PEM of the Supabase CA. Required for the acceptance run. With `NODE_ENV=production` and a remote host it is mandatory (the app refuses to start without it). |
| `DATABASE_POOL_MAX` | parsed (one client) | ✔ | — | ✔ | Default 5, max 50. Record the value used for `validate:live`. |
| `NEXT_PUBLIC_SUPABASE_URL` | — | ✔ | — | ✔ | Without all three Supabase variables, `validate:live` reports the auth-dependent checks as SKIP. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | — | ✔ | — | ✔ | |
| `SUPABASE_SECRET_KEY` | — | ✔ | — | **never** | Script only. Remove from `.env.local` after the run. |
| `OPENAI_API_KEY` | — | — | ✔ | ✔ | `eval:live` exits 1 without it when a configured profile uses `openai`. |
| `AI_TEXT_*`, `AI_ESCALATION_*`, `AI_EMBEDDING_*` | — | — | ✔ | ✔ | Model names live only in configuration. Keep the `.env.example` defaults for the recorded run. `AI_EMBEDDING_DIMENSIONS` must be 1536. |
| `AI_MAX_*`, `AI_MIN_RETRIEVAL_SIMILARITY`, `AI_REQUEST_TIMEOUT_MS`, `AI_PROVIDER_MAX_RETRIES` | — | — | ✔ | ✔ | Budgets, caps and retries (defaults in `.env.example`). |
| `AI_ORG_DAILY_SPEND_LIMIT_USD`, `AI_ORG_MONTHLY_SPEND_LIMIT_USD` | — | — | ✔ | ✔ | Default organization limits (10 / 150 USD estimated); per-organization overrides in `app_private.organization_limits`. `validate:live` uses its own fixed test limits. |
| `AI_PRICING_VERSION`, `AI_MODEL_PRICING_JSON` | — | — | ✔ | ✔ | Label stored on every usage record (default `2026-11-26`) and optional price overrides. |
| `WIDGET_SESSION_SECRET`, `WIDGET_SESSION_TTL_HOURS`, `RATE_LIMIT_*` | — | — | — | ✔ | `eval:live` generates a throwaway session secret and uses default rate limits. |
| `LOG_LEVEL` | — | — | ✔ (default `warn` when unset) | ✔ | `.env.example` sets `info`, which makes `eval:live` print every info event as JSON lines. |
| `NODE_ENV` | ✔ | ✔ | — | ✔ | `production` + remote database without `DATABASE_SSL_CA` is a configuration error (cannot be bypassed by any flag). `npm start` runs in production mode. |
| `SEED_OWNER_EMAIL` | — | — | — | — | `db:seed` only; the seed script is not part of this procedure (the manual check exercises onboarding through the UI). |

---

## 3. Procedure

Run the steps in order. Copy the output of every step into the results record (§7).

### 3.1 Record the build and run the offline gate

```bash
git rev-parse HEAD          # commit SHA for the record
git status --short          # should be empty for a recorded run
node --version
npm ci                      # clean install from package-lock.json (as CI does)
npm run check               # typecheck + lint + test + build; must pass before any paid run
```

### 3.2 Configure `.env.local`

```bash
cp .env.example .env.local
```

Fill in (placeholders in angle brackets):

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable key>

# Transaction pooler: the app and validate:live. db:migrate overrides this on its command line (3.3).
DATABASE_URL=postgresql://postgres.<project-ref>:<password>@<pooler-host>:6543/postgres
DATABASE_SSL=auto
DATABASE_SSL_CA=<CA PEM on one line, see below>

OPENAI_API_KEY=<project API key>

WIDGET_SESSION_SECRET=<at least 32 random characters, see below>
LOG_LEVEL=info

# validate:live ONLY. Delete this line after the run. Never deploy it.
SUPABASE_SECRET_KEY=<secret key>
```

Leave the `AI_*` lines at their `.env.example` values for the recorded run.

`DATABASE_SSL_CA` takes the PEM text (not a file path). Literal `\n` sequences are accepted, so the certificate can
be stored on one line:

```bash
# POSIX shell: print the PEM as one line with literal \n separators
awk 'NF {sub(/\r$/, ""); printf "%s\\n", $0}' /path/outside/repo/prod-ca-2021.crt
```

```powershell
# PowerShell: same, copied to the clipboard ('\n' in single quotes is a literal backslash-n)
(Get-Content C:\path\outside\repo\prod-ca-2021.crt) -join '\n' | Set-Clipboard
```

Generate the widget secret:

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

### 3.3 Apply migrations (`npm run db:migrate`)

Migrations run with the most privileged credentials and need a session-mode connection, so override `DATABASE_URL`
with the **session pooler (5432) or direct** connection string for these commands only:

```bash
export MIGRATE_URL='postgresql://postgres.<project-ref>:<password>@<pooler-host>:5432/postgres'

DATABASE_URL="$MIGRATE_URL" npm run db:migrate -- --dry-run   # lists pending migrations, writes nothing
DATABASE_URL="$MIGRATE_URL" npm run db:migrate                # applies them
DATABASE_URL="$MIGRATE_URL" npm run db:migrate                # second run must be a no-op
```

```powershell
$env:DATABASE_URL = 'postgresql://postgres.<project-ref>:<password>@<pooler-host>:5432/postgres'
npx tsx --conditions=react-server scripts/migrate.ts --dry-run
npx tsx --conditions=react-server scripts/migrate.ts
npx tsx --conditions=react-server scripts/migrate.ts
Remove-Item Env:DATABASE_URL
```

Expected output on a fresh project (three migration files exist at the time of writing):

```text
Pending migrations (3):
  20261008000100_foundation
  20261008000200_web_chat_slice
  20261126000100_phase_1_5_hardening
```

then `  applied  <version>_<name>` per file and `Applied 3 migration(s).`, then on the re-run
`Database is up to date (3 migrations applied).`

What the script does and refuses:

| Situation | Behaviour | Exit code |
| --- | --- | --- |
| Remote host, `DATABASE_SSL_CA` not set (or `DATABASE_SSL=require`/`disable`) | Refuses: `Refusing to migrate a remote database without verified TLS. Set DATABASE_SSL_CA to the provider CA certificate (Supabase: Database settings → SSL configuration), or pass --allow-unverified-tls.` | 1 |
| Same, with `-- --allow-unverified-tls` | Connects with TLS but without certificate verification and warns `Warning: TLS without certificate verification (--allow-unverified-tls).` Only for a first look at a disposable project. **Not acceptable for the recorded run**, and `validate:live` will then FAIL `connection: verified TLS`. | 0 on success |
| `NODE_ENV=production`, remote host, no CA | Configuration error before connecting; no flag bypasses it | 1 |
| `DATABASE_SSL=verify` without `DATABASE_SSL_CA` | Configuration error `DATABASE_SSL=verify needs DATABASE_SSL_CA` | 1 |
| Missing/invalid `DATABASE_URL` | Error, `Set DATABASE_URL in .env.local (see .env.example).` | 1 |
| Unknown argument | Usage message | 2 |
| A migration fails | `Migration <version>_<name> failed: …`; that migration's transaction is rolled back (it leaves no trace); the run stops | 1 |

Each migration runs in its own transaction under a transaction-scoped advisory lock (`pg_advisory_xact_lock`), and is
recorded in `supabase_migrations.schema_migrations` (the Supabase CLI's history table) in the same transaction.

Optional negative check (evidence for the TLS hardening): comment out `DATABASE_SSL_CA` in `.env.local`, run the dry
run, confirm the refusal and exit code 1, then restore the line.

Confirm in the SQL editor:

```sql
select version, name from supabase_migrations.schema_migrations order by version;
select extversion from pg_extension where extname = 'vector';
```

### 3.4 Run `npm run validate:live`

Uses `DATABASE_URL` from `.env.local` (the **transaction pooler, 6543**), so the pooling and concurrency checks run
through Supavisor exactly as the serverless app would.

```bash
npm run validate:live
# Optional: more client-side parallelism for the concurrency checks (record the value)
DATABASE_POOL_MAX=10 npm run validate:live
```

The script refuses an unverified remote connection with
`Refusing to connect without verified TLS: set DATABASE_SSL_CA (or pass --allow-unverified-tls).` (exit 1).

A complete passing run prints the target and TLS mode, 12 `PASS` lines (§5.2) and:

```text
12 passed, 0 failed, 0 skipped
```

**Acceptance requires exit code 0 with `0 failed, 0 skipped`.** The script itself exits 0 when checks are skipped
(missing Supabase variables), so a run with SKIP lines does not satisfy §4.

Optional: repeat once with the session pooler URL (`DATABASE_URL="$MIGRATE_URL" npm run validate:live`) and record
both. The transaction-pooler run is the one that matters for pooling.

### 3.5 Run `npm run eval:live`

Runs the Phase 1 acceptance conversations against the **real configured models** on a throwaway in-memory database.

```bash
LOG_LEVEL=warn npm run eval:live     # readable transcript; use LOG_LEVEL=info to also see ai.call.completed / agent.turn.finished
```

The run prints the configured routes, sets up two demo tenants (knowledge embedded with the configured embedding
model), then runs seven scenarios (§5.3). A passing run ends with:

```text
25 check(s) passed, 0 failed. Estimated provider cost of this run: $<amount>.
```

Exit code 0 only when every check passes. Several checks are heuristics over model wording (§5.3): on a FAIL, read
the printed reply before drawing conclusions, record the failing run as it is, and if you re-run, record both runs.

### 3.6 Manual end-to-end check

This is the only step that combines real Supabase Auth, the Supavisor pooler, real embeddings stored in Supabase
pgvector, the real text model, and a real browser embedding.

#### 3.6.1 Start the app

Either a local production build:

```bash
npm run build && npm start          # http://localhost:3000; NODE_ENV=production, so DATABASE_SSL_CA is mandatory
```

or a deployed preview with the app variables from §2.4 set in the host (`DATABASE_URL` on 6543, `DATABASE_SSL_CA`,
Supabase URL + publishable key, `OPENAI_API_KEY`, `AI_*`, `WIDGET_SESSION_SECRET`, `LOG_LEVEL`). **Do not set
`SUPABASE_SECRET_KEY` there.** Add the preview's `/auth/confirm` to the Supabase redirect URLs. Keep the server logs
visible: they are JSON lines (info/debug on stdout, warn/error on stderr).

Below, `<app-origin>` is `http://localhost:3000` or the preview origin.

#### 3.6.2 Sign up with real email confirmation

1. Open `<app-origin>/signup`, register with a real mailbox you control (user A).
2. Expect the "check your email" page (`/check-email`).
3. Open the confirmation link from the email in the **same browser**. It goes through `/auth/confirm` and signs you in.
4. Sign out and sign in again at `/login` to confirm password login.

Evidence: the email arrived, the link signed you in, no `/auth/error` page.

#### 3.6.3 Create the organization

On `/onboarding`, create organization A. Note its slug (`/o/<slug-a>`), then find its id:

```sql
select id, slug, name, created_at from public.organizations order by created_at desc limit 5;
```

#### 3.6.4 Configure the agent

On `/o/<slug-a>/agents/<agentId>`, fill **Settings** (name, greeting, instructions, timezone, status Active, lead
capture on with name + phone), **Business profile** and **Business hours**. Save each section.

#### 3.6.5 Add knowledge

On `/o/<slug-a>/knowledge`, add a text source with a distinctive, checkable fact, for example:
"A gutter inspection costs $47 and is only available on Tuesdays." Wait for status **ready**.

```sql
select s.title, s.status, s.chunk_count, c.embedding_model, count(c.id) as chunks
from public.knowledge_sources s
left join public.knowledge_chunks c on c.source_id = s.id and c.organization_id = s.organization_id
where s.organization_id = '<org-a-id>'
group by s.id, s.title, s.status, s.chunk_count, c.embedding_model;
```

Expected: `ready`, `chunks` > 0, `embedding_model` = `text-embedding-3-small` (or the configured model).

#### 3.6.6 Publish the widget and set allowed sites

In the **Web chat** section: publish, note the widget key (`wk_…`) and the embed code. Under "Allowed websites",
enter `http://localhost:8080` (the test page origin below; `http://localhost[:port]` is accepted for development,
everything else must be `https://`) and save.

#### 3.6.7 Embed on a test page

Create a page **outside the repository**, e.g. `widget-test/index.html`:

```html
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Widget test</title></head>
  <body>
    <h1>Widget embed test</h1>
    <script src="<app-origin>/embed.js" data-widget-key="wk_REPLACE_ME" async></script>
  </body>
</html>
```

```bash
cd widget-test && python3 -m http.server 8080      # open http://localhost:8080
```

Expected: the launcher button appears and the chat opens in an iframe served by `<app-origin>`.

#### 3.6.8 Chat

| Action | Expected |
| --- | --- |
| Ask about the distinctive fact ("How much is a gutter inspection?") | The reply states the fact from knowledge ($47, Tuesdays). |
| Ask something not in knowledge ("Do you install swimming pools?") | The reply says it does not have that information; no invented prices, phone numbers or emails. |
| Leave a name and phone number and ask for a callback | The reply confirms only after the lead is saved; the lead appears on `/o/<slug-a>/leads`. |
| Reload the test page and reopen the chat | The same conversation and messages are restored (also visible under `/o/<slug-a>/conversations`). |

```sql
select l.created_at, l.captured_name, l.captured_phone, c.phone_normalized, l.conversation_id
from public.leads l
join public.contacts c on c.id = l.contact_id and c.organization_id = l.organization_id
where l.organization_id = '<org-a-id>' order by l.created_at desc;

select tool_name, status, error_code, replayed, duration_ms, started_at
from public.tool_runs where organization_id = '<org-a-id>' order by started_at;
```

Expected: one lead for the conversation; `searchKnowledge` and `captureLead` runs with status `succeeded`.

#### 3.6.9 Second tenant isolation

In a private window, sign up user B with a different real mailbox, confirm, create organization B, configure its
agent with different knowledge and publish its widget. Then:

| Check (as user B / B's widget) | Expected |
| --- | --- |
| Open `/o/<slug-a>` and `/o/<slug-a>/conversations/<a-conversation-id>` | Not found; none of A's data is shown. |
| B's Conversations, Leads and Knowledge pages | Only B's records. |
| Ask B's widget about A's distinctive fact | No A facts in the reply (no $47, no A business name). |

#### 3.6.10 Usage records and daily totals

```sql
select created_at, kind, purpose, provider, model, input_tokens, cached_input_tokens, output_tokens,
       reasoning_tokens, tool_calls, estimated_cost_usd, pricing_known, pricing_version, metadata
from public.usage_records
where organization_id = '<org-a-id>'
order by created_at;

select pricing_version, pricing_known, count(*) from public.usage_records
where organization_id = '<org-a-id>' group by 1, 2;

-- The daily total maintained by the trigger must equal the sum of today's records (UTC).
select
  (select coalesce(sum(estimated_cost_usd), 0) from public.usage_records
    where organization_id = '<org-a-id>'
      and (created_at at time zone 'UTC')::date = (now() at time zone 'UTC')::date) as records_today_usd,
  (select count(*) from public.usage_records
    where organization_id = '<org-a-id>'
      and (created_at at time zone 'UTC')::date = (now() at time zone 'UTC')::date) as records_today,
  d.estimated_cost_usd as daily_total_usd,
  d.records as daily_total_records
from app_private.usage_daily_totals d
where d.organization_id = '<org-a-id>' and d.usage_date = (now() at time zone 'UTC')::date;
```

Expected:

- `embedding` rows with purposes `knowledge_ingestion` and `knowledge_query`, and `text_generation` rows with purpose
  `chat_response` (one per model round; `metadata` has `tier`, `round`, `route`, `attempts`, `firstTokenMs`).
- `pricing_version` = `2026-11-26` (or `AI_PRICING_VERSION` if set) and `pricing_known = true`. A row with
  `pricing_known = false` is priced at $0 and is not counted against spend limits: record it as an issue and add the
  model to `AI_MODEL_PRICING_JSON`.
- `records_today_usd = daily_total_usd` and `records_today = daily_total_records`.
- These are **estimates** from the dated price list, not provider billing. The OpenAI dashboard may be noted as a
  sanity check only; reconciliation is Phase 7 (§8).

Optional: continue one conversation past `AI_MAX_RECENT_MESSAGES` + 4 user/assistant messages (16 with the defaults);
a `conversation_summary` row should appear, and `public.conversations.summary` should attribute statements
("The visitor said …").

#### 3.6.11 Spend limit enforcement

```sql
insert into app_private.organization_limits (organization_id, daily_ai_spend_usd)
values ('<org-a-id>', 0)
on conflict (organization_id) do update set daily_ai_spend_usd = excluded.daily_ai_spend_usd;
```

Send a chat message on A's widget. Expected:

- The widget shows `I can't reply right now. Please contact the business directly.` (turn error `limit_reached`).
- The server log has `usage.limit.enforced` with `resource: "ai_spend_usd"`, `scope: "daily_spend"`, `limitUsd: 0`.
- No new `usage_records` row for A (the refusal happens before any provider call).
- Adding a knowledge source for A fails with `The organization's AI usage limit has been reached. Please try again later.`
- B's widget keeps working (the override is per organization).

Restore (NULL means "use the platform default"):

```sql
update app_private.organization_limits set daily_ai_spend_usd = null where organization_id = '<org-a-id>';
```

#### 3.6.12 `frame-ancestors` header on `/widget/<key>`

```bash
curl -sI <app-origin>/widget/<widget-key-a> | grep -iE 'content-security-policy|x-frame-options'
curl -sI <app-origin>/widget/wk_000000000000000000000000 | grep -iE 'content-security-policy|x-frame-options'
curl -sI <app-origin>/login | grep -iE 'content-security-policy|x-frame-options'
# If HEAD is not handled, use GET: curl -s -o /dev/null -D - <url>
```

| Request | Expected header |
| --- | --- |
| Published widget with allowed site `http://localhost:8080` | `content-security-policy: frame-ancestors http://localhost:8080`, no `x-frame-options` |
| Same widget after clearing the allowed websites list | `content-security-policy: frame-ancestors *` |
| Unknown, unpublished or paused widget key | `content-security-policy: frame-ancestors 'none'` |
| Admin page (`/login`) | `x-frame-options: DENY` and `content-security-policy: frame-ancestors 'none'` |

Browser check: set the allowed websites to `https://www.example.com` only, reload the test page: the browser must
refuse to render the iframe (console reports a `frame-ancestors` violation). Restore `http://localhost:8080`.
Allowed sites are a browser-enforced embedding control, **not authentication**: the public widget API stays
reachable by scripts and is bounded by rate limits and spend limits.

#### 3.6.13 Optional: fail-fast on rejected credentials

Restart the app with an invalid `OPENAI_API_KEY`, send one chat message, and confirm: the widget shows a recoverable
error, the log has exactly one `ai.call.failed` at error level with `code: "auth"` and `attempts: 1`, and no
`ai.call.retry` or `ai.route.escalated`. Restore the real key.

### 3.7 Record the results

Fill in the template in §7 and append it under "Recorded runs". Update §1 Status with the date and outcome.

### 3.8 Clean up

See §6.

---

## 4. Verification matrix

| # | Required item | How it is verified | Tool / step | Expected evidence |
| --- | --- | --- | --- | --- |
| 1 | Migration compatibility | All migrations apply to the real Supabase Postgres (17) over verified TLS; re-run is a no-op; history recorded | `db:migrate` (3.3); `validate:live` checks `migrations: all applied`, `connection: pgvector installed` (3.4) | `Applied 3 migration(s).` then `Database is up to date (3 migrations applied).`; PASS lines showing the Postgres and pgvector versions |
| 2 | Real Supabase authentication | Admin-created users sign in with the publishable key; the JWT is verified with `getClaims`; a real sign-up through the confirmation email | `validate:live` `supabase auth: user a/b …` (3.4); manual 3.6.2 | 2 PASS lines with `role=authenticated`; confirmation email received and `/auth/confirm` signs the user in |
| 3 | Transaction pooling and RLS isolation | Transaction-local role/JWT claims never leak into the next transaction through Supavisor; under user scope a user sees and changes only their organization | `validate:live` over port 6543 (3.4); manual 3.6.9 | PASS `transaction pooling: settings stay transaction-local`; PASS `rls isolation: …` with `organizations visible: 1`; user B sees none of A's data |
| 4 | pgvector retrieval | Tenant-scoped nearest-neighbour search on Supabase pgvector (stand-in embeddings); with real embeddings on PGlite; with real embeddings on Supabase | `validate:live` `pgvector retrieval: …` (3.4); `eval:live` scenario 5 (3.5); manual 3.6.5 / 3.6.8 | PASS lines; knowledge source `ready` with chunks; the grounded reply in 3.6.8 |
| 5 | Real text-model responses and tool calling | The configured text model answers and calls `searchKnowledge` / `captureLead` through the validated executor | `eval:live` scenarios 1–3 and 5 (3.5); manual 3.6.8 | `tool   searchKnowledge … -> succeeded, N result(s)`, `tool   captureLead … -> succeeded, saved …`; `tool_runs` rows `succeeded` |
| 6 | Real embeddings | Knowledge ingestion and query embeddings through the configured embedding model | `eval:live` setup + scenario 6 (3.5); manual 3.6.5 / 3.6.10 | Usage lines `openai/text-embedding-3-small knowledge_ingestion` and `knowledge_query`; `knowledge_chunks.embedding_model` |
| 7 | Grounded answers | Answer comes from retrieved knowledge; unknown questions get no invented facts | `eval:live` scenarios 1–2 (3.5); manual 3.6.8 | PASS on the $89 checks and the "does not have that information" checks; manual replies as expected |
| 8 | Lead capture | Name + phone saved through `captureLead`, linked to the conversation; success claimed only after the tool succeeded | `eval:live` scenario 3 (3.5); manual 3.6.8 | PASS on the three lead checks; lead visible on the Leads page and in SQL |
| 9 | Usage accounting (estimated, with `pricing_version`) | Every provider call is metered with tokens, estimated cost and pricing version; daily totals match | `eval:live` scenario 6 (3.5); `validate:live` `usage accounting: …` (3.4); manual 3.6.10 | PASS lines; `pricing_version = 2026-11-26`, `pricing_known = true`; `records_today_usd = daily_total_usd` |
| 10 | Retry and failure behaviour | A model id the provider rejects fails once, without retry or escalation. **429/5xx retries cannot be forced against the live provider deterministically**: they are verified by the automated tests with injected failures (`tests/unit/retry-policy.test.ts`, `tests/integration/chat-turn.test.ts`, `tests/unit/embedding-service.test.ts`, `tests/unit/openai-errors.test.ts`), and live only by observing `ai.call.retry` log events if they occur under load | `eval:live` scenario 7 (3.5); optional 3.6.13; server logs during 3.6 | PASS `the turn ends with a recoverable provider error`, `one attempt, reported as an alert`, `no retry and no escalation`; any observed `ai.call.retry` lines recorded with `code`, `status`, `delayMs` |
| 11 | Spend limits | Parallel reservations never overshoot a limit on the real pool; a 0 daily limit refuses AI work for that organization only | `validate:live` `concurrency: parallel spend reservations never overshoot the limit` (3.4); manual 3.6.11 | PASS with `3 of 6 granted`; refusal message, `usage.limit.enforced` log, no new usage rows |
| 12 | Allowed sites header | Per-widget CSP `frame-ancestors` from the allowed websites list; admin pages never framable | Manual 3.6.12 (`curl -I` + browser) | The header values in the 3.6.12 table; browser refuses a non-listed embedder |
| 13 | Concurrency | One turn-lock owner among 8 parallel attempts; reservations serialized per organization; one execution claim among 5 parallel claims | `validate:live` (3.4) | PASS on the three `concurrency: …` lines; `DATABASE_POOL_MAX` recorded |

---

## 5. What each script checks and how to read the output

### 5.1 `db:migrate`

See 3.3. Output lines: `Pending migrations (N):` (dry run), `  applied  <version>_<name>`, `Applied N migration(s).`,
`Database is up to date (N migrations applied).`, `No pending migrations (N applied).` (dry run). Exit codes: 0 success,
1 configuration/TLS refusal/connection/migration failure, 2 unknown argument.

### 5.2 `validate:live`

First line: `Live validation against <database host> (tls: <disable|require|verify>)`. Then one line per check,
`  PASS  <name> — <detail>` (or `FAIL` / `SKIP`), then `<n> passed, <n> failed, <n> skipped`.

It creates two throwaway auth users (`live-validation+a-<random>@example.com`, `live-validation+b-<random>@example.com`,
created already confirmed, so no emails are sent) and two organizations (`live-validation A`, `live-validation B`),
and deletes them at the end, also when a check fails.

| # | Printed check name | What it does | PASS means |
| --- | --- | --- | --- |
| 1 | `connection: verified TLS` | Reads the configured TLS mode (detail `tls=<mode>`) | Mode is `verify` (or the host is local) |
| 1 | `connection: pgvector installed` | Reads `server_version` and the installed `vector` extension version | pgvector is installed; detail shows `postgres <version>, pgvector <version>` |
| 2 | `migrations: all applied` | Compares `supabase/migrations/*` with `supabase_migrations.schema_migrations` | Every file is recorded (detail `<n> migrations`; on failure, `missing …` or a hint to run `db:migrate`) |
| 3 | `transaction pooling: settings stay transaction-local` | Six rounds: set `request.jwt.claims` and `role` with `set_config(…, true)` inside a transaction, then read them in a new statement | No claims or `authenticated` role leaked into later statements |
| 4 | `supabase auth: user a signs in with verified claims` / `… user b …` | Admin `createUser` (secret key), `signInWithPassword` (publishable key), `getClaims` | Verified `sub` equals the created user id and `role` is `authenticated` |
| 5 | `rls isolation: a user sees and changes only their organization` | As user A (role `authenticated` + A's claims): list organizations, read B's agents, try to update B's agent instructions | Exactly A's organization visible; B's agents invisible; the update changes 0 rows |
| 6 | `pgvector retrieval: finds the tenant’s own knowledge, never another tenant’s` | Ingests one text per organization with **deterministic stand-in embeddings** (no AI provider call) and searches A's knowledge | A's text is found; B's is not. Tests the database mechanics, not embedding quality |
| 7 | `concurrency: exactly one turn-lock owner` | 8 parallel turn-lock acquisitions on one conversation | Exactly one token granted |
| 7 | `concurrency: parallel spend reservations never overshoot the limit` | 6 parallel reservations of $0.30 each (test-only price) against a $1 daily limit | Exactly 3 granted, the rest refused with `UsageLimitError` (detail `3 of 6 granted`) |
| 7 | `concurrency: one execution claim per external operation` | 5 parallel claims of the same operation key | Exactly one claim succeeds |
| 8 | `usage accounting: records feed the daily spend totals` | Records 1,000 input + 500 output tokens at test prices ($1 / $2 per 1M; `pricing_version` `live-validation`) for B | `app_private.usage_daily_totals` for B equals $0.002 |

SKIP rules: without all three of `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and
`SUPABASE_SECRET_KEY`, `supabase auth` is SKIP, and `rls isolation`, `pgvector retrieval`, `concurrency` and
`usage accounting` are SKIP with "needs two auth users (Supabase Auth checks)". The same four are skipped if user
creation fails (then `supabase auth` is FAIL).

If a group throws, it is reported as one FAIL line under the group name (`connection`, `migrations`,
`transaction pooling`, `supabase auth`, `rls isolation`, `pgvector retrieval`, `concurrency`, `usage accounting`)
with the error message.

Exit codes: 0 when no check failed (**SKIPs still exit 0**); 1 when any check failed, `DATABASE_URL` is missing or
invalid, verified TLS is missing without `--allow-unverified-tls`, or an unexpected error occurred.

### 5.3 `eval:live`

Output: `Configured routes (from the environment):` with the `text`, `escalation` and `embeddings` provider/model and
reasoning effort; the tenant setup with its usage lines; then per scenario `== <title> ==`, `Visitor (<tenant>): …`,
one `  tool   <tool> <arguments> -> <outcome>` line per tool run, `Agent: <reply>` (or `Agent failed: <code>: <message>`),
`  usage  <provider>/<model> <purpose> [escalation] xN: <in> in / <out> out tokens, $<estimate>` lines, and
`  PASS  …` / `  FAIL  …` lines. The `<model>` in usage lines is the id **returned by the provider**: record it.
A usage line ending in `unpriced (add it to AI_MODEL_PRICING_JSON)` means the estimate is incomplete.

Throwaway setup: an in-memory PGlite database (Supabase test shim + all migrations), tenants **Demo Home Services**
(agent Riley; knowledge includes the $89 service-call fee) and **Shelbyville Pinball Restoration** (agent Flip),
created through the domain services, driven through the web chat channel service the way the widget drives it.

| # | Scenario (printed title) | Visitor message | Checks (printed names) |
| --- | --- | --- | --- |
| 1 | `1. Question answered in the knowledge base` | "How much do you charge for a standard service call?" | `the turn completed`; `searchKnowledge succeeded and returned the $89 service-call fee`; `the reply states the $89 service-call fee`; `the reply invents no prices or contact details` |
| 2 | `2. Question the knowledge base cannot answer` | "Do you install swimming pools?" | `the turn completed`; `the reply says it does not have that information`; `the reply does not claim the service is offered`; `the reply invents no prices or contact details` |
| 3 | `3. Visitor leaves name and phone` | "I'm Jane Doe and my number is (555) 123-4567 — please call me back about a quote." | `the turn completed`; `captureLead succeeded`; `one lead with the visitor's name and phone is linked to the conversation`; `the reply confirms saving only after captureLead succeeded` |
| 4 | `4. Visitor reopens the widget (refresh)` | (reopens with the stored session token) | `the same conversation is restored`; `the restored transcript is the stored user/assistant messages, in order`; `the last restored message is the latest reply` |
| 5 | `5. Another tenant's widget is asked about the first tenant's facts` | Scenario 1's question, on the pinball widget | `the turn completed`; `no tool result contains the other tenant's knowledge`; `the reply contains none of the other tenant's facts`; `retrieval without a relevance threshold returns only this tenant's chunks` |
| 6 | `6. Usage metered on the configured providers and models` | — | `chat, knowledge-query and ingestion usage were all recorded`; `every model call ran on the configured provider/model`; `every priced call has tokens and an estimated cost` |
| 7 | `7. A model id the provider rejects fails at once, without retries or escalation` | "Hello there", with the text model set to `live-validation-model-that-does-not-exist` | `the turn ends with a recoverable provider error` (error starts with `provider_unavailable`); `one attempt, reported as an alert` (exactly one `ai.call.failed`, `attempts=1`; detail shows the code, expected `invalid_request` for a 400/404/422 or `auth` for a 401/403); `no retry and no escalation` |

Heuristic checks: the "invents no prices or contact details" checks flag any price, phone-like number or email in the
reply that does not appear in the tenant's knowledge or profile; "does not have that information" is a wording
pattern (a bare "No, we don't" counts as an invented fact by design). Model output varies between runs.

Final line: `<n> check(s) passed, <n> failed. Estimated provider cost of this run: $<amount>.` The amount is the sum
of `estimated_cost_usd` over every usage record of the run up to scenario 6 (setup embeddings, scenarios 1–5, any
summaries); scenario 7's request is rejected by the provider. It is an estimate from the configured price list, not
billing.

Exit codes: 0 when all checks pass; 1 when any check fails, the configuration is incomplete (e.g. no
`OPENAI_API_KEY` while a profile uses `openai`, or an invalid `AI_*` value), or the run aborts (e.g. tenant knowledge
ingestion fails).

---

## 6. Cleanup and safety

### 6.1 `validate:live` cleanup

The script deletes its two organizations (all tenant rows cascade from `public.organizations`, including
`app_private` usage totals, reservations, limits and tool operations) and its two auth users in a `finally` block,
also after a failed check. A cleanup failure is printed as:

```text
  cleanup: could not delete organization <id>: <error>
  cleanup: could not delete auth user <id>: <error>
```

Find and remove leftovers (SQL editor):

```sql
-- Leftover organizations from validate:live
select id, name, slug, created_at from public.organizations where name like 'live-validation%';
delete from public.organizations where name like 'live-validation%';

-- Leftover auth users from validate:live
select id, email, created_at from auth.users where email like 'live-validation+%@example.com';
```

Delete leftover users in Authentication → Users (or with the admin API). Delete the organizations first: deleting a
user removes their memberships, not their organizations.

### 6.2 Other data

- `eval:live` uses an in-memory database: nothing to clean up in Supabase.
- The manual check leaves users A and B, their organizations, conversations, leads and usage rows. Delete them
  (organizations first, then the users), or delete the whole disposable project.
- Remove any `app_private.organization_limits` override you created (3.6.11).

### 6.3 Safety

- **Never run `db:migrate` or `validate:live` against a database with production data without a verified backup.**
  `validate:live` writes to tenant tables and `auth.users`; migrations run with the most privileged credentials. Use
  the disposable project.
- Use verified TLS (`DATABASE_SSL_CA`) for every recorded step; `--allow-unverified-tls` is for a first look only.
- `SUPABASE_SECRET_KEY` bypasses RLS: keep it only in your local `.env.local` for the run, delete the line afterwards,
  and delete the dedicated key in Supabase. It must never appear in a deployed environment.
- `.env.local` is git-ignored (`.env.*`); keep the CA file and the widget test page outside the repository.
- Do not paste secrets into the results record. `validate:live` prints only the database host and TLS mode; redact
  the project ref wherever it appears (URLs, hosts, log lines).
- Rotate or delete the OpenAI project key after the run if it was shared or exposed.

### 6.4 Costs

| Step | Paid calls | Expected cost |
| --- | --- | --- |
| `db:migrate`, `validate:live` | None to AI providers (`validate:live` uses stand-in embeddings and test prices) | Supabase project usage only |
| `eval:live` | Real text model + embeddings | The script's header states a run costs well under one US cent with the default models. Conservatively, expect well under US$0.05 at the verified Standard prices (gpt-6-luna $0.10 input / $0.50 output per 1M tokens; text-embedding-3-small $0.02 per 1M). Escalations raise it: gpt-6.2-sol is priced 20× gpt-6-luna per token ($2.00 / $10.00); escalated calls are labelled `[escalation]` in the usage lines. The printed estimate is the figure for the run. |
| Manual check | A handful of chat turns and knowledge embeddings | Same per-token prices; read the sum from `usage_records` (3.6.10) |

The OpenAI project spend limit (§2.3) is the backstop; the organization spend limits (default $10/day, $150/month,
estimated) also apply to the app and to `eval:live`.

---

## 7. Results

### 7.1 Results record template

Copy this block under 7.2 for each run.

```markdown
### Run <n> — <YYYY-MM-DD>

| Field | Value |
| --- | --- |
| Date and time (UTC) | |
| Operator | |
| Commit SHA (`git rev-parse HEAD`) | |
| Working tree clean (`git status --short` empty) | yes / no |
| Node / npm versions | |
| `npm run check` | PASS / FAIL |
| Supabase project | ref redacted (e.g. `abcd…wxyz`), region |
| Postgres version (validate:live) | |
| pgvector version (validate:live) | |
| JWT signing keys | asymmetric (JWKS) / legacy HS256 |
| `db:migrate` connection | session pooler 5432 / direct; TLS `verify` |
| `validate:live` connection | transaction pooler 6543; TLS `verify`; `DATABASE_POOL_MAX=` |
| App under test | `npm start` on localhost / preview (host redacted) |
| Configured models (`AI_TEXT_MODEL` / `AI_ESCALATION_MODEL` / `AI_EMBEDDING_MODEL`) | |
| Model ids returned by the provider (eval:live usage lines, `usage_records.model`) | |
| `pricing_version` on usage records | |
| eval:live estimated cost | $ |
| Manual check estimated cost (sum of `usage_records`) | $ |
| OpenAI dashboard spend for the project (sanity check only, not reconciliation) | $ |

| # | Item (§4) | Result (PASS / FAIL / NOT RUN) | Evidence (output line, SQL result, header, log event) |
| --- | --- | --- | --- |
| 1 | Migration compatibility | | |
| 2 | Real Supabase authentication | | |
| 3 | Transaction pooling and RLS isolation | | |
| 4 | pgvector retrieval | | |
| 5 | Real text-model responses and tool calling | | |
| 6 | Real embeddings | | |
| 7 | Grounded answers | | |
| 8 | Lead capture | | |
| 9 | Usage accounting | | |
| 10 | Retry and failure behaviour | | |
| 11 | Spend limits | | |
| 12 | Allowed sites header | | |
| 13 | Concurrency | | |

validate:live summary line: `<n> passed, <n> failed, <n> skipped` (exit code: )
eval:live summary line: `<n> check(s) passed, <n> failed. Estimated provider cost of this run: $…` (exit code: )

Issues found:

| # | Severity | Description | Follow-up (issue / commit) |
| --- | --- | --- | --- |
| | | | |

Cleanup: leftover queries (§6.1) return 0 rows: yes / no · secret key deleted: yes / no · test users and
organizations removed or project deleted: yes / no
```

### 7.2 Recorded runs

**None yet.** No live validation run has been performed (status as of 2026-11-26, §1).

---

## 8. Known gaps (not coverable by live validation yet)

| Gap | Why | Where it is addressed |
| --- | --- | --- |
| Realtime voice and telephony (GPT-Live, WebRTC, Twilio SIP, the voice gateway) | Not implemented; Twilio SIP → GPT-Live is an inference still to be proven by a spike | Phase 2 (voice engine + browser proof of concept) and Phase 3 (inbound phone) in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) |
| Provider-confirmed billing reconciliation | Usage costs are estimates from a dated price list (`pricing_version`). OpenAI's Costs API reports daily buckets per project / API key / line item with an admin key, not per request; importing it is not built | Phase 7 |
| Deterministic live 429/5xx retries | The live provider cannot be made to fail on demand; covered by automated tests with injected failures, and observed live only if `ai.call.retry` events occur | — (see §4 item 10) |
| External-side-effect operations (`unknown` outcomes, reconciliation) | No tool with external side effects exists yet; `validate:live` only exercises the atomic claim | Phase 4 (SMS, booking) |
| Real embeddings on Supabase in a scripted check | `validate:live` uses stand-in embeddings; `eval:live` uses PGlite. Only the manual check combines real embeddings with Supabase pgvector | Manual check 3.6.5 / 3.6.8 |
| Latency and load | This runbook records observations (`firstTokenMs`, `latencyMs` in logs) but is not a benchmark; no latency figures are claimed | Phase 7 (monitoring and scaling) |
| Public endpoint rate limits under real traffic | Covered by automated tests; not load-tested here | Phase 7 |
