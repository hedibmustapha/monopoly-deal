# Monopoly Deal (private 2-player)

## Status

**Stage 0 + 1 complete:** project scaffold, room creation, shareable join
link/code, and a live lobby showing both players connect in real time
(refresh-proof — reconnecting re-seats you automatically).

**Not built yet:** the actual card game (deck, hands, turns, action cards).
That's Stages 2–8 of the plan — this scaffold is the foundation they get
built on top of.

## One-time setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create a Supabase project

1. Go to [supabase.com](https://supabase.com) → New project (free tier is
   plenty). Save the database password somewhere.
2. In **Project Settings → API**, copy the **Project URL** and the
   **anon public** key.
3. In **Authentication → Sign In / Providers**, enable **Anonymous
   sign-ins**. This is what gives each of you a stable identity for the
   room/lobby (and later, for keeping your hand private) without needing
   to make accounts.

### 3. Run the migration

In the Supabase dashboard, open **SQL Editor**, paste the contents of
`supabase/migrations/0001_init.sql`, and run it. (If you'd rather use the
Supabase CLI: `supabase link` then `supabase db push`.)

### 4. Configure environment variables

```bash
cp .env.local.example .env.local
```

Fill in `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` with
the values from step 2.

### 5. Run it locally

```bash
npm run dev
```

Open two browser windows (or one normal + one incognito, so you get two
separate anonymous sessions) at `http://localhost:3000` to try the
create/join flow against yourself before testing with your partner.

## Deploying (free)

1. Push this project to a GitHub repo.
2. Go to [vercel.com](https://vercel.com) → New Project → import the repo.
3. In the Vercel project's environment variables, add the same two
   `NEXT_PUBLIC_SUPABASE_*` values from your `.env.local`.
4. Deploy. You'll get a URL like `your-app.vercel.app` — that's what you
   share with your partner going forward instead of localhost.

## Project layout

```
supabase/migrations/   SQL schema, RLS policies, and RPCs (source of truth
                        for the database — run new files here as we add
                        the game engine)
src/lib/supabase/       Browser Supabase client + anonymous-auth helper
src/lib/types.ts        Shared TypeScript types
src/app/page.tsx         Home: create or join a room
src/app/room/[code]/     Lobby: shareable link, live player presence
```

## How privacy will work once hands exist

Right now there's no private data yet — room codes and display names are
visible to anyone who's a participant, which is fine. When Stage 3 adds
hands, they'll live in their own table with a Row Level Security policy
restricting `select` to `user_id = auth.uid()`, so your partner's browser
never receives your hand's data over the network at all, not even hidden
in a payload.
