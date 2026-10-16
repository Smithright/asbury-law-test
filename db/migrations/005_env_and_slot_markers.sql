-- 005: fail-closed environment marker + active pipeline slot. Comments are readable by every role,
-- so booking_sync needs no extra grant. Run the block for the branch you are on, never both.

-- production branch:
--   comment on schema public is 'env:production';
--   comment on table booking_requests is 'active_slot=prod-blue';

-- testing branch (named staging until 2026-10-16; see 006):
--   comment on schema public is 'env:testing';
--   comment on table booking_requests is 'active_slot=testing';

-- Cutover / rollback (production branch only; takes effect on the next run, <= 10 min):
--   comment on table booking_requests is 'active_slot=prod-green';   -- or prod-blue
-- Check:
--   select obj_description('public'::regnamespace) as env, obj_description('booking_requests'::regclass) as slot;
