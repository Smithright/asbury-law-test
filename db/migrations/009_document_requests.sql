-- 009: On-Demand Documents "Get notified. Get heard." form (written by api/document-request.js).
-- Alerts go to the same notification_recipients table as every other form.
-- Apply on the testing branch AND on production (same DDL).
create table if not exists document_requests (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  email        text not null check (char_length(email) between 3 and 254),
  name         text check (name is null or char_length(name) <= 200),
  interests    text[] not null default '{}' check (cardinality(interests) <= 4),
  documents    text[] not null default '{}' check (cardinality(documents) <= 40),
  message      text check (message is null or char_length(message) <= 2000),
  source_page  text check (source_page is null or char_length(source_page) <= 200),
  user_agent   text check (user_agent is null or char_length(user_agent) <= 400),
  status       text not null default 'new' check (status in ('new', 'contacted', 'closed', 'spam')),
  notified_at  timestamptz
);
create index if not exists document_requests_created_at_idx on document_requests (created_at desc);
