create or replace function public.notify_customer_order_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.usuario_id is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.payment_method_id = 'transferencia'
       and coalesce(new.payment_status, '') = 'pendiente_comprobante'
       and new.payment_proof_url is null
       and new.payment_proof_uploaded_at is null then
      insert into public.customer_notifications (
        user_id,
        type,
        title,
        body,
        action_url,
        order_id,
        source_key
      ) values (
        new.usuario_id,
        'payment_proof_pending',
        'Comprobante pendiente',
        'Subí el comprobante para que podamos confirmar tu pago.',
        '/checkout/success?method=transferencia&order_id=' || new.id,
        new.id,
        'order:' || new.id || ':payment-proof-pending'
      )
      on conflict (source_key) do nothing;
    end if;

    return new;
  end if;

  if new.payment_method_id = 'transferencia'
     and (
       old.payment_proof_url is distinct from new.payment_proof_url
       or old.payment_proof_uploaded_at is distinct from new.payment_proof_uploaded_at
       or old.payment_status is distinct from new.payment_status
     )
     and coalesce(new.payment_status, '') <> 'confirmado'
     and (new.payment_proof_url is not null or new.payment_proof_uploaded_at is not null) then
    update public.customer_notifications
    set
      type = 'payment_proof_received',
      title = 'Comprobante recibido',
      body = 'Recibimos tu comprobante y estamos revisando el pago.',
      action_url = '/cuenta?tab=ordenes',
      is_read = false
    where order_id = new.id
      and type = 'payment_proof_pending';

    if not found then
      insert into public.customer_notifications (
        user_id,
        type,
        title,
        body,
        action_url,
        order_id,
        source_key
      ) values (
        new.usuario_id,
        'payment_proof_received',
        'Comprobante recibido',
        'Recibimos tu comprobante y estamos revisando el pago.',
        '/cuenta?tab=ordenes',
        new.id,
        'order:' || new.id || ':payment-proof-received'
      )
      on conflict (source_key) do update
      set
        type = excluded.type,
        title = excluded.title,
        body = excluded.body,
        action_url = excluded.action_url,
        is_read = false;
    end if;
  end if;

  if old.payment_status is distinct from new.payment_status
     and new.payment_status = 'confirmado' then
    update public.customer_notifications
    set
      type = 'payment_validated',
      title = 'Pago confirmado',
      body = 'Tu pago fue confirmado correctamente.',
      action_url = '/cuenta?tab=ordenes',
      is_read = false
    where order_id = new.id
      and type in ('payment_proof_pending', 'payment_proof_received');

    if not found then
      insert into public.customer_notifications (
        user_id, type, title, body, action_url, order_id, source_key
      ) values (
        new.usuario_id,
        'payment_validated',
        'Pago confirmado',
        'Tu pago fue confirmado correctamente.',
        '/cuenta?tab=ordenes',
        new.id,
        'order:' || new.id || ':payment-validated'
      )
      on conflict (source_key) do nothing;
    end if;
  end if;

  if old.estado is distinct from new.estado then
    if new.estado in ('enviado', 'en_camino') then
      insert into public.customer_notifications (
        user_id, type, title, body, action_url, order_id, source_key
      ) values (
        new.usuario_id,
        'order_shipped',
        'Pedido enviado',
        'Tu pedido ya está en camino.',
        '/cuenta?tab=ordenes',
        new.id,
        'order:' || new.id || ':shipped'
      )
      on conflict (source_key) do nothing;
    elsif new.estado = 'entregado' then
      insert into public.customer_notifications (
        user_id, type, title, body, action_url, order_id, source_key
      ) values (
        new.usuario_id,
        'order_delivered',
        'Pedido entregado',
        'Tu pedido figura como entregado.',
        '/cuenta?tab=ordenes',
        new.id,
        'order:' || new.id || ':delivered'
      )
      on conflict (source_key) do nothing;
    elsif new.estado = 'cancelado' then
      insert into public.customer_notifications (
        user_id, type, title, body, action_url, order_id, source_key
      ) values (
        new.usuario_id,
        'order_status',
        'Actualización de tu pedido',
        'El estado de tu pedido cambió. Revisá el detalle para más información.',
        '/cuenta?tab=ordenes',
        new.id,
        'order:' || new.id || ':cancelled'
      )
      on conflict (source_key) do nothing;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists notify_customer_order_changes_trigger
  on public.ordenes;
create trigger notify_customer_order_changes_trigger
after insert or update of payment_status, estado, payment_proof_url, payment_proof_uploaded_at
on public.ordenes
for each row
execute function public.notify_customer_order_changes();

update public.customer_notifications as notification
set
  type = 'payment_proof_received',
  title = 'Comprobante recibido',
  body = 'Recibimos tu comprobante y estamos revisando el pago.',
  action_url = '/cuenta?tab=ordenes'
from public.ordenes as order_record
where notification.order_id = order_record.id
  and notification.type = 'payment_proof_pending'
  and order_record.payment_method_id = 'transferencia'
  and coalesce(order_record.payment_status, '') <> 'confirmado'
  and (
    order_record.payment_proof_url is not null
    or order_record.payment_proof_uploaded_at is not null
  );

update public.customer_notifications as notification
set
  title = 'Comprobante pendiente',
  body = 'Subí el comprobante para que podamos confirmar tu pago.'
from public.ordenes as order_record
where notification.order_id = order_record.id
  and notification.type = 'payment_proof_pending'
  and order_record.payment_method_id = 'transferencia'
  and coalesce(order_record.payment_status, '') <> 'confirmado'
  and order_record.payment_proof_url is null
  and order_record.payment_proof_uploaded_at is null;
