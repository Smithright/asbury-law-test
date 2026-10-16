-- 006: rename the pre-production environment from "staging" to "testing" (2026-10-16, per Ryan).
-- Neon branch "staging" was renamed "testing" in the console (same branch, same endpoint and connection strings).
-- Run on the testing branch only, right after the code that expects env:testing is deployed:
comment on schema public is 'env:testing';
comment on table booking_requests is 'active_slot=testing';
-- Check:
--   select obj_description('public'::regnamespace) as env, obj_description('booking_requests'::regclass) as slot;
