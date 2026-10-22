-- Cierre de la integración Andreani -> BEYONIX.
--
-- 1. Historial de tracking (andreani_tracking_events): un registro por evento
--    informado por Andreani para un pedido o un tramo de reclamo, con el
--    código y el texto crudos, la fecha del evento, cuándo lo detectó BEYONIX
--    y -- sólo en el evento que lo provocó -- el estado anterior y el nuevo.
--    Idempotente por dedupe_key: el cron consulta cada 15 minutos y nunca
--    duplica filas. Lo escribe únicamente el servidor (service_role).
-- 2. Eventos fuera del maestro: quedan en el historial con recognized=false y
--    review_required=true, y el pedido guarda el primero en
--    andreani_tracking_review_event/_at para revisión. Nunca cambian el estado.
-- 3. Notificaciones del cliente por hito logístico (mismo trigger de siempre,
--    una por hito gracias a source_key): despachado/recibido por Andreani,
--    en camino, en sucursal y entregado. Antes "enviado" y "en_camino"
--    compartían la misma clave y la llegada a sucursal no avisaba nada.

begin;

create table if not exists public.andreani_tracking_events (
  id bigint generated always as identity primary key,
  order_id bigint not null references public.ordenes(id) on delete cascade,
  claim_shipment_id bigint references public.order_claim_shipments(id) on delete cascade,
  source text not null default 'andreani',
  tracking text not null,
  event_code text not null,
  event_text text,
  event_cycle text,
  event_at timestamptz,
  detected_at timestamptz not null default now(),
  recognized boolean not null,
  review_required boolean not null default false,
  previous_status text,
  new_status text,
  details jsonb not null default '{}'::jsonb,
  dedupe_key text not null,
  constraint andreani_tracking_events_dedupe_key_key unique (dedupe_key),
  constraint andreani_tracking_events_source_check check (source = 'andreani'),
  constraint andreani_tracking_events_tracking_check check (length(btrim(tracking)) between 1 and 100),
  constraint andreani_tracking_events_code_check check (length(btrim(event_code)) between 1 and 200),
  constraint andreani_tracking_events_text_check check (event_text is null or length(event_text) <= 500),
  constraint andreani_tracking_events_cycle_check check (event_cycle is null or length(event_cycle) <= 100),
  constraint andreani_tracking_events_transition_check check ((previous_status is null) = (new_status is null)),
  constraint andreani_tracking_events_review_check check (recognized or review_required),
  constraint andreani_tracking_events_details_check check (jsonb_typeof(details) = 'object')
);

create index if not exists andreani_tracking_events_order_idx
  on public.andreani_tracking_events (order_id, event_at desc nulls last);
create index if not exists andreani_tracking_events_claim_shipment_idx
  on public.andreani_tracking_events (claim_shipment_id, event_at desc nulls last)
  where claim_shipment_id is not null;
create index if not exists andreani_tracking_events_review_idx
  on public.andreani_tracking_events (detected_at desc)
  where review_required;

alter table public.andreani_tracking_events enable row level security;
revoke all on public.andreani_tracking_events from public, anon, authenticated;
grant all on public.andreani_tracking_events to service_role;

comment on table public.andreani_tracking_events is
  'Historial idempotente de eventos de tracking Andreani (pedidos y tramos de reclamos). Sólo lo escribe el servidor. recognized=false: evento fuera del maestro, pendiente de revisión, nunca cambió un estado.';

alter table public.ordenes
  add column if not exists andreani_tracking_review_event text,
  add column if not exists andreani_tracking_review_at timestamptz;

comment on column public.ordenes.andreani_tracking_review_event is
  'Primer evento de tracking Andreani que BEYONIX no reconoce (código · texto crudos). Pide revisión; nunca cambió ordenes.estado.';

-- Igual a la versión del baseline salvo el bloque de cambio de estado.
create or replace function public.notify_customer_order_changes()
returns trigger
language plpgsql
security definer
set search_path to 'public'
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

  -- Un aviso por hito logístico (source_key distinto por hito): el mismo
  -- hito informado varias veces por Andreani, el cron o un Admin nunca
  -- duplica la notificación, y saltear un hito (pagado -> en_camino) sólo
  -- avisa el alcanzado.
  if old.estado is distinct from new.estado then
    if new.estado = 'enviado' then
      insert into public.customer_notifications (
        user_id, type, title, body, action_url, order_id, source_key
      ) values (
        new.usuario_id,
        'order_shipped',
        case when new.andreani_envio_id is not null then 'Andreani recibió tu paquete' else 'Pedido despachado' end,
        case when new.andreani_envio_id is not null
          then 'Tu pedido ' || 'BX-' || (1000 + new.id) || ' ya está en manos de Andreani.'
          else 'Tu pedido ' || 'BX-' || (1000 + new.id) || ' fue despachado.' end,
        '/cuenta/compras/' || new.id,
        new.id,
        'order:' || new.id || ':shipped'
      )
      on conflict (source_key) do nothing;
    elsif new.estado = 'en_camino' then
      insert into public.customer_notifications (
        user_id, type, title, body, action_url, order_id, source_key
      ) values (
        new.usuario_id,
        'order_shipped',
        'Tu pedido está en camino',
        'Tu pedido ' || 'BX-' || (1000 + new.id) || ' está en camino.',
        '/cuenta/compras/' || new.id,
        new.id,
        'order:' || new.id || ':in-transit'
      )
      on conflict (source_key) do nothing;
    elsif new.estado in ('en_sucursal', 'retiro_pendiente') then
      insert into public.customer_notifications (
        user_id, type, title, body, action_url, order_id, source_key
      ) values (
        new.usuario_id,
        'order_shipped',
        'Tu pedido llegó a la sucursal',
        'Tu pedido ' || 'BX-' || (1000 + new.id) || ' ya está disponible para retirar en la sucursal.',
        '/cuenta/compras/' || new.id,
        new.id,
        'order:' || new.id || ':at-branch'
      )
      on conflict (source_key) do nothing;
    elsif new.estado = 'entregado' then
      insert into public.customer_notifications (
        user_id, type, title, body, action_url, order_id, source_key
      ) values (
        new.usuario_id,
        'order_delivered',
        'Tu pedido fue entregado',
        'Tu pedido ' || 'BX-' || (1000 + new.id) || ' figura como entregado.',
        '/cuenta/compras/' || new.id,
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

notify pgrst, 'reload schema';
commit;
