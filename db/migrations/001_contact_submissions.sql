-- Contact page submissions (written by api/contact.js).
-- Apply with the DIRECT (non-pooled) connection string.
create table if not exists contact_submissions (
  id                bigint generated always as identity primary key,
  created_at        timestamptz not null default now(),
  first_name        text not null check (char_length(first_name) between 1 and 100),
  last_name         text not null check (char_length(last_name) between 1 and 100),
  email             text not null check (char_length(email) between 3 and 254),
  phone             text check (phone is null or char_length(phone) <= 40),
  topic             text not null check (char_length(topic) between 1 and 80),
  message           text not null check (char_length(message) between 1 and 5000),
  preferred_contact text not null default 'email' check (preferred_contact in ('email', 'phone')),
  consent           boolean not null check (consent),
  source_page       text check (source_page is null or char_length(source_page) <= 200),
  user_agent        text check (user_agent is null or char_length(user_agent) <= 400),
  status            text not null default 'new' check (status in ('new', 'contacted', 'closed', 'spam'))
);

create index if not exists contact_submissions_created_at_idx
  on contact_submissions (created_at desc);
