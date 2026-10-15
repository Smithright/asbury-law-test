-- Who gets an email when a contact message arrives. Edit rows in the Neon console (Tables page);
-- changes apply to the next message, no redeploy.
create table if not exists notification_recipients (
  id              bigint generated always as identity primary key,
  email           text not null unique check (char_length(email) between 3 and 254),
  name            text check (name is null or char_length(name) <= 100),
  active          boolean not null default true,
  include_message boolean not null default true,  -- false = details only, read the message in Neon
  created_at      timestamptz not null default now()
);

-- Set when every active recipient was emailed successfully; null = alert pending or failed.
alter table contact_submissions add column if not exists notified_at timestamptz;

insert into notification_recipients (email, name, active) values
  ('ryan@smithright.com', 'Ryan Smith', true),
  ('Tom@Asbury-Law.com', 'Thomas Asbury', false)
on conflict (email) do nothing;
