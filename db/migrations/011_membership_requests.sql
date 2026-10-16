-- 011: Attorney on Retainer "Request membership" form (written by api/membership-request.js).
-- Alerts go to the same notification_recipients table as every other form.
-- Apply on the testing branch AND on production (same DDL).
create table if not exists membership_requests (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  email        text not null check (char_length(email) between 3 and 254),
  phone        text check (phone is null or char_length(phone) <= 40),
  tiers        text[] not null default '{}' check (cardinality(tiers) <= 3),
  veteran      boolean not null default false,
  source_page  text check (source_page is null or char_length(source_page) <= 200),
  user_agent   text check (user_agent is null or char_length(user_agent) <= 400),
  status       text not null default 'new' check (status in ('new', 'contacted', 'closed', 'spam')),
  notified_at  timestamptz
);
create index if not exists membership_requests_created_at_idx on membership_requests (created_at desc);
