create or replace function public.audit_admin_balance_adjustment()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_actor_email text;
  v_target_email text;
  v_target_name text;
begin
  if new.metadata->>'source_kind' <> 'balance_adjustment' then
    return new;
  end if;

  select coalesce(profiles.email, users.email::text)
  into v_actor_email
  from auth.users
  left join public.profiles on profiles.id = users.id
  where users.id = new.created_by;

  select
    coalesce(profiles.email, users.email::text),
    coalesce(nullif(profiles.nombre, ''), nullif(profiles.username, ''), users.email::text)
  into v_target_email, v_target_name
  from auth.users
  left join public.profiles on profiles.id = users.id
  where users.id = new.user_id;

  insert into public.audit_logs (
    table_name,
    action,
    record_id,
    actor_user_id,
    actor_email,
    before_data,
    after_data
  ) values (
    'customer_credit_movements',
    'INSERT',
    new.id::text,
    new.created_by,
    v_actor_email,
    null,
    jsonb_build_object(
      'movement_type', new.movement_type,
      'amount', new.amount,
      'description', new.description,
      'target_user_id', new.user_id,
      'target_name', v_target_name,
      'target_email', v_target_email,
      'resulting_balance', new.resulting_balance,
      'source_kind', new.metadata->>'source_kind',
      'created_from', new.metadata->>'created_from'
    )
  );

  return new;
end;
$$;

drop trigger if exists audit_admin_balance_adjustment_trigger
  on public.customer_credit_movements;

create trigger audit_admin_balance_adjustment_trigger
after insert on public.customer_credit_movements
for each row
execute function public.audit_admin_balance_adjustment();

comment on function public.audit_admin_balance_adjustment() is
  'Registra de forma transaccional en Auditoría cada crédito o débito administrativo de saldo.';
