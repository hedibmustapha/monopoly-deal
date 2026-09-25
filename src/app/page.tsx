"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ensureSession, getSupabaseClient } from "@/lib/supabase/client";
import type { Room, Player } from "@/lib/types";

type Mode = "choose" | "create" | "join";

export default function HomePage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("choose");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await ensureSession();
      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .rpc("create_room", { p_display_name: name.trim() })
        .single<Room>();
      if (error) throw error;
      router.push(`/room/${data.code}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(false);
    }
  }

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await ensureSession();
      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .rpc("join_room", {
          p_code: code.trim().toUpperCase(),
          p_display_name: name.trim(),
        })
        .single<Player>();
      if (error) throw error;
      router.push(`/room/${code.trim().toUpperCase()}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't join that room.");
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <h1 className="font-display text-4xl font-semibold text-parchment text-center">
          Monopoly Deal
        </h1>
        <p className="mt-2 text-center text-sm text-parchment/70">
          A private table for two.
        </p>

        <div className="mt-10 rounded-2xl bg-parchment p-6 shadow-xl">
          {mode === "choose" && (
            <div className="flex flex-col gap-3">
              <button
                onClick={() => setMode("create")}
                className="rounded-lg bg-felt px-4 py-3 font-medium text-parchment transition hover:opacity-90"
              >
                Start a new game
              </button>
              <button
                onClick={() => setMode("join")}
                className="rounded-lg border border-felt/30 px-4 py-3 font-medium text-felt transition hover:bg-felt/5"
              >
                Join with a code
              </button>
            </div>
          )}

          {mode === "create" && (
            <form onSubmit={handleCreate} className="flex flex-col gap-3">
              <label className="text-sm font-medium text-felt">
                Your name
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={24}
                  className="mt-1 w-full rounded-lg border border-felt/20 px-3 py-2 text-felt outline-none focus:border-felt"
                  placeholder="e.g. Sam"
                />
              </label>
              <button
                type="submit"
                disabled={busy || !name.trim()}
                className="rounded-lg bg-felt px-4 py-3 font-medium text-parchment transition hover:opacity-90 disabled:opacity-50"
              >
                {busy ? "Creating…" : "Create room"}
              </button>
              <button
                type="button"
                onClick={() => setMode("choose")}
                className="text-sm text-felt/60 hover:text-felt"
              >
                Back
              </button>
            </form>
          )}

          {mode === "join" && (
            <form onSubmit={handleJoin} className="flex flex-col gap-3">
              <label className="text-sm font-medium text-felt">
                Your name
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={24}
                  className="mt-1 w-full rounded-lg border border-felt/20 px-3 py-2 text-felt outline-none focus:border-felt"
                  placeholder="e.g. Sam"
                />
              </label>
              <label className="text-sm font-medium text-felt">
                Room code
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  maxLength={5}
                  className="mt-1 w-full rounded-lg border border-felt/20 px-3 py-2 tracking-widest text-felt outline-none focus:border-felt"
                  placeholder="ABCDE"
                />
              </label>
              <button
                type="submit"
                disabled={busy || !name.trim() || !code.trim()}
                className="rounded-lg bg-felt px-4 py-3 font-medium text-parchment transition hover:opacity-90 disabled:opacity-50"
              >
                {busy ? "Joining…" : "Join room"}
              </button>
              <button
                type="button"
                onClick={() => setMode("choose")}
                className="text-sm text-felt/60 hover:text-felt"
              >
                Back
              </button>
            </form>
          )}

          {error && (
            <p className="mt-3 text-sm text-red-600" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
