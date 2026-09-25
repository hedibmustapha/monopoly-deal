import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

/**
 * Singleton browser Supabase client. Session (including the anonymous auth
 * session) persists in localStorage, which is what makes refresh/reconnect
 * work without losing your seat in the room.
 */
export function getSupabaseClient(): SupabaseClient {
  if (client) return client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. " +
        "Copy .env.local.example to .env.local and fill in your Supabase project values."
    );
  }

  client = createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });

  return client;
}

/**
 * Ensures the browser has an authenticated (anonymous) Supabase session.
 * Every player needs a stable auth.uid() — it's what RLS uses to scope
 * private data like hands later, and what lets a refreshed browser
 * reconnect as the same seat via join_room's "already seated" check.
 */
export async function ensureSession() {
  const supabase = getSupabaseClient();
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session;

  const { data: signInData, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  return signInData.session;
}
