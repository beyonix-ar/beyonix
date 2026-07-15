alter table public.ordenes
  alter column usuario_id drop not null;

create index if not exists ordenes_guest_created_at_idx
  on public.ordenes (created_at desc)
  where usuario_id is null;
