-- Atlas Domea — schema iniziale
-- Ospiti identificati dal numero WhatsApp; messaggi con ruolo guest/atlas/host.

create table if not exists guests (
  id uuid primary key default gen_random_uuid(),
  phone text unique not null,
  name text,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  guest_id uuid not null references guests(id) on delete cascade,
  role text not null check (role in ('guest','atlas','host')),
  wa_message_id text unique,
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_messages_guest_created on messages (guest_id, created_at);

-- Nessuna policy: accesso solo con service role (Edge Functions).
alter table guests enable row level security;
alter table messages enable row level security;
