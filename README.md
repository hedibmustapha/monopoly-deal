# Monopoly Deal — Private 2-Player

A private, real-time 2-player Monopoly Deal-style card game built for playing remotely with a partner.

## Current Status

**Playable multiplayer version**

The game currently supports:

- 2-player online rooms
- Create and join games using a room code/link
- Real-time game state synchronization
- Refresh/reconnect support
- Private player hands
- Draw and play cards
- Property sets and property wildcards
- Bank/money management
- Rent payments
- Double The Rent
- Pass Go
- House and Hotel
- Deal Breaker
- Sly Deal
- Forced Deal
- Debt Collector
- It's My Birthday
- Just Say No
- Turn and play tracking
- Card discard rules
- Completed property-set handling
- Rematch / Play Again
- Responsive card-table interface
- Vercel Web Analytics

The game is deployed on Vercel and uses Supabase for the multiplayer backend.

## Play Online

**[Play the game](https://monopoly-deal-psi.vercel.app/)**

No local installation is required to play the deployed version.

One player creates a room and shares the room code or link with the other player.

## Technology

- **Next.js 14**
- **React**
- **TypeScript**
- **Tailwind CSS**
- **Supabase**
  - PostgreSQL database
  - Realtime synchronization
  - Anonymous authentication
  - Row Level Security
  - Edge Functions
- **Vercel**
  - Hosting
  - Production deployments
  - Web Analytics
- **GitHub**
  - Source control

## Local Development

### 1. Install dependencies

    npm install

### 2. Configure Supabase

Create or use a Supabase project.

The application uses:

- Supabase Database
- Supabase Realtime
- Anonymous Authentication
- Supabase Edge Functions

Configure the required environment variables in `.env.local`:

    NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
    NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key

### 3. Run the development server

    npm run dev

Then open:

    http://localhost:3000

For local multiplayer testing, use two separate browser sessions, for example:

- Normal browser window
- Incognito/private window

This gives each player a separate anonymous Supabase session.

## Supabase Edge Function

The game engine uses the `game-actions` Supabase Edge Function for server-side game actions.

The function handles validated game actions and updates the shared game state.

When the Edge Function code is modified, deploy it with:

    supabase functions deploy game-actions

UI-only changes do not require redeploying the Edge Function.

## Project Structure

    src/
    ├── app/
    │   ├── page.tsx
    │   ├── room/
    │   │   └── [code]/
    │   │       └── page.tsx
    │   └── layout.tsx
    │
    ├── components/
    │   └── GameTable.tsx
    │
    └── lib/
        ├── deck.ts
        └── types.ts

    supabase/
    ├── functions/
    │   └── game-actions/
    │       ├── index.ts
    │       └── deck.ts
    │
    └── migrations/
        └── ...

## Game Architecture

The application is split into two main parts.

### Frontend

The Next.js application provides:

- Game table UI
- Player hands
- Cards
- Properties and banks
- Turn status
- Action prompts
- Payment selection
- Target selection
- Responsive layout

### Backend

Supabase provides:

- Game rooms
- Player identity
- Persistent game state
- Private hands
- Real-time synchronization
- Server-side game actions
- Row Level Security

Game actions are validated server-side rather than relying only on the browser.

## Privacy

Player hands are private.

A player's hand is stored separately from the publicly visible game state and protected by Supabase Row Level Security.

The application is designed so that a player does not receive the other player's private hand data.

## Deployment

The production application is hosted on Vercel.

The repository is connected to Vercel through GitHub.

A normal deployment workflow is:

    GitHub
       ↓
    Vercel
       ↓
    Next.js production application
       ↓
    Supabase
       ├── Database
       ├── Realtime
       └── game-actions Edge Function

### Deploying frontend changes

Push changes to the `main` branch:

    git add .
    git commit -m "Describe the change"
    git push origin main

Vercel can then build and deploy the frontend.

### Deploying Edge Function changes

If changes are made inside:

    supabase/functions/game-actions/

deploy the function separately:

    supabase functions deploy game-actions

## Important

The production application and Supabase project contain the live multiplayer game environment.

Avoid changing database schemas, RLS policies, or Edge Function logic without checking their impact on the existing game.

## Development Notes

This is a private 2-player project rather than a public commercial implementation.

The goal is to provide a convenient online card-table experience for two people playing remotely.