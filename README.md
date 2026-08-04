# Spencer — Spending Tracer

A dead-simple, **mobile-first family spending tracker**. Add expenses in a couple of
taps, set your monthly income by category, and see monthly (pie + day-by-day list)
and yearly overviews. Google sign-in is restricted to an email allow-list.

## Stack

- **Next.js 16** (App Router, Turbopack) · **React 19** · **TypeScript**
- **Supabase** — Postgres, Auth (Google OAuth), row-level security
- **Tailwind CSS v4** · **shadcn/ui** · **Recharts** (pie now, Sankey-ready later)

## How it works (at a glance)

- Every user belongs to a **group** (one "Family" group is seeded). All data is
  scoped to the group via RLS, so adding more families later needs no code changes.
- **Spendings**: description, amount, category, date, and who entered it
  (`group_id` / `user_id` are filled automatically from the session).
- **Income** is **effective-dated**: editing it applies from the current month
  onward; past months keep their own figures.
- Categories are **per-group and editable in-app** (Profile menu → _Categories &
  budget_): add / rename / retire expense & income categories, pick an icon + color,
  and assign each expense category to a bucket. They live in `public.categories`
  (seeded with sensible defaults); historical spendings keep resolving by `key`, so
  retiring a category just archives it. Types/helpers stay in `lib/categories.ts`.
- Every expense category rolls up into one of four hidden **buckets** — _needs,
  wants, savings & investments, emergency_ — to track how income is distributed vs.
  goals (default **20 / 10 / 40 / 30 %**, editable on the same screen). The bucket is
  stored on every spending row, auto-filled by a DB trigger from `categories.bucket`;
  per-group targets live in `bucket_targets`. See
  `supabase/migrations/0004_buckets.sql` + `0005_editable_categories.sql`.
- Currency/format defaults to **EUR / de-DE** (`NEXT_PUBLIC_CURRENCY`, `NEXT_PUBLIC_LOCALE`).

## Setup

### 1. Install

```bash
npm install
```

### 2. Create a Supabase project

Create a project at [supabase.com](https://supabase.com). Then apply the schema in
`supabase/migrations/0001_init.sql` — either paste it into **Dashboard → SQL Editor**
and run it, or use the CLI:

```bash
npx supabase link --project-ref <your-project-ref>
npx supabase db push
# optional: regenerate types after schema changes
npx supabase gen types typescript --linked > types/database.ts
```

The migration creates `groups`, `profiles`, `spendings`, `income`, an
`allowed_emails` table, the RLS policies, the `current_group_id()` helper, and a
`handle_new_user` trigger that **rejects non-allow-listed emails at sign-up** and
otherwise provisions a profile + assigns the default group.

**Seed the allow-list** — this is the hard security gate (the database blocks anyone
not listed, independent of the app). In the SQL Editor:

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
2. **Supabase → Authentication → Providers → Google**: paste the Client ID + Secret.
3. **Supabase → Authentication → URL Configuration**: set the Site URL and add
   `http://localhost:3000/auth/callback` (and your production
   `https://<domain>/auth/callback`) to the redirect allow-list.

### 4. Environment variables

Copy `.env.local.example` to `.env.local` and fill it in:

```bash
cp .env.local.example .env.local
```

| Variable | Notes |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Project API URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` (or the anon public key) |
| `ALLOWED_EMAILS` | **Server-only** comma-separated allow-list of Google emails |
| `NEXT_PUBLIC_SITE_URL` | e.g. `http://localhost:3000` |
| `NEXT_PUBLIC_LOCALE` | e.g. `de-DE` |
| `NEXT_PUBLIC_CURRENCY` | e.g. `EUR` |
| `NEXT_PUBLIC_TIMEZONE` | IANA tz for "today"/"current month" date math, e.g. `Europe/Berlin` |

> `ALLOWED_EMAILS` must **not** be prefixed with `NEXT_PUBLIC_` — it stays on the
> server so the allow-list is never shipped to the browser. It's enforced in the
> OAuth callback (`app/auth/callback/route.ts`) and the protected layout
> (`app/(app)/layout.tsx`), and should be kept **in sync with the `allowed_emails`
> table**, which is the database-level hard gate that blocks non-listed accounts.

### 5. Run

```bash
npm run dev
```

Open http://localhost:3000. Sign in with an allow-listed Google account, add a
spending, then set your income under the **Income** tab.

## Deploy (Vercel)

Import the repo into Vercel, set the same environment variables, and deploy. Then
update the Supabase redirect allow-list and (if you restrict them) the Google
authorized origins to include your production domain.

## Project map

```
app/
  (app)/            protected screens (auth guard + bottom nav)
    page.tsx        Add spending (home)
    overview/       Monthly overview (pie + day-grouped list)
    year/           Yearly overview (monthly bars + category breakdown)
    income/         Monthly income editor + sign out
    settings/       Categories, buckets & target-distribution editor
  login/            Google sign-in
  auth/callback/    OAuth code exchange + allow-list enforcement
proxy.ts            session refresh + soft redirect (Next 16 Proxy)
lib/                supabase clients, auth, categories, format, reports, actions
supabase/migrations/           schema, RLS, triggers, buckets, categories (0001 → 0005)
types/              hand-written DB types + view models
```

## Notes

- Editing a spending isn't in v1 — tap the trash icon on the monthly list to delete.
- The PWA is installable (manifest + icons + standalone); there's no offline mode.
- A Sankey chart is a planned future feature; Recharts (already used) supports it.
