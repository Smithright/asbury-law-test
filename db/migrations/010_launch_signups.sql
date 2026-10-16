-- 010: What's Next "Be first in." form (written by api/launch-signup.js).
-- Alerts go to the same notification_recipients table as every other form.
-- Apply on the testing branch AND on production (same DDL).
create table if not exists launch_signups (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  email        text not null check (char_length(email) between 3 and 254),
  name         text check (name is null or char_length(name) <= 200),
  interests    text[] not null default '{}' check (cardinality(interests) <= 7),
  documents    text[] not null default '{}' check (cardinality(documents) <= 40),
  message      text check (message is null or char_length(message) <= 2000),
  source_page  text check (source_page is null or char_length(source_page) <= 200),
  user_agent   text check (user_agent is null or char_length(user_agent) <= 400),
  status       text not null default 'new' check (status in ('new', 'contacted', 'closed', 'spam')),
  notified_at  timestamptz
);
create index if not exists launch_signups_created_at_idx on launch_signups (created_at desc);
