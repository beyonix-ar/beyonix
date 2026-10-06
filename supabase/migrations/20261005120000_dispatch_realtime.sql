-- Realtime de Despachos: sólo lectura para roles internos; mutaciones siguen en RPC service_role.
-- El corte operativo queda disponible como dato independiente del estado de entrega.
alter table public.dispatch_batches add column prepared_at timestamptz
  generated always as (case when status in ('closed','handed_over') then closed_at else null end) stored;

grant select on public.dispatch_blocks, public.dispatch_batches,
  public.dispatch_batch_items, public.order_packages to authenticated;

create policy dispatch_blocks_internal_read on public.dispatch_blocks
  for select to authenticated using (public.is_current_user_internal());
create policy dispatch_batches_internal_read on public.dispatch_batches
  for select to authenticated using (public.is_current_user_internal());
create policy dispatch_batch_items_internal_read on public.dispatch_batch_items
  for select to authenticated using (public.is_current_user_internal());
create policy order_packages_internal_read on public.order_packages
  for select to authenticated using (public.is_current_user_internal());

do $$
declare v_table text;
begin
  foreach v_table in array array['dispatch_blocks','dispatch_batches','dispatch_batch_items','order_packages'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = v_table
    ) then
      execute format('alter publication supabase_realtime add table public.%I', v_table);
    end if;
  end loop;
end $$;
