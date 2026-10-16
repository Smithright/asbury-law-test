-- 008: Estate Planning "Start your plan" form (written by api/plan-request.js).
-- Alerts go to the same notification_recipients table as every other form.
-- Apply on the testing branch AND on production (same DDL); backend prod matches test.
create table if not exists plan_requests (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  plan         text not null check (plan in ('foundations', 'cornerstone', 'pinnacle')),
  addons       text[] not null default '{}' check (cardinality(addons) <= 6),
  first_name   text not null check (char_length(first_name) between 1 and 100),
  last_name    text not null check (char_length(last_name) between 1 and 100),
  email        text not null check (char_length(email) between 3 and 254),
  phone        text check (phone is null or char_length(phone) <= 40),
  message      text check (message is null or char_length(message) <= 2000),
  consent      boolean not null check (consent),
  source_page  text check (source_page is null or char_length(source_page) <= 200),
  user_agent   text check (user_agent is null or char_length(user_agent) <= 400),
  status       text not null default 'new' check (status in ('new', 'contacted', 'engaged', 'closed', 'spam')),
  notified_at  timestamptz
);
create index if not exists plan_requests_created_at_idx on plan_requests (created_at desc);
