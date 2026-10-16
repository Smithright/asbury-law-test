-- 007: Veterans page "Start your free advance directives" form (written by api/veterans.js).
-- Alerts go to the same notification_recipients table as contact messages and bookings.
-- Apply on the testing branch and on production (same DDL).
create table if not exists veteran_requests (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  email        text not null check (char_length(email) between 3 and 254),
  name         text check (name is null or char_length(name) <= 200),
  branches     text[] not null default '{}' check (cardinality(branches) <= 7),
  wants        text[] not null default '{}' check (cardinality(wants) <= 4),
  source_page  text check (source_page is null or char_length(source_page) <= 200),
  user_agent   text check (user_agent is null or char_length(user_agent) <= 400),
  status       text not null default 'new' check (status in ('new', 'contacted', 'closed', 'spam')),
  notified_at  timestamptz
);
create index if not exists veteran_requests_created_at_idx on veteran_requests (created_at desc);
