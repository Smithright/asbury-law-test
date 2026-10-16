-- 004: booking notices (claim-then-send). Applied to production and inherited by staging on 2026-10-15.
alter table booking_requests add column if not exists notified_at timestamptz;
grant select on notification_recipients to booking_sync;
