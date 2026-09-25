-- ============================================================================
-- Monopoly Deal — Stage 4 schema addition
-- Rent / Debt Collector / Birthday pause the game with a payment demand
-- that the target player must resolve via pay_demand before anything else
-- can happen. No new tables — this is a single column on game_state.
-- ============================================================================

alter table public.game_state
  add column if not exists pending_action jsonb;

-- pending_action shape (when not null):
-- {
--   "type": "payment_demand",
--   "from_seat": 0 | 1,   -- who is owed money
--   "to_seat": 0 | 1,     -- who must pay
--   "amount": number,     -- in millions
--   "reason": string      -- e.g. "Rent (Green)", "Debt Collector"
-- }
