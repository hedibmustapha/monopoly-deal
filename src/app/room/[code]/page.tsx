"use client";

import { useCallback, useEffect, useState } from "react";
import { ensureSession, getSupabaseClient } from "@/lib/supabase/client";
import { callGameAction } from "@/lib/supabase/functions";
import GameTable from "@/components/GameTable";
import type { Player, Room } from "@/lib/types";

export default function RoomPage({ params }: { params: { code: string } }) {
  const code = params.code.toUpperCase();

  const [room, setRoom] = useState<Room | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Only asked for if this browser lands on the URL without having joined
  // yet (e.g. opening a shared link directly) — the partner's own path.
  const [joinName, setJoinName] = useState("");
  const [joining, setJoining] = useState(false);
  const [starting, setStarting] = useState(false);

  async function handleStart() {
    if (!room) return;
    setStarting(true);
    setError(null);
    const result = await callGameAction("start_game", { room_id: room.id });
    if (result.error) setError(result.error);
    setStarting(false);
  }

  const loadPlayers = useCallback(async (roomId: string) => {
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from("players")
      .select("*")
      .eq("room_id", roomId)
      .order("seat", { ascending: true });
    if (data) setPlayers(data as Player[]);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let channel: ReturnType<ReturnType<typeof getSupabaseClient>["channel"]> | null =
      null;

    (async () => {
      try {
        const session = await ensureSession();
        if (cancelled) return;
        setMyUserId(session?.user.id ?? null);

        const supabase = getSupabaseClient();
        const { data: roomData, error: roomError } = await supabase
          .from("rooms")
          .select("*")
          .eq("code", code)
          .maybeSingle();

        if (roomError) throw roomError;
        if (!roomData) {
          setError("No room found with that code. Check the link and try again.");
          setLoading(false);
          return;
        }
        if (cancelled) return;
        setRoom(roomData as Room);
        await loadPlayers(roomData.id);

        channel = supabase
          .channel(`room:${roomData.id}`)
          .on(
            "postgres_changes",
            {
              event: "*",
              schema: "public",
              table: "players",
              filter: `room_id=eq.${roomData.id}`,
            },
            () => loadPlayers(roomData.id)
          )
          .on(
            "postgres_changes",
            {
              event: "UPDATE",
              schema: "public",
              table: "rooms",
              filter: `id=eq.${roomData.id}`,
            },
            (payload) => setRoom(payload.new as Room)
          )
          .subscribe();

        setLoading(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (channel) getSupabaseClient().removeChannel(channel);
    };
  }, [code, loadPlayers]);

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    if (!joinName.trim() || !room) return;
    setJoining(true);
    setError(null);
    try {
      const supabase = getSupabaseClient();
      const { error } = await supabase.rpc("join_room", {
        p_code: code,
        p_display_name: joinName.trim(),
      });
      if (error) throw error;
      await loadPlayers(room.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't join that room.");
    } finally {
      setJoining(false);
    }
  }

  const iAmSeated = players.some((p) => p.user_id === myUserId);
  const shareUrl =
    typeof window !== "undefined" ? `${window.location.origin}/room/${code}` : "";

  if (loading) {
    return (
      <Centered>
        <p className="text-parchment/80">Loading room…</p>
      </Centered>
    );
  }

  if (error && !room) {
    return (
      <Centered>
        <p className="text-parchment">{error}</p>
      </Centered>
    );
  }

  if (room && !iAmSeated) {
    return (
      <Centered>
        <div className="w-full max-w-sm rounded-2xl bg-parchment p-6 shadow-xl">
          <h1 className="font-display text-2xl font-semibold text-felt">
            Join room {code}
          </h1>
          <form onSubmit={handleJoin} className="mt-4 flex flex-col gap-3">
            <label className="text-sm font-medium text-felt">
              Your name
              <input
                autoFocus
                value={joinName}
                onChange={(e) => setJoinName(e.target.value)}
                maxLength={24}
                className="mt-1 w-full rounded-lg border border-felt/20 px-3 py-2 text-felt outline-none focus:border-felt"
                placeholder="e.g. Jordan"
              />
            </label>
            <button
              type="submit"
              disabled={joining || !joinName.trim()}
              className="rounded-lg bg-felt px-4 py-3 font-medium text-parchment transition hover:opacity-90 disabled:opacity-50"
            >
              {joining ? "Joining…" : "Join game"}
            </button>
            {error && (
              <p className="text-sm text-red-600" role="alert">
                {error}
              </p>
            )}
          </form>
        </div>
      </Centered>
    );
  }

  const opponent = players.find((p) => p.user_id !== myUserId);

  if (room.status === "playing" && myUserId) {
    return (
      <main className="min-h-screen">
        <GameTable room={room} players={players} myUserId={myUserId} />
      </main>
    );
  }

  return (
    <Centered>
      <div className="w-full max-w-sm rounded-2xl bg-parchment p-6 shadow-xl">
        <h1 className="font-display text-2xl font-semibold text-felt">
          Room {code}
        </h1>

        {players.length < 2 ? (
          <div className="mt-4">
            <p className="text-sm text-felt/80">
              Waiting for your partner to join. Send them this link:
            </p>
            <div className="mt-2 flex items-center gap-2">
              <input
                readOnly
                value={shareUrl}
                className="flex-1 rounded-lg border border-felt/20 bg-white px-3 py-2 text-sm text-felt"
                onFocus={(e) => e.currentTarget.select()}
              />
              <button
                onClick={() => navigator.clipboard.writeText(shareUrl)}
                className="rounded-lg bg-felt px-3 py-2 text-sm font-medium text-parchment hover:opacity-90"
              >
                Copy
              </button>
            </div>
            <p className="mt-3 text-xs text-felt/50">
              Or they can enter code <span className="font-semibold">{code}</span> on
              the home screen.
            </p>
          </div>
        ) : (
          <div className="mt-4">
            <p className="text-sm text-felt/80">Both players are here.</p>
            <button
              onClick={handleStart}
              disabled={starting}
              className="mt-2 w-full rounded-lg bg-felt px-4 py-3 font-medium text-parchment transition hover:opacity-90 disabled:opacity-50"
            >
              {starting ? "Starting…" : "Start game"}
            </button>
            {error && (
              <p className="mt-2 text-sm text-red-600" role="alert">
                {error}
              </p>
            )}
          </div>
        )}

        <ul className="mt-5 flex flex-col gap-2">
          {[0, 1].map((seat) => {
            const p = players.find((pl) => pl.seat === seat);
            const isMe = p?.user_id === myUserId;
            return (
              <li
                key={seat}
                className="flex items-center justify-between rounded-lg border border-felt/10 px-3 py-2"
              >
                <span className="text-felt">
                  {p ? p.display_name : "Waiting for player…"}
                  {isMe && <span className="text-felt/50"> (you)</span>}
                </span>
                {p && (
                  <span className="h-2 w-2 rounded-full bg-green-500" title="Connected" />
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 py-16">
      {children}
    </main>
  );
}
