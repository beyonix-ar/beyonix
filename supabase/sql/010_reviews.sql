create table if not exists public.reviews (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  order_id bigint not null references public.ordenes(id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  comment text not null check (
    char_length(trim(comment)) between 1 and 150
  ),
  nickname text not null check (
    char_length(trim(nickname)) between 1 and 24
  ),
  city text not null check (
    char_length(trim(city)) between 1 and 45
  ),
  province text not null check (
    char_length(trim(province)) between 1 and 45
  ),
  approved boolean not null default true,
  created_at timestamptz not null default now(),
  constraint reviews_one_per_order unique (user_id, order_id)
);

create index if not exists reviews_created_at_idx
  on public.reviews (created_at desc);

create index if not exists reviews_user_id_idx
  on public.reviews (user_id);

alter table public.reviews enable row level security;

drop policy if exists "Public can read approved reviews"
  on public.reviews;

create policy "Public can read approved reviews"
  on public.reviews
  for select
  using (approved = true);

drop policy if exists "Customers can create reviews for paid orders"
  on public.reviews;

create policy "Customers can create reviews for paid orders"
  on public.reviews
  for insert
  to authenticated
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.ordenes
      where ordenes.id = order_id
        and ordenes.usuario_id = auth.uid()
        and (
          ordenes.estado in ('pagado', 'enviado', 'entregado')
          or ordenes.payment_status = 'approved'
        )
    )
  );

drop policy if exists "Customers can delete their own reviews"
  on public.reviews;

create policy "Customers can delete their own reviews"
  on public.reviews
  for delete
  to authenticated
  using (auth.uid() = user_id);

grant select on public.reviews to anon, authenticated;
grant insert, delete on public.reviews to authenticated;
grant usage, select on sequence public.reviews_id_seq to authenticated;
