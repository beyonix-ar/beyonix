create table if not exists public.admin_notification_reads (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references auth.users(id) on delete cascade,
  type text not null,
  event_key text not null,
  event_at timestamptz not null,
  read_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (admin_id, type, event_key)
);

create index if not exists admin_notification_reads_lookup_idx
  on public.admin_notification_reads (admin_id, type, event_key);

alter table public.admin_notification_reads enable row level security;

drop policy if exists "Admins can read own notification reads"
  on public.admin_notification_reads;
create policy "Admins can read own notification reads"
on public.admin_notification_reads
for select
to authenticated
using (
  admin_id = auth.uid()
  and exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.rol in ('operador', 'admin', 'super_admin')
  )
);

drop policy if exists "Admins can insert own notification reads"
  on public.admin_notification_reads;
create policy "Admins can insert own notification reads"
on public.admin_notification_reads
for insert
to authenticated
with check (
  admin_id = auth.uid()
  and exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.rol in ('operador', 'admin', 'super_admin')
  )
);

drop policy if exists "Admins can update own notification reads"
  on public.admin_notification_reads;
create policy "Admins can update own notification reads"
on public.admin_notification_reads
for update
to authenticated
using (
  admin_id = auth.uid()
  and exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.rol in ('operador', 'admin', 'super_admin')
  )
)
with check (
  admin_id = auth.uid()
  and exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.rol in ('operador', 'admin', 'super_admin')
  )
);

grant select, insert, update on public.admin_notification_reads to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.admin_notification_reads;
exception
  when duplicate_object then null;
end $$;
