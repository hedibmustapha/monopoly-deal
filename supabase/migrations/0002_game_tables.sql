-- ============================================================================
-- Monopoly Deal — Stage 2/3 schema
-- Private hands, public boards (bank + properties), and the shared
-- game_state (draw/discard piles, turn order, phase).
-- ============================================================================

create table if not exists public.game_state (
  room_id                 uuid primary key references public.rooms(id) on delete cascade,
  draw_pile               jsonb not null default '[]',
  discard_pile            jsonb not null default '[]',
  current_seat            int not null default 0 check (current_seat in (0, 1)),
  cards_played_this_turn  int not null default 0,
  turn_phase              text not null default 'draw'
                            check (turn_phase in ('draw', 'play', 'discard')),
  winner_seat             int check (winner_seat in (0, 1)),
  updated_at              timestamptz not null default now()
);

create table if not exists public.hands (
  id          uuid primary key default gen_random_uuid(),
  room_id     uuid not null references public.rooms(id) on delete cascade,
  player_id   uuid not null references public.players(id) on delete cascade,
  cards       jsonb not null default '[]',
  updated_at  timestamptz not null default now(),
  unique (player_id)
);

create table if not exists public.boards (
  id          uuid primary key default gen_random_uuid(),
  room_id     uuid not null references public.rooms(id) on delete cascade,
  player_id   uuid not null references public.players(id) on delete cascade,
  bank        jsonb not null default '[]',
  -- properties: { [color]: { cards: Card[], house: boolean, hotel: boolean } }
  properties  jsonb not null default '{}',
  updated_at  timestamptz not null default now(),
  unique (player_id)
);

-- ----------------------------------------------------------------------------
-- RLS
-- game_state and boards hold nothing secret (the piles are counts/order only
-- in effect, never a specific player's concealed cards) so any room
-- participant can read them. hands is the one table that must never leak a
-- card to the other player, so its select policy checks ownership through
-- the players table.
-- ----------------------------------------------------------------------------

alter table public.game_state enable row level security;
alter table public.hands enable row level security;
alter table public.boards enable row level security;

create policy "read game state in your room"
  on public.game_state for select
  to authenticated
  using (
    exists (
      select 1 from public.players p
      where p.room_id = game_state.room_id and p.user_id = auth.uid()
    )
  );

create policy "read only your own hand"
  on public.hands for select
  to authenticated
  using (
    exists (
      select 1 from public.players p
      where p.id = hands.player_id and p.user_id = auth.uid()
    )
  );

create policy "read boards in your room"
  on public.boards for select
  to authenticated
  using (
    exists (
      select 1 from public.players p
      where p.room_id = boards.room_id and p.user_id = auth.uid()
    )
  );

-- No insert/update/delete policies for authenticated users on any of these
-- three tables: every mutation goes through the game-actions Edge Function,
-- which uses the service role key and enforces turn order/legality itself.
-- That's what stops a player from editing their own client to draw extra
-- cards, skip the opponent's turn, or write straight into their hand.

alter publication supabase_realtime add table public.game_state;
alter publication supabase_realtime add table public.hands;
alter publication supabase_realtime add table public.boards;
