# Spencer — Spending Tracer

A dead-simple, **mobile-first family spending tracker**. Add expenses in a couple of
taps, set your monthly income by category, and see monthly (pie + day-by-day list)
and yearly overviews. Google sign-in is restricted to an email allow-list.

## Stack

- **Next.js 16** (App Router, Turbopack) · **React 19** · **TypeScript**
- **Supabase** — Postgres, Auth (Google OAuth), row-level security
- **Tailwind CSS v4** · **shadcn/ui** · **Recharts** (pie + bars now, Sankey-ready later)

## How it works (at a glance)

- Every user belongs to a **group** (one "Family" group is seeded). All data is
  scoped to the group via RLS, so adding more families later needs no code changes.
- **Spendings**: description, amount, category, date, and who entered it
  (`group_id` / `user_id` are filled automatically from the session). Tap the
  pencil on any row — on the monthly list or inside a bucket drill-down — to edit
  it in a bottom sheet; the trash icon deletes. Both work on **any** row in the
  group, not just your own (`supabase/migrations/0006_edit_spendings.sql`), and
  re-categorising a spending re-derives its bucket via the DB trigger. The author
  is never reassigned.
- **Income** is **effective-dated** and carries forward: editing it applies from the
  current month onward; past months keep their own figures. A row back-dated far
  enough (e.g. `2000-01-01`) therefore acts as a **standing income** that applies to
  every month until you override it.
- Categories are **per-group and editable in-app** (Profile menu → _Categories &
  budget_): add / rename / retire expense & income categories, pick an icon + color,
  and assign each expense category to a bucket. They live in `public.categories`
  (seeded with sensible defaults); historical spendings keep resolving by `key`, so
  retiring a category just archives it. Types/helpers stay in `lib/categories.ts`,
  which also pins the catch-all **Other** to the end of every list (pickers, settings,
  breakdowns) regardless of its `sort` or its total.
- Every expense category rolls up into one of four hidden **buckets** — _needs,
  wants, savings & investments, emergency_ — to track how income is distributed vs.
  goals (default **20 / 10 / 40 / 30 %**, editable on the same screen). The bucket is
  stored on every spending row, auto-filled by a DB trigger from `categories.bucket`;
  per-group targets live in `bucket_targets`. See
  `supabase/migrations/0004_buckets.sql` + `0005_editable_categories.sql`.
- **Split by member**: both the monthly and yearly overviews break spend down by
  who entered it — a donut for the month, twelve stacked bars for the year, each
  with a legend of avatar / name / share / amount. On the month view a legend row
  expands into that person's categories and individual spendings. Member colours
  are assigned by join order (never by who spent more, so the colours hold steady
  month to month) from the validated palette in `lib/members.ts`.
- Currency/format defaults to **EUR / de-DE** (`NEXT_PUBLIC_CURRENCY`, `NEXT_PUBLIC_LOCALE`).

## Setup

### 1. Install

```bash
npm install
```

### 2. Create a Supabase project

Create a project at [supabase.com](https://supabase.com), then apply **all**
migrations in `supabase/migrations/` — `0001` through `0006`, in numeric order.
The CLI does that for you:

```bash
npx supabase link --project-ref <your-project-ref>
npx supabase db push
# optional: regenerate types after schema changes
npx supabase gen types typescript --linked > types/database.ts
```

> If you paste them into **Dashboard → SQL Editor** by hand instead, run **every**
> file, in order. `0001` alone leaves you without buckets, editable categories or
> spending edits, and the app will fail at runtime. The files are idempotent, so
> re-running one is harmless.

| Migration | What it adds |
|---|---|
| `0001_init` | `groups`, `profiles`, `spendings`, `income`, `allowed_emails`; the RLS policies; the `current_group_id()` helper; a `handle_new_user` trigger that **rejects non-allow-listed emails at sign-up** and otherwise provisions a profile + assigns the default group. Seeds the single **Family** group. |
| `0002_lock_allowed_emails` | Revokes all API access to `allowed_emails` — it is read only by the sign-up trigger. |
| `0003_secure_functions` | Pins `search_path`; moves `current_group_id()` into a non-exposed `private` schema. |
| `0004_buckets` | The `bucket` enum, `spendings.bucket` + its trigger, and `bucket_targets` seeded to 20 / 10 / 40 / 30 %. |
| `0005_editable_categories` | `public.categories` per group, seeded with the 14 expense + 5 income defaults; repoints the bucket trigger at it. |
| `0006_edit_spendings` | Group-wide UPDATE policy, so anyone in the group can fix anyone's row. |

Because `0001` seeds the Family group, the category and bucket-target seeds in
`0004`/`0005` land automatically. A fresh database therefore comes up usable with
no manual seeding beyond the allow-list below.

**Seed the allow-list** — this is the hard security gate (the database blocks anyone
not listed, independent of the app). It is *data*, not schema, so it does **not**
travel with a migration or a deploy: seed it once per database (local, production,
…). In the SQL Editor:

```sql
insert into public.allowed_emails (email) values
  ('you@example.com'),
  ('partner@example.com')
on conflict do nothing;
```

### 3. Enable Google sign-in

1. **Google Cloud Console** → create an OAuth 2.0 Client ID (type: Web application).
   Add the authorized redirect URI:
   `https://<your-project-ref>.supabase.co/auth/v1/callback`
   That is the **only** redirect URI Google ever needs — the browser reaches Google
   through Supabase, so adding your own domain here is neither required nor
   sufficient.
2. **OAuth consent screen**: while the app is in _Testing_, only accounts listed as
   test users can sign in at all. Add them there, or publish the app.
3. **Supabase → Authentication → Providers → Google**: paste the Client ID + Secret.
4. **Supabase → Authentication → URL Configuration**: set the **Site URL** to the
   origin you serve from, and add a callback for **every** origin to the redirect
   allow-list:
   - `http://localhost:3000/auth/callback`
   - `https://<your-domain>/auth/callback` — production
   - `https://*.vercel.app/auth/callback` — only if you want sign-in to work on
     Vercel preview deployments (tighten the wildcard to your project/team prefix
     if you can)

   The sign-in button asks Supabase to return to
   `${window.location.origin}/auth/callback` (`components/google-sign-in-button.tsx`),
   so any origin the app is served from must be listed or the redirect is rejected.

### 4. Environment variables

Copy `.env.local.example` to `.env.local` and fill it in:

```bash
cp .env.local.example .env.local
```

| Variable | Required | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Project API URL — Dashboard → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | yes | `sb_publishable_…` (the legacy anon public key also works) |
| `ALLOWED_EMAILS` | yes | **Server-only** comma-separated allow-list of Google emails. Missing or empty ⇒ **nobody can sign in** |
| `NEXT_PUBLIC_SITE_URL` | yes in prod | The canonical origin of *this* deployment, no trailing slash — `http://localhost:3000` locally, `https://<your-domain>` in production |
| `NEXT_PUBLIC_LOCALE` | no | Defaults to `de-DE` |
| `NEXT_PUBLIC_CURRENCY` | no | Defaults to `EUR` |
| `NEXT_PUBLIC_TIMEZONE` | no | IANA tz for "today"/"current month" date math. Defaults to `Europe/Berlin` |

`SUPABASE_SECRET_KEY` is present but commented out in the example file — nothing in
the app reads it today. Leave it unset unless you add admin-API code.

> `ALLOWED_EMAILS` must **not** be prefixed with `NEXT_PUBLIC_` — it stays on the
> server so the allow-list is never shipped to the browser. It's enforced in the
> OAuth callback (`app/auth/callback/route.ts`) and the protected layout
> (`app/(app)/layout.tsx`), and should be kept **in sync with the `allowed_emails`
> table**, which is the database-level hard gate that blocks non-listed accounts.

> **Every `NEXT_PUBLIC_*` value is inlined at build time.** Changing one on the
> hosting provider does nothing until you rebuild — a restart is not enough.

> **`NEXT_PUBLIC_SITE_URL` is a security control, not cosmetics.** In production the
> OAuth callback redirects to it instead of trusting the `X-Forwarded-Host` header,
> so a spoofed header can't bounce a just-authenticated user off-site
> (`app/auth/callback/route.ts`). Point it at the origin that deployment is actually
> served from.

### 5. Run

```bash
npm run dev
```

Open http://localhost:3000. Sign in with an allow-listed Google account, add a
spending, then set your income under the **Income** tab.

### 6. Optional: a standing income

The in-app **Income** editor always applies from the *current* month onward, which
is what you want for a raise. To declare an income that has "always" been true — so
that browsing back through past months shows sensible numbers — insert a row
back-dated far enough, once, in the SQL Editor:

```sql
insert into public.income (group_id, category, amount, effective_from)
values ('00000000-0000-0000-0000-000000000001', 'salary', 1234.56, '2000-01-01')  -- your amount
on conflict (group_id, category, effective_from) do update
  set amount = excluded.amount;
```

`group_id` must be passed explicitly — its default calls `current_group_id()`, which
is null in the SQL Editor. `'00000000-0000-0000-0000-000000000001'` is the seeded
Family group. `category` must match an income category key (`salary`, `bonus`,
`rental`, `investments`, `other` by default). Any later edit in the app overrides it
from that month on.

## Deploy (Vercel)

A stock Next.js 16 App Router deployment — no adapter, no `vercel.json`, nothing to
configure beyond environment variables. Vercel detects the framework and runs
`next build`.

**First, decide whether production gets its own Supabase project.** A separate one is
the safer default: the allow-list, the categories and every spending row live in the
database, so a shared project means local development writes to real family data.

### 1. Node version

Next 16 requires **Node ≥ 20.9**. On Vercel that's _Project Settings → Node.js
Version_ — the default for new projects is fine; check it on an older one.

### 2. Import the repo and set the environment

1. _Add New → Project_ → import the repository. Leave the build settings alone.
2. _Settings → Environment Variables_ → add the following to **Production** (and to
   **Preview** as well if you want previews to work):

   | Variable | Production value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | the production project's API URL |
   | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | its publishable / anon key |
   | `ALLOWED_EMAILS` | the same list you seed into the `allowed_emails` table |
   | `NEXT_PUBLIC_SITE_URL` | `https://<your-domain>` — **not** `localhost`, no trailing slash |
   | `NEXT_PUBLIC_LOCALE`, `NEXT_PUBLIC_CURRENCY`, `NEXT_PUBLIC_TIMEZONE` | optional — omit for `de-DE` / `EUR` / `Europe/Berlin` |

   `NEXT_PUBLIC_SITE_URL` is the one value you must not copy over from `.env.local`.
3. Deploy.

### 3. Point Supabase (and Google) at the domain

Once you know the production URL — and again whenever you attach a custom domain:

- **Supabase → Authentication → URL Configuration**: set **Site URL** to
  `https://<your-domain>` and add `https://<your-domain>/auth/callback` to the
  redirect allow-list. Add the `https://*.vercel.app/auth/callback` wildcard too if
  you want sign-in on preview deployments.
- **Google Cloud Console**: nothing to change. The OAuth redirect URI stays the
  Supabase callback. Add the domain under _Authorized JavaScript origins_ only if you
  have restricted them.

### 4. Prepare the production database

Schema and seed data do not ride along with a deploy. Against the production project:

```bash
npx supabase link --project-ref <prod-project-ref>
npx supabase db push
```

Then seed the allow-list (Setup step 2) and, if you want one, the standing income row
(Setup step 6). The Family group, the categories and the bucket targets are seeded by the
migrations themselves.

### 5. Smoke-test

1. Open the production URL → you land on `/login`.
2. Sign in with an allow-listed Google account → you land on the Add-spending screen
   (not back on `/login`).
3. Add a spending → it appears under **Overview**, with a category and a member colour.
4. Set an income under **Income** → the bucket goals on **Overview** fill in.

### Preview deployments

Each preview build gets its own `*.vercel.app` origin, which brings two wrinkles:

- Its callback must match the Supabase redirect allow-list — hence the wildcard above.
- If `NEXT_PUBLIC_SITE_URL` is set to the production domain in the **Preview**
  environment, signing in on a preview drops you on **production**, because the
  callback prefers the configured site URL over the forwarded host. Either leave
  `NEXT_PUBLIC_SITE_URL` unset for Preview (it then falls back to the forwarded host)
  or accept the bounce.

Previews that share the production Supabase project write to real data. Give them
their own project if that matters to you.

### Schema changes after the first deploy

Migrations are **not** applied by the deploy. After merging one:

```bash
npx supabase db push                                              # prod project
npx supabase gen types typescript --linked > types/database.ts    # commit the result
```

Push the schema before — or together with — the deploy that depends on it.

### Troubleshooting

| Symptom | Cause |
|---|---|
| `/login?error=not_allowed` after Google | The account is missing from `ALLOWED_EMAILS`. Add it, then **redeploy** — on Vercel an environment-variable change only reaches a new deployment. |
| `/login?error=auth` on a **first** sign-in | The email is missing from the `allowed_emails` **table**, so the `handle_new_user` trigger refuses to create the account. Both lists must agree. |
| `/login?error=auth` for an existing account | The code exchange failed — usually the callback URL is missing from the Supabase redirect allow-list. |
| Google shows `redirect_uri_mismatch` | The Google client is missing `https://<project-ref>.supabase.co/auth/v1/callback`. |
| Google shows "access blocked / not a test user" | The consent screen is still in _Testing_ and the account isn't a test user. |
| Sign-in on a preview lands on production | `NEXT_PUBLIC_SITE_URL` points at the production domain in the Preview environment. |
| Signed in, but the category picker is empty | `0005_editable_categories` was never applied. |
| Amounts or dates in the wrong format | `NEXT_PUBLIC_LOCALE` / `NEXT_PUBLIC_CURRENCY` / `NEXT_PUBLIC_TIMEZONE` — remember these need a redeploy. |

## Project map

```
app/
  (app)/            protected screens (auth guard + bottom nav)
    page.tsx        Add spending (home)
    overview/       Monthly overview (pie + member split + day-grouped list)
    year/           Yearly overview (monthly bars + category + member split)
    income/         Monthly income editor + sign out
    settings/       Categories, buckets & target-distribution editor
  login/            Google sign-in
  auth/callback/    OAuth code exchange + allow-list enforcement
proxy.ts            session refresh + soft redirect (Next 16 Proxy)
lib/                supabase clients, auth, categories, format, reports, actions
supabase/migrations/           schema, RLS, triggers, buckets, categories, editing (0001 → 0006)
types/              hand-written DB types + view models
```

## Notes

- The PWA is installable (manifest + icons + standalone); there's no offline mode.
- A Sankey chart is a planned future feature; Recharts (already used) supports it.
