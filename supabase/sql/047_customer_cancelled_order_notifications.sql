create or replace function public.notify_customer_order_cancelled()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  order_code text;
  notification_body text;
begin
  if new.usuario_id is null then
    return new;
  end if;

  if not (
    old.estado is distinct from new.estado
    or old.financial_status is distinct from new.financial_status
  ) then
    return new;
  end if;

  if new.estado <> 'cancelado'
     and coalesce(new.financial_status, '') not in ('cancelled', 'cancellation_requested', 'refund_pending') then
    return new;
  end if;

  order_code := 'BX-' || (1000 + new.id);
  notification_body := case
    when coalesce(new.financial_status, '') in ('cancellation_requested', 'refund_pending') then
      'Tu pedido ' || order_code || ' fue cancelado correctamente. Estamos gestionando el reintegro correspondiente.'
    else
      'Tu pedido ' || order_code || ' fue cancelado correctamente.'
  end;

  insert into public.customer_notifications (
    user_id,
    type,
    title,
    body,
    action_url,
    order_id,
    source_key,
    is_read,
    created_at
  ) values (
    new.usuario_id,
    'order_cancelled',
    'Pedido cancelado',
    notification_body,
    '/cuenta/compras/' || new.id,
    new.id,
    'order:' || new.id || ':cancelled',
    false,
    now()
  )
  on conflict (source_key) do update
  set
    type = excluded.type,
    title = excluded.title,
    body = excluded.body,
    action_url = excluded.action_url,
    is_read = false,
    created_at = now();

  return new;
end;
$$;

drop trigger if exists zz_notify_customer_order_cancelled_trigger
  on public.ordenes;
create trigger zz_notify_customer_order_cancelled_trigger
after update of estado, financial_status
on public.ordenes
for each row
execute function public.notify_customer_order_cancelled();

update public.customer_notifications as notification
set
  type = 'order_cancelled',
  title = 'Pedido cancelado',
  body = case
    when coalesce(order_record.financial_status, '') in ('cancellation_requested', 'refund_pending') then
      'Tu pedido BX-' || (1000 + order_record.id) || ' fue cancelado correctamente. Estamos gestionando el reintegro correspondiente.'
    else
      'Tu pedido BX-' || (1000 + order_record.id) || ' fue cancelado correctamente.'
  end,
  action_url = '/cuenta/compras/' || order_record.id
from public.ordenes as order_record
where notification.order_id = order_record.id
  and (
    order_record.estado = 'cancelado'
    or coalesce(order_record.financial_status, '') in ('cancelled', 'cancellation_requested', 'refund_pending')
  )
  and notification.type in ('order_status', 'order_cancelled', 'refund_pending');
