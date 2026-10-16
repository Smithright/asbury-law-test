-- 005: fail-closed environment marker + active pipeline slot. Comments are readable by every role,
-- so booking_sync needs no extra grant. Run the block for the branch you are on, never both.

-- production branch:
--   comment on schema public is 'env:production';
--   comment on table booking_requests is 'active_slot=prod-blue';

-- staging branch:
--   comment on schema public is 'env:staging';
--   comment on table booking_requests is 'active_slot=staging';

-- Cutover / rollback (production branch only; takes effect on the next run, <= 10 min):
--   comment on table booking_requests is 'active_slot=prod-green';   -- or prod-blue
-- Check:
--   select obj_description('public'::regnamespace) as env, obj_description('booking_requests'::regclass) as slot;
