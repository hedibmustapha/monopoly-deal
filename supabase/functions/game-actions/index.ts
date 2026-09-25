// Deno Edge Function — one endpoint, routed by `action` in the JSON body.
// This is the only thing allowed to write to hands/boards/game_state: it
// uses the service role key to bypass RLS for those writes, but every
// action first re-derives who's calling from their own auth JWT and checks
// turn order/legality server-side, so a modified client can't draw extra
// cards, act out of turn, or write into a hand it doesn't own.

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  buildFullDeck,
  shuffle,
  RENTS,
  SET_SIZE,
  COLOR_LABEL,
  NO_BUILDING_COLORS,
  type Card,
  type PropertyColor,
} from "./deck.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

interface Player {
  id: string;
  room_id: string;
  user_id: string;
  seat: 0 | 1;
}
interface Room {
  id: string;
  status: string;
}

type ContestEffect = "rent" | "debt_collector" | "birthday" | "sly_deal" | "forced_deal" | "deal_breaker";

interface RentPayload {
  color: PropertyColor;
  amount: number;
}
interface FlatPayload {
  amount: number;
}
interface SlyDealPayload {
  target_color: PropertyColor;
  target_card_id: string;
  target_group_key?: string;
}
interface ForcedDealPayload {
  target_color: PropertyColor;
  target_card_id: string;
  target_group_key?: string;
  offer_color: PropertyColor;
  offer_card_id: string;
  offer_group_key?: string;
}
interface DealBreakerPayload {
  target_color: PropertyColor;
  target_group_key?: string;
}
type ContestPayload = RentPayload | FlatPayload | SlyDealPayload | ForcedDealPayload | DealBreakerPayload;

interface ActionPending {
  type: "action_pending";
  effect: ContestEffect;
  from_seat: 0 | 1; // who played the card / stands to benefit
  to_seat: 0 | 1; // whose stuff/money is targeted, and who responds first
  turn_seat: 0 | 1; // whose move it is right now in the Just Say No exchange
  cancelled: boolean; // true if an odd number of Just Say Nos have been played
  jsn_count: number;
  reason: string;
  payload: ContestPayload;
}
interface PaymentDemand {
  type: "payment_demand";
  from_seat: 0 | 1;
  to_seat: 0 | 1;
  amount: number;
  reason: string;
}
type PendingAction = ActionPending | PaymentDemand;

interface GameState {
  room_id: string;
  draw_pile: Card[];
  discard_pile: Card[];
  current_seat: 0 | 1;
  cards_played_this_turn: number;
  turn_phase: "draw" | "play" | "discard";
  winner_seat: number | null;
  pending_action: PendingAction | null;
}
interface PropertyGroup {
  cards: Card[];
  house: boolean;
  hotel: boolean;
}
type BoardProperties = Record<string, PropertyGroup>;
interface Board {
  player_id: string;
  bank: Card[];
  properties: BoardProperties;
}

class HttpError extends Error {
  constructor(public status: number, message: string, public cause?: unknown) {
    super(message);
  }
}

async function authenticate(req: Request) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace("Bearer ", "");
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "Not authenticated");
  return data.user.id;
}

async function getRoomAndPlayers(roomId: string) {
  const { data: room, error: roomErr } = await admin
    .from("rooms")
    .select("*")
    .eq("id", roomId)
    .single<Room>();
  if (roomErr || !room) throw new HttpError(404, "Room not found");

  const { data: players, error: playersErr } = await admin
    .from("players")
    .select("*")
    .eq("room_id", roomId);
  if (playersErr || !players) {
    console.error("[getRoomAndPlayers] players query failed", playersErr);
    throw new HttpError(500, playersErr?.message ?? "Could not load players", playersErr);
  }

  return { room, players: players as Player[] };
}

function drawFromPile(state: GameState, count: number): Card[] {
  const drawn: Card[] = [];
  while (drawn.length < count) {
    if (state.draw_pile.length === 0) {
      if (state.discard_pile.length === 0) break; // deck fully exhausted
      state.draw_pile = shuffle(state.discard_pile);
      state.discard_pile = [];
    }
    const card = state.draw_pile.shift();
    if (!card) break;
    drawn.push(card);
  }
  return drawn;
}

async function handleStartGame(userId: string, roomId: string) {
  console.log(`[start_game] called room=${roomId} user=${userId}`);
  const { room, players } = await getRoomAndPlayers(roomId);
  if (room.status !== "waiting") throw new HttpError(400, "Game already started");
  if (players.length !== 2) throw new HttpError(400, "Need 2 players to start");
  const caller = players.find((p) => p.user_id === userId);
  if (!caller) throw new HttpError(403, "You're not in this room");
  console.log(`[start_game] room+players ok, seats=${players.map((p) => p.seat).join(",")}`);

  await dealFreshGame(roomId, players, "start_game");

  const { error: roomErr } = await admin.from("rooms").update({ status: "playing" }).eq("id", roomId);
  if (roomErr) {
    console.error(`[start_game] room status update failed`, roomErr);
    throw new HttpError(500, `room status update failed: ${roomErr.message}`, roomErr);
  }
  console.log(`[start_game] room marked playing — done`);

  return { ok: true };
}

async function dealFreshGame(roomId: string, players: Player[], logTag: string) {
  const deck = shuffle(buildFullDeck());
  console.log(`[${logTag}] deck built, size=${deck.length}`);
  const hands: Record<string, Card[]> = {};
  for (const p of players) {
    hands[p.id] = deck.splice(0, 5);
  }

  for (const p of players) {
    const { error } = await admin
      .from("hands")
      .upsert({ room_id: roomId, player_id: p.id, cards: hands[p.id] }, { onConflict: "player_id" });
    if (error) {
      console.error(`[${logTag}] hands upsert failed for player=${p.id}`, error);
      throw new HttpError(500, `hands upsert failed: ${error.message}`, error);
    }
    console.log(`[${logTag}] hand dealt for player=${p.id}`);

    const { error: boardErr } = await admin
      .from("boards")
      .upsert(
        { room_id: roomId, player_id: p.id, bank: [], properties: {} },
        { onConflict: "player_id" }
      );
    if (boardErr) {
      console.error(`[${logTag}] boards upsert failed for player=${p.id}`, boardErr);
      throw new HttpError(500, `boards upsert failed: ${boardErr.message}`, boardErr);
    }
    console.log(`[${logTag}] board initialized for player=${p.id}`);
  }

  const { error: stateErr } = await admin.from("game_state").upsert({
    room_id: roomId,
    draw_pile: deck,
    discard_pile: [],
    current_seat: 0,
    cards_played_this_turn: 0,
    turn_phase: "draw",
    winner_seat: null,
    pending_action: null,
  });
  if (stateErr) {
    console.error(`[${logTag}] game_state upsert failed`, stateErr);
    throw new HttpError(500, `game_state upsert failed: ${stateErr.message}`, stateErr);
  }
  console.log(`[${logTag}] game_state written, draw_pile=${deck.length}`);
}

async function handleRematch(userId: string, roomId: string) {
  console.log(`[rematch] called room=${roomId} user=${userId}`);
  const { room, players } = await getRoomAndPlayers(roomId);
  if (players.length !== 2) throw new HttpError(400, "Need 2 players to start a rematch");
  const caller = players.find((p) => p.user_id === userId);
  if (!caller) throw new HttpError(403, "You're not in this room");
  if (room.status === "waiting") {
    throw new HttpError(400, "Start the first game before rematching");
  }

  await dealFreshGame(roomId, players, "rematch");
  console.log(`[rematch] done`);
  return { ok: true };
}

async function loadTurnContext(userId: string, roomId: string) {
  const { players } = await getRoomAndPlayers(roomId);
  const caller = players.find((p) => p.user_id === userId);
  if (!caller) throw new HttpError(403, "You're not in this room");
  const opponent = players.find((p) => p.id !== caller.id);
  if (!opponent) throw new HttpError(400, "Waiting for the second player");

  const { data: state, error: stateErr } = await admin
    .from("game_state")
    .select("*")
    .eq("room_id", roomId)
    .single<GameState>();
  if (stateErr || !state) throw new HttpError(400, "Game hasn't started");

  const { data: hand, error: handErr } = await admin
    .from("hands")
    .select("*")
    .eq("player_id", caller.id)
    .single<{ cards: Card[] }>();
  if (handErr || !hand) throw new HttpError(500, "Could not load hand");

  return { caller, opponent, players, state, hand: hand.cards };
}

function assertGameActive(state: GameState) {
  if (state.winner_seat !== null) throw new HttpError(400, "The game is already over");
}

function assertCanPlay(state: GameState, caller: Player, cardsToUse = 1) {
  assertGameActive(state);
  if (state.pending_action) throw new HttpError(400, "Resolve the pending action first");
  if (state.current_seat !== caller.seat) throw new HttpError(400, "Not your turn");
  if (state.turn_phase !== "play") throw new HttpError(400, "Draw first");
  if (state.cards_played_this_turn + cardsToUse > 3) {
    throw new HttpError(400, "Not enough plays left this turn");
  }
}

async function loadBoard(playerId: string): Promise<Board> {
  const { data, error } = await admin
    .from("boards")
    .select("*")
    .eq("player_id", playerId)
    .single<Board>();
  if (error || !data) throw new HttpError(500, "Could not load board", error);
  return data;
}

async function saveBoard(playerId: string, patch: Partial<Pick<Board, "bank" | "properties">>) {
  const { error } = await admin.from("boards").update(patch).eq("player_id", playerId);
  if (error) throw new HttpError(500, "Could not save board", error);
}

function boardValue(board: Board): number {
  const bankValue = board.bank.reduce((sum, c) => sum + c.value, 0);
  const propValue = Object.values(board.properties).reduce(
    (sum, g) => sum + g.cards.reduce((s, c) => s + c.value, 0),
    0
  );
  return bankValue + propValue;
}

function isComplete(group: PropertyGroup | undefined, color: PropertyColor): boolean {
  return (group?.cards.length ?? 0) >= SET_SIZE[color];
}

// A board may contain more than one group of the same color. The first
// incomplete group is filled until it is complete; any property played after
// that starts a new group instead of extending the completed set. Group keys
// are persisted as `color` for the first group and `color::N` thereafter.
function groupColor(key: string): PropertyColor {
  return key.split("::")[0] as PropertyColor;
}

function groupEntries(board: Board, color: PropertyColor) {
  return Object.entries(board.properties).filter(([key]) => groupColor(key) === color);
}

function findGroupForCard(board: Board, color: PropertyColor, cardId: string) {
  return groupEntries(board, color).find(([, g]) => g.cards.some((c) => c.id === cardId));
}

function findEligibleIncompleteGroup(board: Board, color: PropertyColor) {
  return groupEntries(board, color).find(([, g]) => g.cards.length < SET_SIZE[color]);
}

function newGroupKey(board: Board, color: PropertyColor) {
  if (!board.properties[color]) return color;
  let n = 2;
  while (board.properties[`${color}::${n}`]) n++;
  return `${color}::${n}`;
}

function addPropertyToGroup(board: Board, color: PropertyColor, card: Card) {
  const existing = findEligibleIncompleteGroup(board, color);
  const key = existing?.[0] ?? newGroupKey(board, color);
  const base = existing?.[1] ?? { cards: [], house: false, hotel: false };
  return {
    ...board.properties,
    [key]: { ...base, cards: [...base.cards, card] },
  };
}

function completeSetCount(board: Board) {
  return Object.entries(board.properties).filter(([key, g]) => isComplete(g, groupColor(key))).length;
}

async function removeFromHandAndDiscard(
  playerId: string,
  hand: Card[],
  discardPile: Card[],
  cardIds: string[]
) {
  const removed: Card[] = [];
  const newHand = hand.filter((c) => {
    if (cardIds.includes(c.id)) {
      removed.push(c);
      return false;
    }
    return true;
  });
  if (removed.length !== cardIds.length) {
    throw new HttpError(404, "Card not in hand");
  }
  await admin.from("hands").update({ cards: newHand }).eq("player_id", playerId);
  return [...discardPile, ...removed];
}

async function checkWinAndMaybeSet(roomId: string, player: Player) {
  const board = await loadBoard(player.id);
  const completeSets = completeSetCount(board);
  if (completeSets >= 3) {
    await admin.from("game_state").update({ winner_seat: player.seat }).eq("room_id", roomId);
  }
}

// ----------------------------------------------------------------------------
// Draw / bank / property / discard / end turn (Stage 2-3)
// ----------------------------------------------------------------------------

async function handleDraw(userId: string, roomId: string) {
  const { caller, state, hand } = await loadTurnContext(userId, roomId);
  assertGameActive(state);
  if (state.pending_action) throw new HttpError(400, "Resolve the pending action first");
  if (state.current_seat !== caller.seat) throw new HttpError(400, "Not your turn");
  if (state.turn_phase !== "draw") throw new HttpError(400, "Already drawn this turn");

  const count = hand.length === 0 ? 5 : 2;
  const drawn = drawFromPile(state, count);
  const newHand = [...hand, ...drawn];

  await admin.from("hands").update({ cards: newHand }).eq("player_id", caller.id);
  await admin
    .from("game_state")
    .update({
      draw_pile: state.draw_pile,
      discard_pile: state.discard_pile,
      turn_phase: "play",
    })
    .eq("room_id", roomId);

  return { ok: true, drawn: drawn.length };
}

async function handlePlayMoney(userId: string, roomId: string, cardId: string) {
  const { caller, state, hand } = await loadTurnContext(userId, roomId);
  assertCanPlay(state, caller, 1);

  const card = hand.find((c) => c.id === cardId);
  if (!card) throw new HttpError(404, "Card not in hand");
  if (card.kind !== "money" && card.kind !== "action") {
    throw new HttpError(400, "Only money and action cards can be banked");
  }

  const newHand = hand.filter((c) => c.id !== cardId);
  const board = await loadBoard(caller.id);
  const newBank = [...board.bank, card];

  await admin.from("hands").update({ cards: newHand }).eq("player_id", caller.id);
  await saveBoard(caller.id, { bank: newBank });
  await admin
    .from("game_state")
    .update({ cards_played_this_turn: state.cards_played_this_turn + 1 })
    .eq("room_id", roomId);

  return { ok: true };
}

async function handlePlayProperty(userId: string, roomId: string, cardId: string, color: string) {
  const { caller, state, hand } = await loadTurnContext(userId, roomId);
  assertCanPlay(state, caller, 1);

  const card = hand.find((c) => c.id === cardId);
  if (!card) throw new HttpError(404, "Card not in hand");
  if (card.kind !== "property" && card.kind !== "wildcard") {
    throw new HttpError(400, "Not a property card");
  }
  if (card.kind === "property" && card.color !== color) {
    throw new HttpError(400, "Color mismatch");
  }
  if (card.kind === "wildcard" && !card.colors.includes(color as never) && card.colors.length <= 2) {
    throw new HttpError(400, "This wildcard can't be that color");
  }

  const newHand = hand.filter((c) => c.id !== cardId);
  const board = await loadBoard(caller.id);
  const properties = addPropertyToGroup(board, color as PropertyColor, card);

  await admin.from("hands").update({ cards: newHand }).eq("player_id", caller.id);
  await saveBoard(caller.id, { properties });
  await admin
    .from("game_state")
    .update({ cards_played_this_turn: state.cards_played_this_turn + 1 })
    .eq("room_id", roomId);

  await checkWinAndMaybeSet(roomId, caller);

  return { ok: true };
}

async function handleDiscard(userId: string, roomId: string, cardId: string) {
  const { caller, state, hand } = await loadTurnContext(userId, roomId);
  assertGameActive(state);
  if (state.pending_action) throw new HttpError(400, "Resolve the pending action first");
  if (state.current_seat !== caller.seat || state.turn_phase !== "discard") {
    throw new HttpError(400, "Discard is only available at the end of your turn");
  }
  if (hand.length <= 7) throw new HttpError(400, "You don't need to discard");
  const card = hand.find((c) => c.id === cardId);
  if (!card) throw new HttpError(404, "Card not in hand");

  const newHand = hand.filter((c) => c.id !== cardId);
  const newDiscard = [...state.discard_pile, card];

  await admin.from("hands").update({ cards: newHand }).eq("player_id", caller.id);
  if (newHand.length <= 7) {
    await admin.from("game_state").update({
      discard_pile: newDiscard,
      current_seat: caller.seat === 0 ? 1 : 0,
      cards_played_this_turn: 0,
      turn_phase: "draw",
    }).eq("room_id", roomId);
  } else {
    await admin.from("game_state").update({ discard_pile: newDiscard }).eq("room_id", roomId);
  }

  return { ok: true };
}

async function handleEndTurn(userId: string, roomId: string) {
  const { caller, state, hand } = await loadTurnContext(userId, roomId);
  assertGameActive(state);
  if (state.pending_action) throw new HttpError(400, "Resolve the pending action first");
  if (state.current_seat !== caller.seat) throw new HttpError(400, "Not your turn");
  if (state.turn_phase !== "play") throw new HttpError(400, "Draw first");
  // The discard phase is only entered after all 3 plays have been used.
  // Having more than 7 cards earlier in the turn is not enough to end the turn.
  if (hand.length > 7) {
    if (state.cards_played_this_turn < 3) {
      const remaining = 3 - state.cards_played_this_turn;
      throw new HttpError(400, `You have more than 7 cards and still have ${remaining} play${remaining === 1 ? "" : "s"} remaining. Use all 3 plays before ending your turn.`);
    }
    await admin.from("game_state").update({ turn_phase: "discard" }).eq("room_id", roomId);
    return { ok: true, needs_discard: true };
  }

  await admin
    .from("game_state")
    .update({
      current_seat: caller.seat === 0 ? 1 : 0,
      cards_played_this_turn: 0,
      turn_phase: "draw",
    })
    .eq("room_id", roomId);

  return { ok: true };
}

async function handlePassGo(userId: string, roomId: string, cardId: string) {
  const { caller, state, hand } = await loadTurnContext(userId, roomId);
  assertCanPlay(state, caller, 1);

  const card = hand.find((c) => c.id === cardId);
  if (!card || card.kind !== "action" || card.action !== "pass_go") {
    throw new HttpError(404, "Pass Go card not in hand");
  }

  const newDiscard = await removeFromHandAndDiscard(caller.id, hand, state.discard_pile, [cardId]);
  const handAfterDiscard = hand.filter((c) => c.id !== cardId);

  const freshState = { ...state, discard_pile: newDiscard };
  const drawn = drawFromPile(freshState, 2);
  const newHand = [...handAfterDiscard, ...drawn];

  await admin.from("hands").update({ cards: newHand }).eq("player_id", caller.id);
  await admin
    .from("game_state")
    .update({
      draw_pile: freshState.draw_pile,
      discard_pile: freshState.discard_pile,
      cards_played_this_turn: state.cards_played_this_turn + 1,
    })
    .eq("room_id", roomId);

  return { ok: true };
}

async function handleBuild(
  userId: string,
  roomId: string,
  cardId: string,
  color: PropertyColor,
  kind: "house" | "hotel",
  groupKey?: string
) {
  const { caller, state, hand } = await loadTurnContext(userId, roomId);
  assertCanPlay(state, caller, 1);

  if (NO_BUILDING_COLORS.includes(color)) {
    throw new HttpError(400, `Can't build on ${COLOR_LABEL[color]}`);
  }
  const card = hand.find((c) => c.id === cardId);
  if (!card || card.kind !== "action" || card.action !== kind) {
    throw new HttpError(404, `${kind === "house" ? "House" : "Hotel"} card not in hand`);
  }

  const board = await loadBoard(caller.id);
  const groupEntry = groupKey
    ? [groupKey, board.properties[groupKey]] as const
    : groupEntries(board, color).find(([, g]) => isComplete(g, color) && (kind === "house" ? !g.house : g.house && !g.hotel));
  const group = groupEntry?.[1];
  const selectedGroupKey = groupEntry?.[0];
  if (!group || !selectedGroupKey) throw new HttpError(400, "That set isn't available for this building card");
  if (groupColor(selectedGroupKey) !== color) throw new HttpError(400, "That property set has the wrong color");
  if (!isComplete(group, color)) throw new HttpError(400, "That set isn't complete yet");
  if (kind === "house" && group.house) throw new HttpError(400, "Already has a house");
  if (kind === "hotel") {
    if (!group.house) throw new HttpError(400, "Add a House first");
    if (group.hotel) throw new HttpError(400, "Already has a hotel");
  }

  const updated: PropertyGroup = { ...group, [kind]: true } as PropertyGroup;
  await saveBoard(caller.id, { properties: { ...board.properties, [selectedGroupKey!]: updated } });

  const newDiscard = await removeFromHandAndDiscard(caller.id, hand, state.discard_pile, [cardId]);
  await admin
    .from("game_state")
    .update({ discard_pile: newDiscard, cards_played_this_turn: state.cards_played_this_turn + 1 })
    .eq("room_id", roomId);

  return { ok: true };
}

// ----------------------------------------------------------------------------
// Stage 5: contestable actions (rent, debt collector, birthday, sly deal,
// forced deal, deal breaker). Playing one of these doesn't apply it right
// away — it *proposes* it. The target gets first right of response: play a
// Just Say No (if they have one) to cancel it, or let it stand. Each Just
// Say No flips who responds next and toggles whether the action is
// currently cancelled, so it can go back and forth for as long as both
// sides keep holding Just Say No cards (there are only 3 in the deck, so
// this naturally terminates). Whoever's turn it is to respond gets
// auto-skipped straight to resolution if they don't hold a Just Say No —
// no pointless extra click when they couldn't counter anyway.
// ----------------------------------------------------------------------------

async function proposeAction(
  roomId: string,
  caller: Player,
  opponent: Player,
  effect: ContestEffect,
  payload: ContestPayload,
  reason: string
) {
  const pending: ActionPending = {
    type: "action_pending",
    effect,
    from_seat: caller.seat,
    to_seat: opponent.seat,
    turn_seat: opponent.seat,
    cancelled: false,
    jsn_count: 0,
    reason,
    payload,
  };
  const { error } = await admin.from("game_state").update({ pending_action: pending }).eq("room_id", roomId);
  if (error) throw new HttpError(500, "Could not propose action", error);
  await maybeAutoResolve(roomId);
}

async function maybeAutoResolve(roomId: string) {
  const { data: state } = await admin
    .from("game_state")
    .select("*")
    .eq("room_id", roomId)
    .single<GameState>();
  if (!state?.pending_action || state.pending_action.type !== "action_pending") return;
  const pending = state.pending_action;

  const { players } = await getRoomAndPlayers(roomId);
  const responder = players.find((p) => p.seat === pending.turn_seat);
  if (!responder) return;

  const { data: handRow } = await admin
    .from("hands")
    .select("cards")
    .eq("player_id", responder.id)
    .single<{ cards: Card[] }>();
  const hasJustSayNo = (handRow?.cards ?? []).some((c) => c.kind === "action" && c.action === "just_say_no");
  if (!hasJustSayNo) {
    await finalizeResolution(roomId, players, pending);
  }
}

async function finalizeResolution(roomId: string, players: Player[], pending: ActionPending) {
  if (pending.cancelled) {
    await admin.from("game_state").update({ pending_action: null }).eq("room_id", roomId);
    return;
  }
  await executeEffect(roomId, players, pending);
}

async function executeEffect(roomId: string, players: Player[], pending: ActionPending) {
  const fromPlayer = players.find((p) => p.seat === pending.from_seat)!;
  const toPlayer = players.find((p) => p.seat === pending.to_seat)!;

  if (pending.effect === "rent" || pending.effect === "debt_collector" || pending.effect === "birthday") {
    const { amount } = pending.payload as FlatPayload;
    const targetBoard = await loadBoard(toPlayer.id);
    if (boardValue(targetBoard) === 0) {
      await admin.from("game_state").update({ pending_action: null }).eq("room_id", roomId);
      return;
    }
    const demand: PaymentDemand = {
      type: "payment_demand",
      from_seat: pending.from_seat,
      to_seat: pending.to_seat,
      amount,
      reason: pending.reason,
    };
    await admin.from("game_state").update({ pending_action: demand }).eq("room_id", roomId);
    return;
  }

  if (pending.effect === "sly_deal") {
    const { target_color, target_card_id, target_group_key } = pending.payload as SlyDealPayload;
    const oppBoard = await loadBoard(toPlayer.id);
    const entry = target_group_key ? [target_group_key, oppBoard.properties[target_group_key]] as const : findGroupForCard(oppBoard, target_color, target_card_id);
    const oppGroup = entry?.[1];
    const targetKey = entry?.[0];
    const targetCard = oppGroup?.cards.find((c) => c.id === target_card_id);
    if (targetCard && targetKey && !isComplete(oppGroup, target_color)) {
      const remaining = oppGroup.cards.filter((c) => c.id !== target_card_id);
      const nextOpp = { ...oppBoard.properties };
      if (remaining.length) nextOpp[targetKey] = { ...oppGroup, cards: remaining, house: false, hotel: false };
      else delete nextOpp[targetKey];
      await saveBoard(toPlayer.id, { properties: nextOpp });

      const callerBoard = await loadBoard(fromPlayer.id);
      await saveBoard(fromPlayer.id, { properties: addPropertyToGroup(callerBoard, target_color, targetCard) });
      await checkWinAndMaybeSet(roomId, fromPlayer);
    }
    await admin.from("game_state").update({ pending_action: null }).eq("room_id", roomId);
    return;
  }

  if (pending.effect === "forced_deal") {
    const { target_color, target_card_id, target_group_key, offer_color, offer_card_id, offer_group_key } = pending.payload as ForcedDealPayload;
    const callerBoard = await loadBoard(fromPlayer.id);
    const oppBoard = await loadBoard(toPlayer.id);
    const offerEntry = offer_group_key ? [offer_group_key, callerBoard.properties[offer_group_key]] as const : findGroupForCard(callerBoard, offer_color, offer_card_id);
    const targetEntry = target_group_key ? [target_group_key, oppBoard.properties[target_group_key]] as const : findGroupForCard(oppBoard, target_color, target_card_id);
    const callerGroup = offerEntry?.[1];
    const oppGroup = targetEntry?.[1];
    const offerKey = offerEntry?.[0];
    const targetKey = targetEntry?.[0];
    const offerCard = callerGroup?.cards.find((c) => c.id === offer_card_id);
    const targetCard = oppGroup?.cards.find((c) => c.id === target_card_id);

    if (offerCard && targetCard && offerKey && targetKey && !isComplete(callerGroup, offer_color) && !isComplete(oppGroup, target_color)) {
      const newCaller = { ...callerBoard.properties };
      const remainingOffer = callerGroup.cards.filter((c) => c.id !== offer_card_id);
      if (remainingOffer.length) newCaller[offerKey] = { ...callerGroup, cards: remainingOffer, house: false, hotel: false };
      else delete newCaller[offerKey];
      const newOpp = { ...oppBoard.properties };
      const remainingTarget = oppGroup.cards.filter((c) => c.id !== target_card_id);
      if (remainingTarget.length) newOpp[targetKey] = { ...oppGroup, cards: remainingTarget, house: false, hotel: false };
      else delete newOpp[targetKey];
      const callerAfter = { ...callerBoard, properties: newCaller };
      const oppAfter = { ...oppBoard, properties: newOpp };
      await saveBoard(fromPlayer.id, { properties: addPropertyToGroup(callerAfter, target_color, targetCard) });
      await saveBoard(toPlayer.id, { properties: addPropertyToGroup(oppAfter, offer_color, offerCard) });
      await checkWinAndMaybeSet(roomId, fromPlayer);
      await checkWinAndMaybeSet(roomId, toPlayer);
    }
    await admin.from("game_state").update({ pending_action: null }).eq("room_id", roomId);
    return;
  }

  if (pending.effect === "deal_breaker") {
    const { target_color, target_group_key } = pending.payload as DealBreakerPayload;
    const oppBoard = await loadBoard(toPlayer.id);
    const entry = target_group_key ? [target_group_key, oppBoard.properties[target_group_key]] as const : groupEntries(oppBoard, target_color).find(([, g]) => isComplete(g, target_color));
    const oppGroup = entry?.[1];
    const targetKey = entry?.[0];
    if (oppGroup && targetKey && isComplete(oppGroup, target_color)) {
      const oppProperties = { ...oppBoard.properties };
      delete oppProperties[targetKey];
      await saveBoard(toPlayer.id, { properties: oppProperties });

      const callerBoard = await loadBoard(fromPlayer.id);
      const callerProperties = { ...callerBoard.properties };
      // Deal Breaker transfers a complete set. Keep that complete set intact
      // as its own group even if the recipient already owns an incomplete or
      // completed group of the same color. Never overfill a completed set.
      callerProperties[newGroupKey(callerBoard, target_color)] = {
        cards: [...oppGroup.cards],
        house: oppGroup.house,
        hotel: oppGroup.hotel,
      };
      await saveBoard(fromPlayer.id, { properties: callerProperties });
      await checkWinAndMaybeSet(roomId, fromPlayer);
    }
    await admin.from("game_state").update({ pending_action: null }).eq("room_id", roomId);
    return;
  }
}

async function handlePlayRent(
  userId: string,
  roomId: string,
  cardId: string,
  color: PropertyColor,
  doubleCardIds?: string[]
) {
  const { caller, opponent, state, hand } = await loadTurnContext(userId, roomId);
  const doubles = (doubleCardIds ?? []).slice(0, 2);
  const cardsToUse = 1 + doubles.length;
  assertCanPlay(state, caller, cardsToUse);

  const card = hand.find((c) => c.id === cardId);
  if (!card || card.kind !== "action" || (card.action !== "rent" && card.action !== "rent_wild")) {
    throw new HttpError(404, "Rent card not in hand");
  }
  if (card.action === "rent" && card.rentColors && !card.rentColors.includes(color)) {
    throw new HttpError(400, "This rent card doesn't cover that color");
  }

  const uniqueDoubles = new Set(doubles);
  if (uniqueDoubles.size !== doubles.length) throw new HttpError(400, "Duplicate Double The Rent card");
  for (const id of doubles) {
    const d = hand.find((c) => c.id === id);
    if (!d || d.kind !== "action" || d.action !== "double_rent") {
      throw new HttpError(404, "Double The Rent card not in hand");
    }
  }

  const board = await loadBoard(caller.id);
  const groupEntry = groupEntries(board, color).filter(([, g]) => g.cards.length > 0).sort((a, b) => b[1].cards.length - a[1].cards.length)[0];
  const group = groupEntry?.[1];
  const count = group?.cards.length ?? 0;
  if (count === 0) throw new HttpError(400, `You don't own any ${COLOR_LABEL[color]} properties`);

  const tier = Math.min(count, SET_SIZE[color]) - 1;
  const base = RENTS[color][tier] + (group?.house ? 3 : 0) + (group?.hotel ? 4 : 0);
  const amount = base * Math.pow(2, doubles.length); // 1x, 2x, or 4x

  const cardIds = [cardId, ...doubles];
  const newDiscard = await removeFromHandAndDiscard(caller.id, hand, state.discard_pile, cardIds);

  await admin
    .from("game_state")
    .update({
      discard_pile: newDiscard,
      cards_played_this_turn: state.cards_played_this_turn + cardsToUse,
    })
    .eq("room_id", roomId);

  await proposeAction(roomId, caller, opponent, "rent", { color, amount }, `Rent (${COLOR_LABEL[color]}) — ${amount}M`);

  return { ok: true, amount };
}

async function handleSimpleDemand(
  userId: string,
  roomId: string,
  cardId: string,
  expectedAction: "debt_collector" | "birthday",
  amount: number,
  reason: string
) {
  const { caller, opponent, state, hand } = await loadTurnContext(userId, roomId);
  assertCanPlay(state, caller, 1);

  const card = hand.find((c) => c.id === cardId);
  if (!card || card.kind !== "action" || card.action !== expectedAction) {
    throw new HttpError(404, "Card not in hand");
  }

  const newDiscard = await removeFromHandAndDiscard(caller.id, hand, state.discard_pile, [cardId]);
  await admin
    .from("game_state")
    .update({ discard_pile: newDiscard, cards_played_this_turn: state.cards_played_this_turn + 1 })
    .eq("room_id", roomId);

  await proposeAction(roomId, caller, opponent, expectedAction, { amount }, reason);
  return { ok: true };
}

async function handleSlyDeal(
  userId: string,
  roomId: string,
  cardId: string,
  targetColor: PropertyColor,
  targetCardId: string
) {
  const { caller, opponent, state, hand } = await loadTurnContext(userId, roomId);
  assertCanPlay(state, caller, 1);

  const card = hand.find((c) => c.id === cardId);
  if (!card || card.kind !== "action" || card.action !== "sly_deal") {
    throw new HttpError(404, "Sly Deal card not in hand");
  }

  const oppBoard = await loadBoard(opponent.id);
  const targetEntry = findGroupForCard(oppBoard, targetColor, targetCardId);
  const oppGroup = targetEntry?.[1];
  if (isComplete(oppGroup, targetColor)) throw new HttpError(400, "Can't Sly Deal a property from a complete set");
  const targetCard = oppGroup?.cards.find((c) => c.id === targetCardId);
  if (!targetCard) throw new HttpError(404, "That property isn't on their board");

  const newDiscard = await removeFromHandAndDiscard(caller.id, hand, state.discard_pile, [cardId]);
  await admin
    .from("game_state")
    .update({ discard_pile: newDiscard, cards_played_this_turn: state.cards_played_this_turn + 1 })
    .eq("room_id", roomId);

  const label = targetCard.kind === "property" ? targetCard.name : "a wildcard property";
  await proposeAction(
    roomId,
    caller,
    opponent,
    "sly_deal",
    { target_color: targetColor, target_card_id: targetCardId, target_group_key: targetEntry?.[0] },
    `Sly Deal — ${label} (${COLOR_LABEL[targetColor]})`
  );

  return { ok: true };
}

async function handleForcedDeal(
  userId: string,
  roomId: string,
  cardId: string,
  targetColor: PropertyColor,
  targetCardId: string,
  offerColor: PropertyColor,
  offerCardId: string
) {
  const { caller, opponent, state, hand } = await loadTurnContext(userId, roomId);
  assertCanPlay(state, caller, 1);

  const card = hand.find((c) => c.id === cardId);
  if (!card || card.kind !== "action" || card.action !== "forced_deal") {
    throw new HttpError(404, "Forced Deal card not in hand");
  }

  const callerBoard = await loadBoard(caller.id);
  const oppBoard = await loadBoard(opponent.id);
  const offerEntry = findGroupForCard(callerBoard, offerColor, offerCardId);
  const targetEntry = findGroupForCard(oppBoard, targetColor, targetCardId);
  const callerGroup = offerEntry?.[1];
  const oppGroup = targetEntry?.[1];
  if (isComplete(callerGroup, offerColor) || isComplete(oppGroup, targetColor)) {
    throw new HttpError(400, "Can't Forced Deal a property from a complete set");
  }
  const offerCard = callerGroup?.cards.find((c) => c.id === offerCardId);
  const targetCard = oppGroup?.cards.find((c) => c.id === targetCardId);
  if (!offerCard) throw new HttpError(404, "That property isn't on your board");
  if (!targetCard) throw new HttpError(404, "That property isn't on their board");

  const newDiscard = await removeFromHandAndDiscard(caller.id, hand, state.discard_pile, [cardId]);
  await admin
    .from("game_state")
    .update({ discard_pile: newDiscard, cards_played_this_turn: state.cards_played_this_turn + 1 })
    .eq("room_id", roomId);

  await proposeAction(
    roomId,
    caller,
    opponent,
    "forced_deal",
    { target_color: targetColor, target_card_id: targetCardId, target_group_key: targetEntry?.[0], offer_color: offerColor, offer_card_id: offerCardId, offer_group_key: offerEntry?.[0] },
    `Forced Deal — swap for ${COLOR_LABEL[targetColor]}`
  );

  return { ok: true };
}

async function handleDealBreaker(userId: string, roomId: string, cardId: string, targetColor: PropertyColor, targetGroupKey?: string) {
  const { caller, opponent, state, hand } = await loadTurnContext(userId, roomId);
  assertCanPlay(state, caller, 1);

  const card = hand.find((c) => c.id === cardId);
  if (!card || card.kind !== "action" || card.action !== "deal_breaker") {
    throw new HttpError(404, "Deal Breaker card not in hand");
  }

  const oppBoard = await loadBoard(opponent.id);
  const targetEntry = targetGroupKey
    ? [targetGroupKey, oppBoard.properties[targetGroupKey]] as const
    : groupEntries(oppBoard, targetColor).find(([, g]) => isComplete(g, targetColor));
  const oppGroup = targetEntry?.[1];
  if (!oppGroup || !targetEntry?.[0]) throw new HttpError(400, "That set isn't available for Deal Breaker");
  if (groupColor(targetEntry[0]) !== targetColor || !isComplete(oppGroup, targetColor)) {
    throw new HttpError(400, "Deal Breaker requires a complete property set");
  }

  const newDiscard = await removeFromHandAndDiscard(caller.id, hand, state.discard_pile, [cardId]);
  await admin
    .from("game_state")
    .update({ discard_pile: newDiscard, cards_played_this_turn: state.cards_played_this_turn + 1 })
    .eq("room_id", roomId);

  await proposeAction(
    roomId,
    caller,
    opponent,
    "deal_breaker",
    { target_color: targetColor, target_group_key: targetEntry?.[0] },
    `Deal Breaker — their complete ${COLOR_LABEL[targetColor]} set`
  );

  return { ok: true };
}

// ----------------------------------------------------------------------------
// Stage 5: responding to a proposed action.
// ----------------------------------------------------------------------------

async function handlePlayJustSayNo(userId: string, roomId: string, cardId: string) {
  const { caller, players, state, hand } = await loadTurnContext(userId, roomId);
  assertGameActive(state);
  if (!state.pending_action || state.pending_action.type !== "action_pending") {
    throw new HttpError(400, "Nothing to respond to");
  }
  const pending = state.pending_action;
  if (pending.turn_seat !== caller.seat) throw new HttpError(403, "Not your response");

  const card = hand.find((c) => c.id === cardId);
  if (!card || card.kind !== "action" || card.action !== "just_say_no") {
    throw new HttpError(404, "Just Say No card not in hand");
  }

  const newDiscard = await removeFromHandAndDiscard(caller.id, hand, state.discard_pile, [cardId]);

  const updated: ActionPending = {
    ...pending,
    cancelled: !pending.cancelled,
    jsn_count: pending.jsn_count + 1,
    turn_seat: pending.turn_seat === 0 ? 1 : 0,
  };
  await admin
    .from("game_state")
    .update({ discard_pile: newDiscard, pending_action: updated })
    .eq("room_id", roomId);

  await maybeAutoResolve(roomId);
  return { ok: true };
}

async function handleResolveAction(userId: string, roomId: string) {
  const { caller, players, state } = await loadTurnContext(userId, roomId);
  assertGameActive(state);
  if (!state.pending_action || state.pending_action.type !== "action_pending") {
    throw new HttpError(400, "Nothing to respond to");
  }
  const pending = state.pending_action;
  if (pending.turn_seat !== caller.seat) throw new HttpError(403, "Not your response");

  await finalizeResolution(roomId, players, pending);
  return { ok: true };
}

// ----------------------------------------------------------------------------
// Resolving a payment demand (reached either directly, for Stage 4 flows,
// or after a Rent/Debt Collector/Birthday proposal goes uncontested).
//
// Completed property sets are protected from payment in this game model.
// Payment may use bank cards and properties from incomplete groups only.
// ----------------------------------------------------------------------------

async function handlePayDemand(userId: string, roomId: string, cardIds: string[]) {
  const { caller, players, state } = await loadTurnContext(userId, roomId);
  assertGameActive(state);
  if (!state.pending_action || state.pending_action.type !== "payment_demand") {
    throw new HttpError(400, "No payment is pending");
  }
  const pending = state.pending_action;
  if (pending.to_seat !== caller.seat) throw new HttpError(403, "This payment isn't yours to make");

  const receiver = players.find((p) => p.seat === pending.from_seat);
  if (!receiver) throw new HttpError(500, "Could not find the payment recipient");

  const payerBoard = await loadBoard(caller.id);

  // Completed property sets are protected and cannot be used to pay. Only
  // bank cards and cards in incomplete property groups are eligible.
  const eligiblePropertyEntries = Object.entries(payerBoard.properties).filter(([key, g]) => {
    return g.cards.length > 0 && g.cards.length < SET_SIZE[groupColor(key)];
  });
  const eligiblePropertyIds = new Set(eligiblePropertyEntries.flatMap(([, g]) => g.cards.map((c) => c.id)));
  const eligibleBankIds = new Set(payerBoard.bank.map((c) => c.id));
  const totalAvailable = payerBoard.bank.reduce((sum, c) => sum + c.value, 0) +
    eligiblePropertyEntries.reduce((sum, [, g]) => sum + g.cards.reduce((s, c) => s + c.value, 0), 0);

  const newBank = [...payerBoard.bank];
  const newProperties: BoardProperties = Object.fromEntries(
    Object.entries(payerBoard.properties).map(([key, g]) => [key, { ...g, cards: [...g.cards] }])
  );

  const removedForReceiver: { card: Card; from: "bank" | PropertyColor }[] = [];

  for (const id of cardIds) {
    if (eligibleBankIds.has(id)) {
      const bankIdx = newBank.findIndex((c) => c.id === id);
      if (bankIdx !== -1) {
        removedForReceiver.push({ card: newBank[bankIdx], from: "bank" });
        newBank.splice(bankIdx, 1);
        continue;
      }
    }

    if (eligiblePropertyIds.has(id)) {
      let found = false;
      for (const key of Object.keys(newProperties)) {
        const color = groupColor(key);
        const group = newProperties[key];
        const idx = group.cards.findIndex((c) => c.id === id);
        if (idx !== -1 && group.cards.length < SET_SIZE[color]) {
          removedForReceiver.push({ card: group.cards[idx], from: color });
          group.cards.splice(idx, 1);
          if (group.cards.length === 0) delete newProperties[key];
          found = true;
          break;
        }
      }
      if (found) continue;
    }

    // This also prevents a malicious client from paying with a completed-set card.
    throw new HttpError(400, "A completed property set cannot be used as payment");
  }

  const paidSum = removedForReceiver.reduce((s, r) => s + r.card.value, 0);
  const amountOwed = pending.amount;

  if (totalAvailable < amountOwed) {
    if (paidSum !== totalAvailable) {
      throw new HttpError(400, `You must give all eligible cash/properties you have (${totalAvailable}M)`);
    }
  } else if (paidSum < amountOwed) {
    throw new HttpError(400, `You owe ${amountOwed}M — selected cards only total ${paidSum}M`);
  }

  await saveBoard(caller.id, { bank: newBank, properties: newProperties });

  const receiverBoard = await loadBoard(receiver.id);
  const receiverBank = [...receiverBoard.bank];
  let receiverProperties: BoardProperties = Object.fromEntries(
    Object.entries(receiverBoard.properties).map(([key, g]) => [key, { ...g, cards: [...g.cards] }])
  );
  for (const { card, from } of removedForReceiver) {
    if (from === "bank") {
      receiverBank.push(card);
    } else {
      receiverProperties = addPropertyToGroup({ ...receiverBoard, properties: receiverProperties }, from, card);
    }
  }
  await saveBoard(receiver.id, { bank: receiverBank, properties: receiverProperties });
  await admin.from("game_state").update({ pending_action: null }).eq("room_id", roomId);

  return { ok: true, paid: paidSum };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const userId = await authenticate(req);
    const body = await req.json();
    const { action, room_id } = body;
    if (!action || !room_id) throw new HttpError(400, "Missing action or room_id");

    switch (action) {
      case "start_game":
        return json(await handleStartGame(userId, room_id));
      case "rematch":
        return json(await handleRematch(userId, room_id));
      case "draw":
        return json(await handleDraw(userId, room_id));
      case "play_money":
        return json(await handlePlayMoney(userId, room_id, body.card_id));
      case "play_property":
        return json(await handlePlayProperty(userId, room_id, body.card_id, body.color));
      case "discard":
        return json(await handleDiscard(userId, room_id, body.card_id));
      case "end_turn":
        return json(await handleEndTurn(userId, room_id));
      case "play_rent":
        return json(
          await handlePlayRent(userId, room_id, body.card_id, body.color, body.double_card_ids)
        );
      case "play_debt_collector":
        return json(
          await handleSimpleDemand(userId, room_id, body.card_id, "debt_collector", 5, "Debt Collector")
        );
      case "play_birthday":
        return json(
          await handleSimpleDemand(userId, room_id, body.card_id, "birthday", 2, "It's My Birthday")
        );
      case "play_sly_deal":
        return json(
          await handleSlyDeal(userId, room_id, body.card_id, body.target_color, body.target_card_id)
        );
      case "play_forced_deal":
        return json(
          await handleForcedDeal(
            userId,
            room_id,
            body.card_id,
            body.target_color,
            body.target_card_id,
            body.offer_color,
            body.offer_card_id
          )
        );
      case "play_deal_breaker":
        return json(await handleDealBreaker(userId, room_id, body.card_id, body.target_color, body.target_group_key));
      case "play_house":
        return json(await handleBuild(userId, room_id, body.card_id, body.color, "house", body.group_key));
      case "play_hotel":
        return json(await handleBuild(userId, room_id, body.card_id, body.color, "hotel", body.group_key));
      case "play_pass_go":
        return json(await handlePassGo(userId, room_id, body.card_id));
      case "play_just_say_no":
        return json(await handlePlayJustSayNo(userId, room_id, body.card_id));
      case "resolve_action":
        return json(await handleResolveAction(userId, room_id));
      case "pay_demand":
        return json(await handlePayDemand(userId, room_id, body.card_ids ?? []));
      default:
        throw new HttpError(400, `Unknown action: ${action}`);
    }
  } catch (err) {
    if (err instanceof HttpError) {
      console.error(`[game-actions] ${err.status} ${err.message}`, err.cause ?? "");
      return json({ error: err.message }, err.status);
    }
    console.error(err);
    return json({ error: "Internal error" }, 500);
  }
});
