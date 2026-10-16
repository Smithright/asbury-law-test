-- Free 30-minute call bookings, mirrored from Tom's Google Calendar booking page.
-- Written by the "Booking buffers (asbury-law.com)" Apps Script in tom@asbury-law.com,
-- which connects as the restricted role booking_sync (insert/update/select on this table only).
-- Apply on the `production` branch with the DIRECT (non-pooled) connection string.
create table if not exists booking_requests (
  id              bigint generated always as identity primary key,
  google_event_id text not null unique check (char_length(google_event_id) between 1 and 1024),
  start_at        timestamptz not null,
  end_at          timestamptz not null,
  status          text not null default 'booked' check (status in ('booked', 'cancelled')),
  name            text check (name is null or char_length(name) <= 200),
  email           text check (email is null or char_length(email) <= 254),
  phone           text check (phone is null or char_length(phone) <= 40),
  topic           text check (topic is null or char_length(topic) <= 5000),
  meet_url        text check (meet_url is null or char_length(meet_url) <= 300),
  raw_description text check (raw_description is null or char_length(raw_description) <= 10000),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  cancelled_at    timestamptz
);

create index if not exists booking_requests_start_at_idx on booking_requests (start_at desc);

-- Restricted login for the Apps Script. Create the role first in the Neon console
-- (Roles -> New role "booking_sync") so Neon generates the password, then run:
grant usage on schema public to booking_sync;
grant select, insert, update on booking_requests to booking_sync;
grant usage on sequence booking_requests_id_seq to booking_sync;
