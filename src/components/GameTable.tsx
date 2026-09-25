"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getSupabaseClient } from "@/lib/supabase/client";
import { callGameAction } from "@/lib/supabase/functions";
import { COLOR_LABEL, NO_BUILDING_COLORS, SET_SIZE, type Card, type PropertyColor } from "@/lib/deck";
import type { Player, Room } from "@/lib/types";

type BoardProperties = Record<string, { cards: Card[]; house: boolean; hotel: boolean }>;
interface Board {
  player_id: string;
  bank: Card[];
  properties: BoardProperties;
}
type ContestEffect = "rent" | "debt_collector" | "birthday" | "sly_deal" | "forced_deal" | "deal_breaker";
interface ActionPending {
  type: "action_pending";
  effect: ContestEffect;
  from_seat: 0 | 1;
  to_seat: 0 | 1;
  turn_seat: 0 | 1;
  cancelled: boolean;
  jsn_count: number;
  reason: string;
  payload: Record<string, unknown>;
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
  draw_pile: Card[];
  discard_pile: Card[];
  current_seat: 0 | 1;
  cards_played_this_turn: number;
  turn_phase: "draw" | "play" | "discard";
  winner_seat: number | null;
  pending_action: PendingAction | null;
}

type Targeting =
  | { mode: "sly_deal"; cardId: string }
  | { mode: "deal_breaker"; cardId: string; groupKey?: string }
  | { mode: "house"; cardId: string; groupKey?: string }
  | { mode: "hotel"; cardId: string; groupKey?: string }
  | { mode: "forced_deal_offer"; cardId: string }
  | { mode: "forced_deal_target"; cardId: string; offerColor: PropertyColor; offerCardId: string };

const TARGETING_LABEL: Record<Targeting["mode"], string> = {
  sly_deal: "Pick one of their properties to take",
  deal_breaker: "Pick one of their complete sets to take",
  house: "Pick one of your complete sets to build on",
  hotel: "Pick one of your complete sets (with a House) to build on",
  forced_deal_offer: "Pick one of your own properties to offer",
  forced_deal_target: "Now pick one of their properties to swap for",
};

export default function GameTable({
  room,
  players,
  myUserId,
}: {
  room: Room;
  players: Player[];
  myUserId: string;
}) {
  const me = players.find((p) => p.user_id === myUserId)!;
  const opponent = players.find((p) => p.user_id !== myUserId);

  const [hand, setHand] = useState<Card[]>([]);
  const [boards, setBoards] = useState<Board[]>([]);
  const [state, setState] = useState<GameState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wildcardPick, setWildcardPick] = useState<Card | null>(null);
  const [rentCard, setRentCard] = useState<Card | null>(null);
  const [targeting, setTargeting] = useState<Targeting | null>(null);
  const [payCardIds, setPayCardIds] = useState<Set<string>>(new Set());
  const [payOpen, setPayOpen] = useState(false);
  const [openCardId, setOpenCardId] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    const supabase = getSupabaseClient();
    const [{ data: handRow }, { data: boardRows }, { data: stateRow }] = await Promise.all([
      supabase.from("hands").select("*").eq("player_id", me.id).maybeSingle(),
      supabase.from("boards").select("*").eq("room_id", room.id),
      supabase.from("game_state").select("*").eq("room_id", room.id).maybeSingle(),
    ]);
    if (handRow) setHand(handRow.cards as Card[]);
    if (boardRows) setBoards(boardRows as Board[]);
    if (stateRow) setState(stateRow as GameState);
  }, [me.id, room.id]);

  useEffect(() => {
    loadAll();
    const supabase = getSupabaseClient();
    const channel = supabase
      .channel(`game:${room.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "hands", filter: `player_id=eq.${me.id}` },
        () => loadAll()
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "boards", filter: `room_id=eq.${room.id}` },
        () => loadAll()
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "game_state", filter: `room_id=eq.${room.id}` },
        () => loadAll()
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [loadAll, me.id, room.id]);

  async function run(action: () => Promise<{ ok?: boolean; error?: string }>) {
    setBusy(true);
    setError(null);
    const result = await action();
    if (result.error) setError(result.error);
    else {
      setTargeting(null);
      setRentCard(null);
      setWildcardPick(null);
      setOpenCardId(null);
    }
    setBusy(false);
  }

  if (!state) {
    return <p className="text-parchment/80">Loading table…</p>;
  }

  const myTurn = state.current_seat === me.seat;
  const myBoard = boards.find((b) => b.player_id === me.id);
  const oppBoard = opponent ? boards.find((b) => b.player_id === opponent.id) : undefined;
  const canAct = myTurn && state.turn_phase === "play" && !state.pending_action;
  const doubleRentCardIds = hand.filter((c) => c.kind === "action" && c.action === "double_rent").map((c) => c.id);
  const justSayNoCardId = hand.find((c) => c.kind === "action" && c.action === "just_say_no")?.id;


  function startTargeting(t: Targeting) {
    setError(null);
    setTargeting(t);
  }

  function handleOwnCardClick(color: PropertyColor, card: Card) {
    if (!targeting) return;
    if (targeting.mode === "forced_deal_offer") {
      setTargeting({ mode: "forced_deal_target", cardId: targeting.cardId, offerColor: color, offerCardId: card.id });
    }
  }

  function handleOwnGroupClick(color: PropertyColor, groupKey?: string) {
    if (!targeting) return;
    if (targeting.mode === "house") {
      run(() => callGameAction("play_house", { room_id: room.id, card_id: targeting.cardId, color, group_key: groupKey }));
    } else if (targeting.mode === "hotel") {
      run(() => callGameAction("play_hotel", { room_id: room.id, card_id: targeting.cardId, color, group_key: groupKey }));
    }
  }

  function handleOppCardClick(color: PropertyColor, card: Card) {
    if (!targeting) return;
    if (targeting.mode === "sly_deal") {
      run(() =>
        callGameAction("play_sly_deal", {
          room_id: room.id,
          card_id: targeting.cardId,
          target_color: color,
          target_card_id: card.id,
        })
      );
    } else if (targeting.mode === "forced_deal_target") {
      run(() =>
        callGameAction("play_forced_deal", {
          room_id: room.id,
          card_id: targeting.cardId,
          target_color: color,
          target_card_id: card.id,
          offer_color: targeting.offerColor,
          offer_card_id: targeting.offerCardId,
        })
      );
    }
  }

  function handleOppGroupClick(color: PropertyColor, groupKey?: string) {
    if (!targeting) return;
    if (targeting.mode === "deal_breaker") {
      run(() =>
        callGameAction("play_deal_breaker", { room_id: room.id, card_id: targeting.cardId, target_color: color, target_group_key: groupKey })
      );
    }
  }

  return (
    <div
      className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-3 px-3 py-3 sm:px-5 sm:py-4"
      onClick={() => {
        setTargeting(null);
        setPayOpen(false);
      }}
    >
      <div
        className="sticky top-2 z-30 flex items-center justify-between rounded-2xl border border-white/10 bg-[#073a28]/95 px-4 py-3 shadow-xl backdrop-blur"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full ${myTurn ? "bg-yellow-300" : "bg-white/30"}`} />
            <p className="font-display text-lg font-semibold text-white">
              {myTurn ? "Your turn" : `${opponent?.display_name ?? "Opponent"}'s turn`}
            </p>
          </div>
          <p className="text-xs text-white/55">
            {state.cards_played_this_turn}/3 plays · {state.draw_pile.length} in deck · {state.discard_pile.length} discarded
            {state.turn_phase === "discard" ? " · Discard down to 7" : ""}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {myTurn && state.turn_phase === "draw" && !state.pending_action && (
            <button
              disabled={busy}
              onClick={() => run(() => callGameAction("draw", { room_id: room.id }))}
              className="rounded-xl bg-white/10 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/20 disabled:opacity-50"
            >
              Draw {hand.length === 0 ? "5" : "2"}
            </button>
          )}
          {canAct && (
            <button
              disabled={busy}
              onClick={() => run(() => callGameAction("end_turn", { room_id: room.id }))}
              className="rounded-xl bg-white/10 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/20 disabled:opacity-50"
            >
              End turn
            </button>
          )}
        </div>
      </div>

      {state.pending_action?.type === "payment_demand" && (
        <div className="rounded-xl bg-yellow-100 px-4 py-3" onClick={(e) => e.stopPropagation()}>
          {state.pending_action.to_seat === me.seat ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-felt">
                You owe {state.pending_action.amount}M — {state.pending_action.reason}
              </p>
              <button
                onClick={() => {
                  setPayCardIds(new Set());
                  setPayOpen(true);
                }}
                className="rounded-lg bg-felt px-3 py-2 text-sm font-medium text-parchment hover:opacity-90"
              >
                Pay
              </button>
            </div>
          ) : (
            <p className="text-sm text-felt/80">
              Waiting for {opponent?.display_name} to pay {state.pending_action.amount}M — {state.pending_action.reason}
            </p>
          )}
        </div>
      )}

      {state.pending_action?.type === "action_pending" && (
        <div className="rounded-xl bg-yellow-100 px-4 py-3" onClick={(e) => e.stopPropagation()}>
          <p className="text-sm font-medium text-felt">{state.pending_action.reason}</p>
          <p className="mt-1 text-xs text-felt/60">
            {state.pending_action.cancelled ? "Currently blocked by a Just Say No." : "Currently standing — will happen unless blocked."}
          </p>
          {state.pending_action.turn_seat === me.seat ? (
            <div className="mt-2 flex gap-2">
              {justSayNoCardId && (
                <button
                  disabled={busy}
                  onClick={() => run(() => callGameAction("play_just_say_no", { room_id: room.id, card_id: justSayNoCardId }))}
                  className="rounded-lg bg-felt px-3 py-2 text-xs font-medium text-parchment hover:opacity-90 disabled:opacity-50"
                >
                  Play Just Say No
                </button>
              )}
              <button
                disabled={busy}
                onClick={() => run(() => callGameAction("resolve_action", { room_id: room.id }))}
                className="rounded-lg border border-felt/30 px-3 py-2 text-xs font-medium text-felt hover:bg-felt/5 disabled:opacity-50"
              >
                {state.pending_action.cancelled ? "Confirm it's blocked" : "Accept (no Just Say No)"}
              </button>
            </div>
          ) : (
            <p className="mt-2 text-xs text-felt/60">Waiting for {opponent?.display_name} to respond…</p>
          )}
        </div>
      )}

      {targeting && (
        <div className="flex items-center justify-between rounded-xl bg-felt px-4 py-2" onClick={(e) => e.stopPropagation()}>
          <p className="text-sm text-parchment">{TARGETING_LABEL[targeting.mode]}</p>
          <button onClick={() => setTargeting(null)} className="text-xs text-parchment/70 hover:text-parchment">Cancel</button>
        </div>
      )}

      {error && (
        <p className="rounded-lg bg-red-100 px-3 py-2 text-sm text-red-700" role="alert" onClick={(e) => e.stopPropagation()}>
          {error}
        </p>
      )}

      {/* Opponent sits across the table: bank + properties at the top. */}
      <BoardView
        title={opponent?.display_name ?? "Opponent"}
        board={oppBoard}
        isOwn={false}
        targeting={targeting}
        onCardClick={handleOppCardClick}
        onGroupClick={handleOppGroupClick}
      />

      {/* Your side: bank + properties, then your hand at the bottom. */}
      <BoardView
        title={me.display_name}
        board={myBoard}
        isOwn={true}
        targeting={targeting}
        onCardClick={handleOwnCardClick}
        onGroupClick={handleOwnGroupClick}
      />

      <div className="rounded-2xl border border-white/10 bg-black/15 p-3 shadow-inner" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between gap-2">
          <p className="font-display text-sm font-semibold text-white">
            {me.display_name}'s hand <span className="text-white/45">{hand.length}</span>
          </p>
          {myTurn && state.turn_phase === "discard" && hand.length > 7 && (
            <span className="rounded-full bg-red-500/80 px-2.5 py-1 text-[10px] font-bold text-white">
              Discard {hand.length - 7}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-end justify-center gap-2 sm:justify-start">
          {hand.map((card) => (
            <HandCard
              key={card.id}
              card={card}
              canAct={canAct && !busy}
              open={openCardId === card.id}
              onToggleOpen={() => setOpenCardId(openCardId === card.id ? null : card.id)}
              mustDiscard={hand.length > 7 && myTurn && state.turn_phase === "discard"}
              onPlayMoney={() => run(() => callGameAction("play_money", { room_id: room.id, card_id: card.id }))}
              onPlayProperty={(color) => run(() => callGameAction("play_property", { room_id: room.id, card_id: card.id, color }))}
              onNeedColorPick={() => setWildcardPick(card)}
              onDiscard={() => run(() => callGameAction("discard", { room_id: room.id, card_id: card.id }))}
              onPlayRent={() => setRentCard(card)}
              onPlayDebtCollector={() => run(() => callGameAction("play_debt_collector", { room_id: room.id, card_id: card.id }))}
              onPlayBirthday={() => run(() => callGameAction("play_birthday", { room_id: room.id, card_id: card.id }))}
              onPlayPassGo={() => run(() => callGameAction("play_pass_go", { room_id: room.id, card_id: card.id }))}
              onStartSlyDeal={() => startTargeting({ mode: "sly_deal", cardId: card.id })}
              onStartForcedDeal={() => startTargeting({ mode: "forced_deal_offer", cardId: card.id })}
              onStartDealBreaker={() => startTargeting({ mode: "deal_breaker", cardId: card.id })}
              onStartHouse={() => startTargeting({ mode: "house", cardId: card.id })}
              onStartHotel={() => startTargeting({ mode: "hotel", cardId: card.id })}
            />
          ))}
        </div>
      </div>

      {state.winner_seat !== null && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]">
          <div className="w-full max-w-md rounded-3xl border border-yellow-300/40 bg-[#073a28]/95 p-7 text-center shadow-2xl">
            <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-yellow-300/15 text-4xl">🏆</div>
            <p className="font-display text-3xl font-black text-white">{(state.winner_seat === me.seat ? me.display_name : opponent?.display_name ?? "Opponent")} wins!</p>
            <p className="mt-2 text-sm text-white/70">3 complete property sets. The final table remains visible behind this message.</p>
            <button
              disabled={busy}
              onClick={() => run(() => callGameAction("rematch", { room_id: room.id }))}
              className="mt-5 rounded-xl bg-yellow-300 px-6 py-3 font-bold text-[#073a28] transition hover:bg-yellow-200 disabled:opacity-50"
            >
              {busy ? "Starting…" : "Play again"}
            </button>
            {error && <p className="mt-3 rounded-lg bg-red-100 px-3 py-2 text-sm text-red-700">{error}</p>}
          </div>
        </div>
      )}

      {wildcardPick && (
        <ColorPickModal
          card={wildcardPick}
          onPick={(color) => run(() => callGameAction("play_property", { room_id: room.id, card_id: wildcardPick.id, color }))}
          onClose={() => setWildcardPick(null)}
        />
      )}

      {rentCard && myBoard && (
        <RentModal
          card={rentCard}
          myProperties={myBoard.properties}
          maxDoublers={Math.max(0, Math.min(doubleRentCardIds.length, 2, 3 - state.cards_played_this_turn - 1))}
          onSubmit={(color, doublersUsed) =>
            run(() => callGameAction("play_rent", {
              room_id: room.id,
              card_id: rentCard.id,
              color,
              double_card_ids: doubleRentCardIds.slice(0, doublersUsed),
            }))
          }
          onClose={() => setRentCard(null)}
        />
      )}

      {payOpen && myBoard && state.pending_action && (
        <PaymentModal
          board={myBoard}
          amountOwed={state.pending_action.amount}
          selected={payCardIds}
          setSelected={setPayCardIds}
          onSubmit={() => run(() => callGameAction("pay_demand", { room_id: room.id, card_ids: Array.from(payCardIds) })).then(() => setPayOpen(false))}
          onClose={() => setPayOpen(false)}
        />
      )}
    </div>
  );
}
const ALL_PROPERTY_COLORS: PropertyColor[] = ["brown", "lightblue", "pink", "orange", "red", "yellow", "green", "darkblue", "railroad", "utility"];

function propertyTone(color: PropertyColor) {
  const tones: Record<PropertyColor, string> = {
    brown: "#955a2a", lightblue: "#8fd3ff", pink: "#d85aa8", orange: "#f28a2e",
    red: "#d94141", yellow: "#f2ca3a", green: "#55ad62", darkblue: "#3858a8",
    railroad: "#30343b", utility: "#59636f",
  };
  return tones[color];
}

function rentLine(card: Card) {
  if (card.kind !== "property") return null;
  return card.rents.map((r, i) => `${i + 1}:${r}M`).join("  ");
}

function VisualCard({ card, small = false, back = false, selected = false, onClick }: {
  card?: Card; small?: boolean; back?: boolean; selected?: boolean; onClick?: () => void;
}) {
  if (back) return <div className={`${small ? "h-20 w-14" : "h-32 w-24"} card-back rounded-xl shadow-lg`} />;
  if (!card) return null;
  const base = `${small ? "h-20 w-14" : "h-36 w-24 sm:h-40 sm:w-28"} shrink-0 rounded-[14px] border border-black/20 bg-[#f8f3e6] shadow-xl transition duration-150 ${onClick ? "cursor-pointer hover:-translate-y-2 hover:shadow-2xl" : ""} ${selected ? "-translate-y-2 ring-4 ring-yellow-300" : ""}`;

  if (card.kind === "money") return (
    <button onClick={onClick} className={`${base} money-card flex flex-col items-center justify-between p-2 text-felt`}>
      <span className="text-[7px] font-black uppercase tracking-widest">Monopoly Deal</span>
      <span className="text-3xl font-black">{card.value}M</span>
      <span className="rounded-full border border-felt/30 px-2 py-0.5 text-[7px] font-bold">MONEY</span>
    </button>
  );

  if (card.kind === "property") return (
    <button onClick={onClick} style={{"--property-color": propertyTone(card.color)} as React.CSSProperties} className={`${base} property-card overflow-hidden text-left`}>
      <div className="property-band" style={{backgroundColor: propertyTone(card.color)}}>
        <span>{COLOR_LABEL[card.color]}</span>
      </div>
      <div className="flex h-[calc(100%-38px)] flex-col justify-between p-2.5 text-felt">
        <div>
          <span className="block text-[10px] font-black leading-tight">{card.name}</span>
          <span className="mt-1 block text-[7px] font-semibold text-felt/55">PROPERTY</span>
        </div>
        <div className="rounded-lg border border-felt/10 bg-white/70 p-1.5">
          <div className="grid grid-cols-2 gap-x-1 text-[6px] font-bold text-felt/60"><span>SET</span><span className="text-right">RENT</span></div>
          <div className="mt-0.5 text-right text-[8.5px] font-black tracking-tight">{rentLine(card)}</div>
        </div>
        <span className="self-end text-base font-black">{card.value}M</span>
      </div>
    </button>
  );

  if (card.kind === "wildcard") {
    const isAllColors = card.colors.length > 2;
    return (
      <button onClick={onClick} className={`${base} overflow-hidden bg-[#eee7d8] p-1.5 text-felt`}>
        <div className="relative flex h-full flex-col items-center justify-between overflow-hidden rounded-[10px] border-2 border-felt/20 bg-[#f8f3e6] p-2">
          {!isAllColors ? (
            <>
              <div className="absolute inset-x-0 top-0 h-9 flex">
                <div className="flex-1" style={{ backgroundColor: propertyTone(card.colors[0]) }} />
                <div className="flex-1" style={{ backgroundColor: propertyTone(card.colors[1]) }} />
              </div>
              <div className="absolute inset-x-0 top-9 h-px bg-black/20" />
            </>
          ) : (
            <div className="absolute left-2 right-2 top-2 flex flex-wrap justify-center gap-1">
              {card.colors.map((c) => (
                <span key={c} title={COLOR_LABEL[c]} className="h-2.5 w-2.5 rounded-sm border border-black/15 shadow-sm" style={{ backgroundColor: propertyTone(c) }} />
              ))}
            </div>
          )}
          <span className={`${!isAllColors ? "mt-5" : "mt-5"} z-10 rounded-full bg-white/90 px-2 py-0.5 text-[7px] font-black uppercase shadow-sm`}>Property Wild</span>
          <span className="z-10 text-center text-[9px] font-black leading-tight">{card.name}</span>
          <div className="z-10 rounded-lg bg-white/90 px-2 py-1 text-center text-[7px] font-bold shadow-sm">{isAllColors ? "ANY COLOR" : card.colors.map((c) => COLOR_LABEL[c]).join(" / ")}</div>
          <span className="z-10 text-lg font-black">{card.value}M</span>
          {!isAllColors && (
            <div className="absolute inset-x-0 bottom-0 h-9 flex">
              <div className="flex-1" style={{ backgroundColor: propertyTone(card.colors[0]) }} />
              <div className="flex-1" style={{ backgroundColor: propertyTone(card.colors[1]) }} />
            </div>
          )}
        </div>
      </button>
    );
  }

  const actionMeta: Record<string, { bg: string; accent: string; icon: string; subtitle: string }> = {
    deal_breaker: {bg:"#b92d38",accent:"#ffd86b",icon:"✦",subtitle:"TAKE A COMPLETE SET"},
    just_say_no: {bg:"#28313b",accent:"#f2d36b",icon:"✋",subtitle:"NO!"},
    sly_deal: {bg:"#7045a5",accent:"#f5d86d",icon:"↗",subtitle:"STEAL A PROPERTY"},
    forced_deal: {bg:"#c77624",accent:"#fff0b0",icon:"⇄",subtitle:"SWAP PROPERTIES"},
    debt_collector: {bg:"#a53636",accent:"#ffe08a",icon:"$",subtitle:"COLLECT 5M"},
    birthday: {bg:"#bd4f85",accent:"#ffe3a0",icon:"🎂",subtitle:"EVERYONE PAYS"},
    double_rent: {bg:"#8e3e91",accent:"#ffe77c",icon:"×2",subtitle:"DOUBLE RENT"},
    house: {bg:"#287d54",accent:"#ffe28a",icon:"⌂",subtitle:"ADD A HOUSE"},
    hotel: {bg:"#197c83",accent:"#ffe28a",icon:"▣",subtitle:"ADD A HOTEL"},
    pass_go: {bg:"#316db4",accent:"#ffe28a",icon:"→",subtitle:"DRAW 2 CARDS"},
    rent: {bg:"#c75b27",accent:"#ffe28a",icon:"$",subtitle:"CHARGE RENT"},
    rent_wild: {bg:"#cf5f2c",accent:"#ffe28a",icon:"$",subtitle:"CHARGE ANY RENT"},
  };
  const meta = actionMeta[card.action] ?? {bg:"#345",accent:"#fff",icon:"★",subtitle:"ACTION"};
  const isRentCard = card.action === "rent" || card.action === "rent_wild";
  const rentColors = card.action === "rent" ? (card.rentColors ?? []) : [];
  return (
    <button onClick={onClick} style={{backgroundColor:meta.bg, color:meta.accent}} className={`${base} action-card flex flex-col items-center justify-between p-2.5`}>
      <span className="text-[7px] font-black uppercase tracking-[0.18em] opacity-80">MONOPOLY DEAL</span>
      {isRentCard ? (
        <div className="flex flex-1 items-center justify-center">
          {card.action === "rent" ? (
            <div className="relative h-16 w-16 overflow-hidden rounded-xl border-2 border-white/80 shadow-lg">
              <div className="absolute inset-y-0 left-0 w-1/2" style={{ backgroundColor: propertyTone(rentColors[0]) }} />
              <div className="absolute inset-y-0 right-0 w-1/2" style={{ backgroundColor: propertyTone(rentColors[1]) }} />
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="rounded-md bg-white/90 px-1.5 py-1 text-[10px] font-black text-felt shadow">RENT</span>
              </div>
            </div>
          ) : (
            <div className="relative flex h-16 w-16 items-center justify-center rounded-full border-2 border-white/80 bg-white/10 p-2 shadow-lg">
              <div className="absolute inset-1 flex flex-wrap items-center justify-center gap-0.5 rounded-full">
                {ALL_PROPERTY_COLORS.map((c) => <span key={c} className="h-3 w-3 rounded-sm border border-black/15" style={{ backgroundColor: propertyTone(c) }} />)}
              </div>
              <span className="relative z-10 rounded-md bg-white/95 px-1.5 py-1 text-[10px] font-black text-felt shadow">RENT</span>
            </div>
          )}
        </div>
      ) : (
        <span className="text-4xl font-black leading-none drop-shadow-sm">{meta.icon}</span>
      )}
      <span className="rounded-md bg-black/15 px-2 py-1 text-center text-[10px] font-black uppercase leading-tight">{card.name}</span>
      <span className="text-center text-[7px] font-bold uppercase tracking-wide opacity-90">{meta.subtitle}</span>
      <span className="text-sm font-black">{card.value}M</span>
    </button>
  );
}

function BoardView({ title, board, isOwn, targeting, onCardClick, onGroupClick }: {
  title: string; board?: Board; isOwn: boolean; targeting: Targeting | null;
  onCardClick: (color: PropertyColor, card: Card) => void; onGroupClick: (color: PropertyColor, groupKey?: string) => void;
}) {
  const bankTotal = board?.bank.reduce((sum, c) => sum + c.value, 0) ?? 0;
  const properties = board?.properties ?? {};
  const groups = Object.entries(properties).filter(([, g]) => g.cards.length);
  const cardModeActive = !!targeting && ((isOwn && targeting.mode === "forced_deal_offer") || (!isOwn && (targeting.mode === "sly_deal" || targeting.mode === "forced_deal_target")));
  const groupModeActive = !!targeting && ((isOwn && (targeting.mode === "house" || targeting.mode === "hotel")) || (!isOwn && targeting.mode === "deal_breaker"));

  return (
    <section onClick={(e) => e.stopPropagation()} className="rounded-2xl border border-white/10 bg-black/15 p-3 shadow-inner sm:p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="font-display text-base font-bold text-white">{title}</p>
          <p className="text-[10px] uppercase tracking-wider text-white/50">Bank {bankTotal}M · {groups.length} group{groups.length === 1 ? "" : "s"}</p>
        </div>
        <div className="flex -space-x-3">
          {(board?.bank ?? []).slice(0, 4).map((c) => <VisualCard key={c.id} card={c} small />)}
          {(board?.bank?.length ?? 0) > 4 && <div className="flex h-20 w-14 items-center justify-center rounded-xl bg-black/30 text-[9px] font-bold text-white">+{board!.bank.length - 4}</div>}
        </div>
      </div>

      {groups.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/10 py-5 text-center text-xs text-white/35">No properties on the table</div>
      ) : (
        <div className="flex flex-wrap gap-3 sm:gap-4">
          {groups.map(([key, group]) => {
            const color = groupColorFromKey(key);
            const complete = group.cards.length >= SET_SIZE[color];
            const canBuild = !NO_BUILDING_COLORS.includes(color);
            let eligible = false;
            if (groupModeActive && targeting) {
              if (targeting.mode === "deal_breaker") eligible = complete;
              if (targeting.mode === "house") eligible = complete && canBuild && !group.house;
              if (targeting.mode === "hotel") eligible = complete && canBuild && group.house && !group.hotel;
            }
            const cardsEligible = !!cardModeActive && !complete;

            return (
              <div
                key={key}
                onClick={() => (groupModeActive && eligible ? onGroupClick(color, key) : undefined)}
                className={`rounded-xl p-2 ${complete ? "bg-white/10 ring-1 ring-yellow-300/30" : "bg-black/10"} ${eligible ? "ring-2 ring-yellow-300 cursor-pointer" : ""}`}
              >
                <button disabled={!eligible} onClick={(e) => { e.stopPropagation(); onGroupClick(color, key); }} className="mb-1 flex w-full items-center justify-between gap-2 text-left">
                  <span className="text-[9px] font-bold uppercase tracking-wide text-white/80">{COLOR_LABEL[color]} {complete ? "✓" : ""} {group.house ? "🏠" : ""}{group.hotel ? "🏨" : ""}</span>
                  <span className="text-[9px] text-white/45">{group.cards.length}/{SET_SIZE[color]}</span>
                </button>
                <div className="flex -space-x-5 pl-1">
                  {group.cards.map((c) => <VisualCard key={c.id} card={c} selected={cardsEligible || eligible} onClick={cardsEligible ? () => onCardClick(color, c) : (eligible ? () => onGroupClick(color, key) : undefined)} />)}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function groupColorFromKey(key: string): PropertyColor { return key.split("::")[0] as PropertyColor; }

function HandCard({ card, canAct, mustDiscard, open, onToggleOpen, onPlayMoney, onPlayProperty, onNeedColorPick, onDiscard, onPlayRent, onPlayDebtCollector, onPlayBirthday, onPlayPassGo, onStartSlyDeal, onStartForcedDeal, onStartDealBreaker, onStartHouse, onStartHotel }: {
  card: Card; canAct: boolean; mustDiscard: boolean; open: boolean; onToggleOpen:()=>void; onPlayMoney:()=>void; onPlayProperty:(color:string)=>void; onNeedColorPick:()=>void; onDiscard:()=>void; onPlayRent:()=>void; onPlayDebtCollector:()=>void; onPlayBirthday:()=>void; onPlayPassGo:()=>void; onStartSlyDeal:()=>void; onStartForcedDeal:()=>void; onStartDealBreaker:()=>void; onStartHouse:()=>void; onStartHotel:()=>void;
}) {
  const actionButtons: {label:string; fn:()=>void}[]=[];
  if(canAct){
    if(card.kind==="property") actionButtons.push({label:"Play property",fn:()=>onPlayProperty(card.color)});
    if(card.kind==="wildcard") actionButtons.push({label:"Play property",fn:onNeedColorPick});
    if(card.kind==="action"&&card.action==="rent") actionButtons.push({label:"Rent…",fn:onPlayRent});
    if(card.kind==="action"&&card.action==="rent_wild") actionButtons.push({label:"Rent (any)…",fn:onPlayRent});
    if(card.kind==="action"&&card.action==="debt_collector") actionButtons.push({label:"Debt Collector",fn:onPlayDebtCollector});
    if(card.kind==="action"&&card.action==="birthday") actionButtons.push({label:"Birthday",fn:onPlayBirthday});
    if(card.kind==="action"&&card.action==="pass_go") actionButtons.push({label:"Pass Go",fn:onPlayPassGo});
    if(card.kind==="action"&&card.action==="sly_deal") actionButtons.push({label:"Sly Deal",fn:onStartSlyDeal});
    if(card.kind==="action"&&card.action==="forced_deal") actionButtons.push({label:"Forced Deal",fn:onStartForcedDeal});
    if(card.kind==="action"&&card.action==="deal_breaker") actionButtons.push({label:"Deal Breaker",fn:onStartDealBreaker});
    if(card.kind==="action"&&card.action==="house") actionButtons.push({label:"Build House",fn:onStartHouse});
    if(card.kind==="action"&&card.action==="hotel") actionButtons.push({label:"Build Hotel",fn:onStartHotel});
    if(card.kind==="money"||card.kind==="action") actionButtons.push({label:"Bank it",fn:onPlayMoney});
  }

  return (
    <div className="relative flex flex-col items-center" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={onToggleOpen}
        className={`transition duration-150 ${open ? "-translate-y-3" : "hover:-translate-y-2"}`}
        aria-label={`Select ${cardLabel(card)}`}
      >
        <VisualCard card={card} />
      </button>
      {open && (
        <div className="absolute bottom-full z-40 mb-2 flex min-w-36 flex-col gap-1 rounded-xl border border-white/15 bg-[#062f21] p-1.5 shadow-2xl">
          {actionButtons.map((b) => <button key={b.label} onClick={b.fn} className="rounded-lg bg-white/10 px-2 py-1.5 text-[10px] font-semibold text-white hover:bg-white/20">{b.label}</button>)}
          {mustDiscard && <button onClick={onDiscard} className="rounded-lg bg-red-500/80 px-2 py-1.5 text-[10px] font-bold text-white">Discard</button>}
        </div>
      )}
      {mustDiscard && <span className="absolute -bottom-2 rounded-full bg-red-500 px-1.5 py-0.5 text-[8px] font-bold text-white">discard</span>}
    </div>
  );
}

function ColorPickModal({ card, onPick, onClose }: { card: Card; onPick: (color: string) => void; onClose: () => void; }) {
  if (card.kind !== "wildcard") return null;
  return <ModalShell onClose={onClose} title="Play as which color?"><div className="flex flex-wrap gap-2">{card.colors.map((c) => <button key={c} onClick={() => onPick(c)} className="rounded-lg bg-felt px-3 py-2 text-xs font-medium text-parchment hover:opacity-90">{COLOR_LABEL[c]}</button>)}</div></ModalShell>;
}

function RentModal({ card, myProperties, maxDoublers, onSubmit, onClose }: {
  card: Card; myProperties: BoardProperties; maxDoublers: number; onSubmit: (color: PropertyColor, doublersUsed: number) => void; onClose: () => void;
}) {
  const [doublersUsed, setDoublersUsed] = useState(0);
  if (card.kind !== "action") return null;
  const ownedGroups = Object.entries(myProperties).filter(([, g]) => g.cards.length > 0);
  const eligibleGroups = ownedGroups.filter(([key]) => {
    const color = groupColorFromKey(key);
    return card.action === "rent" && card.rentColors ? card.rentColors.includes(color) : true;
  });

  return (
    <ModalShell onClose={onClose} title="Charge rent for which set?">
      {maxDoublers > 0 && (
        <div className="mb-3 flex flex-col gap-1 text-xs text-felt">
          <p className="font-medium">Double The Rent?</p>
          <div className="flex gap-2">{Array.from({ length: maxDoublers + 1 }, (_, n) => n).map((n) => <button key={n} onClick={() => setDoublersUsed(n)} className={`rounded-lg px-3 py-1.5 ${doublersUsed === n ? "bg-felt text-parchment" : "border border-felt/30 text-felt hover:bg-felt/5"}`}>{n === 0 ? "No" : `${n} card${n > 1 ? "s" : ""} (${Math.pow(2, n)}x)`}</button>)}</div>
        </div>
      )}
      {eligibleGroups.length === 0 ? <p className="text-xs text-felt/60">You don't own an eligible property set for this card.</p> : <div className="flex max-h-60 flex-col gap-2 overflow-y-auto">{eligibleGroups.map(([key, group]) => {
        const color = groupColorFromKey(key);
        const complete = group.cards.length >= SET_SIZE[color];
        const rentTier = Math.min(group.cards.length, SET_SIZE[color]) - 1;
        const baseRent = RENTS_LOCAL[color][rentTier] ?? 0;
        return <button key={key} onClick={() => onSubmit(color, doublersUsed)} className="flex items-center justify-between rounded-lg bg-felt px-3 py-2 text-left text-xs font-medium text-parchment hover:opacity-90"><span>{COLOR_LABEL[color]} {complete ? "✓" : ""}</span><span>{baseRent + (group.house ? 3 : 0) + (group.hotel ? 4 : 0)}M rent</span></button>;
      })}</div>}
    </ModalShell>
  );
}

const RENTS_LOCAL: Record<PropertyColor, number[]> = {
  brown: [1,2], lightblue: [1,2,3], pink: [1,2,4], orange: [1,3,5], red: [2,3,6], yellow: [2,4,6], green: [2,4,7], darkblue: [3,8], railroad: [1,2,3,4], utility: [1,2]
};

function PaymentModal({ board, amountOwed, selected, setSelected, onSubmit, onClose }: {
  board: Board; amountOwed: number; selected: Set<string>; setSelected: (s: Set<string>) => void; onSubmit: () => void; onClose: () => void;
}) {
  const eligibleGroups = Object.entries(board.properties).filter(([, g]) => g.cards.length > 0).filter(([key, g]) => g.cards.length < SET_SIZE[groupColorFromKey(key)]);
  const allCards: { card: Card; label: string }[] = [
    ...board.bank.map((c) => ({ card: c, label: `Cash ${c.value}M` })),
    ...eligibleGroups.flatMap(([color, g]) => g.cards.map((c) => ({ card: c, label: `Property ${COLOR_LABEL[groupColorFromKey(color)]} ${c.value}M` }))),
  ];
  const total = useMemo(() => allCards.filter((x) => selected.has(x.card.id)).reduce((s, x) => s + x.card.value, 0), [allCards, selected]);

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  }

  return (
    <ModalShell onClose={onClose} title={`Pay ${amountOwed}M`}>
      <p className="mb-2 text-[11px] text-felt/60">Completed property sets are protected and cannot be used as payment.</p>
      {allCards.length === 0 ? <p className="text-xs text-felt/60">You have no eligible cash or properties to pay with.</p> : <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">{allCards.map(({ card, label }) => <label key={card.id} className={`flex items-center gap-2 rounded-lg border px-2 py-2 text-xs text-felt ${selected.has(card.id) ? "border-felt/50 bg-felt/10" : "border-felt/10"}`}><input type="checkbox" checked={selected.has(card.id)} onChange={() => toggle(card.id)} />{label}</label>)}</div>}
      <div className="mt-3 flex items-center justify-between gap-3"><p className="text-xs text-felt/70">Selected: {total}M / {amountOwed}M owed</p><button onClick={onSubmit} disabled={allCards.length === 0 || total === 0} className="rounded-lg bg-felt px-3 py-2 text-xs font-medium text-parchment hover:opacity-90 disabled:opacity-50">Confirm payment</button></div>
      {total < amountOwed && allCards.length > 0 && <p className="mt-2 text-[11px] text-felt/50">If this is all eligible money/properties you have, you may pay the available total.</p>}
    </ModalShell>
  );
}

function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode; }) {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}><div className="w-full max-w-sm rounded-xl bg-parchment p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}><p className="mb-3 font-display text-sm font-semibold text-felt">{title}</p>{children}<button onClick={onClose} className="mt-3 text-xs text-felt/60 hover:text-felt">Cancel</button></div></div>;
}

function cardLabel(card: Card): string {
  switch (card.kind) {
    case "money": return `${card.value}M`;
    case "property": return `${card.name} (${COLOR_LABEL[card.color]})`;
    case "wildcard": return card.name;
    case "action": return `${card.name} (${card.value}M)`;
  }
}
