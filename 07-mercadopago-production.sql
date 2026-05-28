alter table public.ordenes
add column if not exists payment_id text;

alter table public.ordenes
add column if not exists payment_status text;

alter table public.ordenes
add column if not exists payment_method_id text;

alter table public.ordenes
add column if not exists payment_type_id text;

alter table public.ordenes
add column if not exists paid_at timestamptz;

alter table public.ordenes
add column if not exists tracking_number text;

alter table public.ordenes
add column if not exists tracking_url text;

create index if not exists ordenes_payment_id_idx
on public.ordenes(payment_id);

notify pgrst, 'reload schema';
