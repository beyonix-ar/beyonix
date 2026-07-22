-- Los movimientos de saldo sin pedido deben abrir el resumen de Mi cuenta,
-- donde el cliente puede consultar su saldo disponible.
update public.customer_notifications
set action_url = '/cuenta'
where type = 'customer_credit'
  and order_id is null;

create or replace function public.notify_customer_credit_movement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_title text;
  v_body text;
  v_amount text;
begin
  if new.user_id is null then
    return new;
  end if;

  v_amount := to_char(new.amount, 'FM$999G999G999G990');

  if new.movement_type = 'debit' then
    v_title := 'Saldo a favor usado';
    v_body := 'Usaste ' || v_amount || ' de tu saldo a favor' ||
      case when new.order_id is not null then ' en el pedido BX-' || (1000 + new.order_id)::text else '' end || '.';
  elsif new.movement_type = 'reversal' then
    v_title := 'Saldo a favor reintegrado';
    v_body := 'Se devolvieron ' || v_amount || ' a tu saldo a favor.';
  else
    v_title := 'Saldo a favor acreditado';
    v_body := 'Se acreditaron ' || v_amount || ' en tu saldo a favor.';
  end if;

  insert into public.customer_notifications (
    user_id,
    type,
    title,
    body,
    action_url,
    order_id,
    source_key
  ) values (
    new.user_id,
    'customer_credit',
    v_title,
    v_body,
    case when new.order_id is null then '/cuenta' else '/cuenta?tab=saldo' end,
    new.order_id,
    'customer-credit:' || new.id::text
  )
  on conflict (source_key) do nothing;

  return new;
end;
$$;
