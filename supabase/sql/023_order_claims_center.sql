insert into storage.buckets (id, name, public)
values ('order-claim-evidence', 'order-claim-evidence', false)
on conflict (id) do update
set public = false;

alter table public.ordenes
  add column if not exists delivered_at timestamptz;

create table if not exists public.order_claims (
  id bigserial primary key,
  order_id bigint not null references public.ordenes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  claim_type text not null,
  status text not null default 'recibido',
  failure_type text,
  description text not null,
  started_at text,
  admin_response text,
  rejection_reason text,
  resolution text,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint order_claims_claim_type_check check (
    claim_type in ('transporte_48hs', 'garantia_beyonix')
  ),
  constraint order_claims_status_check check (
    status in (
      'recibido',
      'en_revision',
      'falta_informacion',
      'aprobado',
      'rechazado',
      'cerrado'
    )
  ),
  constraint order_claims_resolution_check check (
    resolution is null
    or resolution in (
      'cambio_producto',
      'reintegro_total',
      'reintegro_parcial',
      'cupon_descuento',
      'rechazado',
      'otro'
    )
  )
);

create table if not exists public.order_claim_messages (
  id bigserial primary key,
  claim_id bigint not null references public.order_claims(id) on delete cascade,
  author_user_id uuid references auth.users(id) on delete set null,
  author_role text not null,
  message text not null,
  created_at timestamptz not null default now(),
  constraint order_claim_messages_author_role_check check (
    author_role in ('cliente', 'operador', 'admin', 'super_admin')
  )
);

create table if not exists public.order_claim_files (
  id bigserial primary key,
  claim_id bigint not null references public.order_claims(id) on delete cascade,
  uploaded_by uuid references auth.users(id) on delete set null,
  file_role text not null,
  file_name text not null,
  file_path text not null,
  mime_type text not null,
  file_size bigint not null,
  created_at timestamptz not null default now(),
  constraint order_claim_files_file_role_check check (
    file_role in (
      'embalaje_exterior',
      'producto_completo',
      'danio',
      'funcionamiento_foto',
      'video',
      'evidencia_adicional'
    )
  )
);

create unique index if not exists order_claims_one_active_per_order_idx
  on public.order_claims (order_id)
  where status in (
    'recibido',
    'en_revision',
    'falta_informacion',
    'aprobado'
  );

create index if not exists order_claims_order_id_idx
  on public.order_claims (order_id, created_at desc);

create index if not exists order_claim_messages_claim_id_idx
  on public.order_claim_messages (claim_id, created_at asc);

create index if not exists order_claim_files_claim_id_idx
  on public.order_claim_files (claim_id, created_at asc);

create or replace function public.touch_order_claim_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists touch_order_claim_updated_at_trigger
  on public.order_claims;

create trigger touch_order_claim_updated_at_trigger
  before update on public.order_claims
  for each row
  execute function public.touch_order_claim_updated_at();
