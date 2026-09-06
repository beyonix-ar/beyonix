-- Auditoría independiente: impedir pedidos fabricados y modificaciones del claim
-- desde PostgREST. Los callers de escritura usan APIs/server actions con service_role.
-- Se conserva SELECT y todas las policies RLS existentes.
revoke insert, update, delete, truncate, references, trigger on public.ordenes
  from anon, authenticated;

-- Persistir el estado comercial ya vigente; nunca reactivar una fila existente.
insert into public.site_settings (key, value, description)
values ('andreani_commercial', '{"enabled": true}'::jsonb,
  'Habilita cotizaciones y envíos nuevos; no afecta tracking, etiquetas ni cron históricos.')
on conflict (key) do nothing;

create or replace function public.claim_andreani_shipment_creation(
  p_order_id bigint,
  p_claim_token uuid,
  p_environment text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempts integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'No tenés permisos para generar este envío.';
  end if;

  if p_order_id is null or p_claim_token is null then
    raise exception 'ANDREANI_SHIPMENT_CLAIM_INVALID';
  end if;

  if p_environment is null or p_environment not in ('QA', 'PROD') then
    raise exception 'ANDREANI_SHIPMENT_CLAIM_INVALID_ENVIRONMENT';
  end if;

  -- La ausencia, un JSON inválido o enabled=false bloquean todo claim nuevo.
  perform 1 from public.site_settings
  where key = 'andreani_commercial' and value -> 'enabled' = 'true'::jsonb
  for share;
  if not found then
    return null;
  end if;

  -- Un claim vencido es ambiguo aunque haya sido tomado en otro ambiente:
  -- no puede abrirse otro POST hasta conciliar el resultado externo.
  update public.ordenes
  set
    andreani_creation_status = 'reconciliation_required',
    andreani_creation_claim_token = null,
    andreani_error = coalesce(
      andreani_error,
      'El intento venció sin resultado persistido; requiere conciliación manual.'
    )
  where id = p_order_id
    and nullif(btrim(coalesce(andreani_envio_id, '')), '') is null
    and andreani_creation_status = 'claimed'
    and andreani_creation_claimed_at < now() - interval '5 minutes';

  update public.ordenes
  set
    andreani_creation_status = 'claimed',
    andreani_creation_claim_token = p_claim_token,
    andreani_creation_claimed_at = now(),
    andreani_creation_environment = p_environment,
    andreani_creation_attempts = coalesce(andreani_creation_attempts, 0) + 1
  where id = p_order_id
    and nullif(btrim(coalesce(andreani_envio_id, '')), '') is null
    and (
      andreani_creation_status is null
      or andreani_creation_status = 'failed'
      -- Rechazo determinístico (400/422): Andreani no creó nada, así que
      -- es reclamable en cualquier ambiente, incluido el mismo que lo
      -- rechazó, sin esperar a que cambie QA<->PROD.
      or andreani_creation_status = 'rejected'
    )
    and lower(coalesce(estado, '')) in ('pendiente', 'pagado')
    and lower(coalesce(shipping_provider, envio_proveedor, '')) = 'andreani'
    and lower(coalesce(financial_status, '')) not in (
      'cancellation_requested',
      'cancelled',
      'refund_pending',
      'refunded'
    )
    and shipping_type in ('domicilio', 'sucursal')
    and (
      paid_at is not null
      or coalesce(payment_confirmed_amount, 0) > 0
      or lower(coalesce(payment_status, '')) in (
        'confirmado',
        'approved',
        'confirmed'
      )
      or lower(coalesce(financial_status, '')) = 'payment_confirmed'
    )
    and invoice_status = 'authorized'
    and nullif(btrim(coalesce(invoice_cae, '')), '') is not null
    and invoice_number is not null
    and invoice_point is not null
  returning andreani_creation_attempts into v_attempts;

  return v_attempts;
end;
$$;

comment on function public.claim_andreani_shipment_creation(bigint, uuid, text) is
  'Reclama atómicamente una creación Andreani para un pedido pagado, facturado y sin resultado externo ambiguo pendiente, en modalidad domicilio o sucursal; un rechazo determinístico previo (400/422) no bloquea el reclamo.';

notify pgrst, 'reload schema';

revoke all on function public.claim_andreani_shipment_creation(bigint, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_andreani_shipment_creation(bigint, uuid, text) to service_role;
