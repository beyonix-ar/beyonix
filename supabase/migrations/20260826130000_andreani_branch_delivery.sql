-- Entrega en sucursal Andreani (destino elegido por el cliente en checkout).
--
-- Hasta ahora `shipping_type = 'sucursal'` se persistía sin ningún dato de
-- QUÉ sucursal Andreani eligió el cliente: el checkout sólo cotizaba y
-- guardaba la modalidad, nunca la sucursal destino real. Como consecuencia,
-- `buildAndreaniShipmentEnvio` bloqueaba (correctamente) la generación del
-- envío para todo pedido sucursal, sin excepción -- ver
-- SUCURSAL_BLOCKED_MESSAGE en lib/andreani/order-shipment.ts.
--
-- Esta migración agrega el mínimo de columnas necesario para reconstruir el
-- destino real: `andreani_sucursal_id` es el idgla numérico (como texto) que
-- POST /v2/ordenes-de-envio espera en destino.sucursal.id -- el mismo campo
-- "id" que devuelve GET /v2/sucursales, NUNCA el "codigo" (ver el caso ya
-- confirmado en PROD: codigo "RAC" != idgla 10179, documentado en
-- lib/andreani/order-shipment.ts). `andreani_sucursal_codigo` se conserva
-- aparte sólo como referencia/soporte, nunca como identificador de envío.
-- El resto son campos de presentación (nombre/dirección/localidad/
-- provincia/CP) para que Admin y Mis compras puedan mostrar dónde retira el
-- cliente sin volver a consultar Andreani en cada render.
--
-- Todas nullable a propósito: los pedidos domicilio nunca las usan, y los
-- pedidos sucursal históricos que quedaron sin sucursal persistida deben
-- seguir existiendo tal cual -- se muestran como "falta seleccionar/
-- persistir sucursal Andreani" en vez de inventar un destino. Ningún dato
-- existente se modifica.

alter table public.ordenes
  add column if not exists andreani_sucursal_id text,
  add column if not exists andreani_sucursal_codigo text,
  add column if not exists andreani_sucursal_nombre text,
  add column if not exists andreani_sucursal_direccion text,
  add column if not exists andreani_sucursal_localidad text,
  add column if not exists andreani_sucursal_provincia text,
  add column if not exists andreani_sucursal_cp text;

comment on column public.ordenes.andreani_sucursal_id is
  'idgla numérico (como texto) de la sucursal Andreani elegida por el cliente para entrega. Es lo que POST /v2/ordenes-de-envio espera en destino.sucursal.id -- nunca el código (ej. "RAC").';
comment on column public.ordenes.andreani_sucursal_codigo is
  'Código/nomenclatura de la sucursal (ej. "RAC"), sólo de referencia/soporte -- no es el identificador que usa la creación del envío.';
comment on column public.ordenes.andreani_sucursal_nombre is
  'Nombre (descripcion) de la sucursal Andreani elegida, para mostrar al cliente/admin.';
comment on column public.ordenes.andreani_sucursal_direccion is
  'Calle y número de la sucursal Andreani elegida, tal como los devolvió Andreani al momento de la selección.';
comment on column public.ordenes.andreani_sucursal_localidad is
  'Localidad de la sucursal Andreani elegida.';
comment on column public.ordenes.andreani_sucursal_provincia is
  'Provincia de la sucursal Andreani elegida.';
comment on column public.ordenes.andreani_sucursal_cp is
  'Código postal de la sucursal Andreani elegida.';

-- El reclamo atómico de creación de envío sólo permitía shipping_type =
-- 'domicilio': con la persistencia de sucursal ya resuelta, entrega en
-- sucursal debe poder reclamar creación igual que domicilio. La validación
-- de que la sucursal esté realmente persistida sigue ocurriendo en código de
-- aplicación (buildAndreaniShipmentEnvio), ANTES de llamar a este RPC -- así
-- que un pedido sucursal sin sucursal persistida nunca llega a consumir un
-- intento/reclamo acá, igual que hoy un domicilio sin dirección completa
-- nunca llega a este RPC. Se conserva el resto de la función sin cambios.
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
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para generar este envío.';
  end if;

  if p_order_id is null or p_claim_token is null then
    raise exception 'ANDREANI_SHIPMENT_CLAIM_INVALID';
  end if;

  if p_environment not in ('QA', 'PROD') then
    raise exception 'ANDREANI_SHIPMENT_CLAIM_INVALID_ENVIRONMENT';
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
    and lower(coalesce(estado, '')) <> 'cancelado'
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
