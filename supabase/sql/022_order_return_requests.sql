alter table public.ordenes
  add column if not exists return_status text,
  add column if not exists return_reason text,
  add column if not exists return_requested_at timestamptz,
  add column if not exists return_resolved_at timestamptz,
  add column if not exists return_admin_note text;

alter table public.ordenes
  drop constraint if exists ordenes_return_status_check;

alter table public.ordenes
  add constraint ordenes_return_status_check
  check (
    return_status is null
    or return_status in (
      'solicitada',
      'en_revision',
      'aprobada',
      'rechazada',
      'resuelta'
    )
  );

create index if not exists ordenes_return_status_idx
  on public.ordenes (return_status)
  where return_status is not null;
