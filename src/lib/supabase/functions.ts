import { getSupabaseClient } from "./client";

export type ActionName =
  | "start_game"
  | "rematch"
  | "draw"
  | "play_money"
  | "play_property"
  | "discard"
  | "end_turn"
  | "play_rent"
  | "play_debt_collector"
  | "play_birthday"
  | "play_sly_deal"
  | "play_forced_deal"
  | "play_deal_breaker"
  | "play_house"
  | "play_hotel"
  | "play_pass_go"
  | "play_just_say_no"
  | "resolve_action"
  | "pay_demand";

export async function callGameAction(
  action: ActionName,
  params: Record<string, unknown>
): Promise<{ ok?: boolean; error?: string; [k: string]: unknown }> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.functions.invoke("game-actions", {
    body: { action, ...params },
  });
  if (error) {
    // supabase-js's `error.message` is a generic "non-2xx status" string —
    // the function's actual { error: "..." } body is on error.context,
    // which is the raw fetch Response and has to be parsed separately.
    const context = (error as { context?: Response }).context;
    if (context) {
      try {
        const body = await context.clone().json();
        if (body?.error) return { error: body.error };
      } catch {
        try {
          const text = await context.clone().text();
          if (text) return { error: text };
        } catch {
          // fall through to generic message below
        }
      }
    }
    return { error: error.message ?? "Action failed" };
  }
  return data;
}
