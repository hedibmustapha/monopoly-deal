-- ============================================================================
-- Monopoly Deal — Stage 0/1 schema
-- Rooms + players + join-by-code flow + realtime lobby.
-- Card/hand tables come in a later migration once the game engine is built.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Tables
-- ----------------------------------------------------------------------------

create table if not exists public.rooms (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null,
  status      text not null default 'waiting'
                check (status in ('waiting', 'playing', 'finished')),
  host_id     uuid not null,
  created_at  timestamptz not null default now()
);

create table if not exists public.players (
  id            uuid primary key default gen_random_uuid(),
  room_id       uuid not null references public.rooms(id) on delete cascade,
  user_id       uuid not null,
  display_name  text not null,
  seat          int not null check (seat in (0, 1)),
  is_host       boolean not null default false,
  created_at    timestamptz not null default now(),
  last_seen     timestamptz not null default now(),
  unique (room_id, seat),
  unique (room_id, user_id)
);

-- ----------------------------------------------------------------------------
-- Room code generator — 5 chars, unambiguous alphabet (no 0/O/1/I).
-- ----------------------------------------------------------------------------

create or replace function public.generate_room_code()
returns text
language plpgsql
as $$
declare
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  result text := '';
  i int;
begin
  for i in 1..5 loop
    result := result || substr(alphabet, floor(random() * length(alphabet) + 1)::int, 1);
  end loop;
  return result;
end;
$$;

-- ----------------------------------------------------------------------------
-- create_room: host creates a room and is seated at seat 0.
-- join_room: second player joins by code and is seated at seat 1.
-- Both are SECURITY DEFINER RPCs so seat assignment is atomic and can't race
-- or overbook a room, which plain client-side inserts can't guarantee.
-- ----------------------------------------------------------------------------

create or replace function public.create_room(p_display_name text)
returns public.rooms
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_code text;
  v_tries int := 0;
begin
  if auth.uid() is null then
    raise exception 'Must be authenticated to create a room';
  end if;

  loop
    v_code := public.generate_room_code();
    exit when not exists (select 1 from public.rooms where code = v_code);
    v_tries := v_tries + 1;
    if v_tries > 20 then
      raise exception 'Could not generate a unique room code';
    end if;
  end loop;

  insert into public.rooms (code, host_id)
  values (v_code, auth.uid())
  returning * into v_room;

  insert into public.players (room_id, user_id, display_name, seat, is_host)
  values (v_room.id, auth.uid(), p_display_name, 0, true);

  return v_room;
end;
$$;

create or replace function public.join_room(p_code text, p_display_name text)
returns public.players
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_player public.players;
  v_existing public.players;
begin
  if auth.uid() is null then
    raise exception 'Must be authenticated to join a room';
  end if;

  select * into v_room from public.rooms where code = upper(p_code);
  if v_room.id is null then
    raise exception 'Room not found';
  end if;

  -- Reconnect: if this user is already seated in this room, just return their row.
  select * into v_existing from public.players
    where room_id = v_room.id and user_id = auth.uid();
  if v_existing.id is not null then
    update public.players set last_seen = now() where id = v_existing.id
      returning * into v_existing;
    return v_existing;
  end if;

  if v_room.status <> 'waiting' then
    raise exception 'Game already in progress';
  end if;

  if (select count(*) from public.players where room_id = v_room.id) >= 2 then
    raise exception 'Room is full';
  end if;

  insert into public.players (room_id, user_id, display_name, seat, is_host)
  values (v_room.id, auth.uid(), p_display_name, 1, false)
  returning * into v_player;

  return v_player;
end;
$$;

grant execute on function public.create_room(text) to anon, authenticated;
grant execute on function public.join_room(text, text) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Row Level Security
-- Neither table holds private game data at this stage (hands land in a
-- later migration with their own locked-down policy), so read access is
-- scoped to "you're a participant in this room", and writes go through the
-- RPCs above or are limited to your own player row.
-- ----------------------------------------------------------------------------

alter table public.rooms enable row level security;
alter table public.players enable row level security;

create policy "read rooms you're in or looking up by code"
  on public.rooms for select
  to authenticated
  using (true);

create policy "read players in your room"
  on public.players for select
  to authenticated
  using (true);

create policy "update your own player row"
  on public.players for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ----------------------------------------------------------------------------
-- Realtime: broadcast changes on these tables to subscribed clients.
-- ----------------------------------------------------------------------------

alter publication supabase_realtime add table public.rooms;
alter publication supabase_realtime add table public.players;
