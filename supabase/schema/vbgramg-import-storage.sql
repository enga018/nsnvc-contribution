-- NSNVC VB-GRAMG imported snapshots only.
-- Apply to the dedicated Supabase project nevpvawkmnnafqnmbghb.
-- Browser clients receive no table grants; the Edge Function uses server-side service-role access.

create table if not exists public.vbgramg_imports (
  id uuid primary key default gen_random_uuid(),
  source_url text not null,
  imported_by_uid text,
  imported_by_email text,
  record_count integer not null check (record_count >= 0),
  deleted_skipped integer not null default 0 check (deleted_skipped >= 0),
  status text not null default 'staging' check (status in ('staging','complete','failed')),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.vbgramg_records (
  import_id uuid not null references public.vbgramg_imports(id) on delete cascade,
  record_key text not null,
  serial integer not null check (serial > 0),
  job_card text not null,
  jc_no text not null,
  household text not null default '',
  applicant text not null default '',
  applicant_no integer not null default 1 check (applicant_no > 0),
  unique_id text not null,
  status text not null default 'Active',
  created_at timestamptz not null default now(),
  primary key (import_id, record_key),
  unique (import_id, serial)
);
create index if not exists vbgramg_records_import_serial_idx on public.vbgramg_records (import_id, serial);
create index if not exists vbgramg_records_job_card_idx on public.vbgramg_records (job_card);

create table if not exists public.vbgramg_import_state (
  singleton boolean primary key default true check (singleton),
  active_import_id uuid references public.vbgramg_imports(id) on delete set null,
  source_url text,
  record_count integer not null default 0 check (record_count >= 0),
  deleted_skipped integer not null default 0 check (deleted_skipped >= 0),
  updated_at timestamptz not null default now()
);
insert into public.vbgramg_import_state (singleton) values (true) on conflict (singleton) do nothing;

create table if not exists public.vbgramg_admins (
  email text primary key,
  created_at timestamptz not null default now()
);

alter table public.vbgramg_imports enable row level security;
alter table public.vbgramg_records enable row level security;
alter table public.vbgramg_import_state enable row level security;
alter table public.vbgramg_admins enable row level security;

revoke all on public.vbgramg_imports from anon, authenticated;
revoke all on public.vbgramg_records from anon, authenticated;
revoke all on public.vbgramg_import_state from anon, authenticated;
revoke all on public.vbgramg_admins from anon, authenticated;

grant select, insert, update, delete on public.vbgramg_imports to service_role;
grant select, insert, update, delete on public.vbgramg_records to service_role;
grant select, insert, update, delete on public.vbgramg_import_state to service_role;
grant select, insert, update, delete on public.vbgramg_admins to service_role;
