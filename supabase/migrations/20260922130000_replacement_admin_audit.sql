begin;

-- The order timeline already records replacements. Also expose the committed
-- operation in the central admin audit, with the actor validated by the RPC.
create function public.audit_order_replacement_created()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  insert into public.audit_logs (
    table_name, action, record_id, actor_user_id, actor_email, before_data, after_data
  ) values (
    'order_replacements', 'INSERT', new.id::text, new.created_by,
    (select email from public.profiles where id = new.created_by), null,
    to_jsonb(new) - 'idempotency_key'
  );
  return new;
end;
$$;
revoke all on function public.audit_order_replacement_created() from public, anon, authenticated;

create trigger order_replacements_admin_audit
after insert on public.order_replacements
for each row execute function public.audit_order_replacement_created();

commit;
