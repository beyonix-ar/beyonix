do $$
declare
  realtime_table text;
begin
  if not exists (
    select 1
    from pg_publication
    where pubname = 'supabase_realtime'
      and not puballtables
  ) then
    return;
  end if;

  foreach realtime_table in array array[
    'ordenes',
    'orden_items',
    'admin_events',
    'order_claims',
    'order_claim_messages',
    'order_claim_files',
    'order_refund_proofs',
    'order_audit_events',
    'admin_order_views',
    'admin_order_event_views',
    'admin_notification_reads',
    'customer_credit_topups',
    'customer_credit_movements',
    'customer_gift_cards'
  ]
  loop
    if to_regclass(format('public.%I', realtime_table)) is not null
      and not exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = realtime_table
      )
    then
      execute format(
        'alter publication supabase_realtime add table public.%I',
        realtime_table
      );
    end if;
  end loop;
end $$;
