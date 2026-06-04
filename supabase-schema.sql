create extension if not exists "pgcrypto";

create table if not exists offices (
  id text primary key,
  room text not null,
  meta text,
  price_hour_nok int not null,
  price_day_nok int not null,
  price_month_nok int not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  office_id text not null references offices(id),
  room text not null,
  mode text not null check (mode in ('hour','day','month')),
  start_date date not null,
  end_date date not null,
  hour int check (hour is null or (hour >= 0 and hour <= 23)),
  months int not null default 1,
  qty int not null default 1,
  label text not null,
  amount_nok int not null,
  customer_name text not null,
  customer_company text,
  customer_email text not null,
  customer_phone text,
  payment_method text not null default 'card' check (payment_method in ('card','vipps','invoice')),
  message text,
  status text not null check (status in ('pending_payment','pending_invoice','confirmed','cancelled','expired')),
  stripe_session_id text unique,
  stripe_payment_intent text,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  constraint booking_date_order check (end_date >= start_date)
);

create index if not exists bookings_lookup_idx on bookings (office_id, start_date, end_date, status);

insert into offices (id, room, meta, price_hour_nok, price_day_nok, price_month_nok)
values
('a', 'Kontor A', 'Hjørnekontor · 1–2 personer · 12 m²', 180, 950, 9500),
('b', 'Kontor B', 'Midtkontor · 1–2 personer · 12 m²', 140, 750, 7500),
('c', 'Kontor C', 'Lite kontor · 1 person', 120, 600, 6000)
on conflict (id) do update set
  room = excluded.room,
  meta = excluded.meta,
  price_hour_nok = excluded.price_hour_nok,
  price_day_nok = excluded.price_day_nok,
  price_month_nok = excluded.price_month_nok,
  active = true;
