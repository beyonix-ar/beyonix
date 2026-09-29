-- Vender la última unidad no puede revertir la confirmación de un pago.
--
-- Causa (pedido real por transferencia, 2026-09-29): la transferencia se
-- encontró y coincidió, pero confirm_transfer_auto_verification fallaba en el
-- COMMIT. Al confirmar, refresh_inventory_from_order recalcula el stock y la
-- variante vendida queda en 0; los constraint triggers DIFERIDOS
-- validate_variant_commercial_state / validate_product_commercial_state
-- re-evaluaban los requisitos de ACTIVACIÓN (20260808210000 /
-- 20260820170000), incluido "stock > 0", sobre cualquier cambio de una
-- variante o producto ya activos. Resultado: "La variante necesita stock
-- asignado." en el COMMIT, rollback completo y el pedido quedaba en
-- confirmation_error para siempre (la venta de la última unidad era imposible
-- por cualquier vía: transferencia, Mercado Pago o aprobación manual).
--
-- Regla corregida: el stock > 0 es un requisito para ACTIVAR (alta ya activa
-- o transición inactiva -> activa), no un invariante permanente. Un producto o
-- variante ya activos que se agotan por una venta quedan activos y "Sin stock"
-- (la tienda y el admin ya manejan ese estado; reservas y checkout siguen
-- rechazando comprar sin stock). El resto de los requisitos (nombre, SKU,
-- color, imágenes, precio, categoría, descripción, especificaciones,
-- dimensiones) sigue siendo un invariante. Las acciones explícitas de
-- activación (set_product_commercial_state_atomic, etc.) siguen llamando a
-- product_activation_error / product_variant_activation_error, que conservan
-- su firma y su comportamiento (exigen stock).
--
-- Además, confirm_transfer_auto_verification evalúa esos dos constraint
-- triggers dentro de la RPC (SET CONSTRAINTS <nombres> IMMEDIATE, sólo esos
-- dos y sólo al final del camino de confirmación): un estado de catálogo
-- inválido deja de ser un error opaco en el COMMIT y pasa a ser
-- CATALOG_STATE_INVALID, tipificado. Misma transacción: no hay commits
-- parciales; si falla, se revierte todo igual que antes.
--
-- Sin cambios de datos. Idempotente (create or replace).

begin;

create or replace function public.product_variant_listing_error(
  p_product_id bigint,
  p_variant_id bigint,
  p_primary boolean,
  p_require_stock boolean
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_variant public.producto_variantes%rowtype;
  v_subject text := case
    when p_primary then 'La variante principal'
    else 'La variante'
  end;
begin
  select * into v_variant
  from public.producto_variantes variants
  where variants.id = p_variant_id
    and variants.producto_id = p_product_id;

  if not found then
    return case
      when p_primary then 'Creá al menos una variante.'
      else 'La variante ya no existe.'
    end;
  end if;
  if nullif(btrim(coalesce(v_variant.nombre, '')), '') is null then
    return v_subject || ' necesita un nombre.';
  end if;
  if nullif(btrim(coalesce(v_variant.sku, '')), '') is null then
    return v_subject || ' necesita un SKU.';
  end if;
  if v_variant.color_hex is null
     or v_variant.color_hex !~ '^#[0-9A-Fa-f]{6}$' then
    return v_subject || ' necesita un color.';
  end if;
  if jsonb_typeof(coalesce(v_variant.imagenes, '[]'::jsonb)) <> 'array' then
    return v_subject || ' necesita al menos una imagen.';
  end if;
  if not exists (
    select 1
    from jsonb_array_elements_text(v_variant.imagenes) images(url)
    where nullif(btrim(images.url), '') is not null
  ) then
    return v_subject || ' necesita al menos una imagen.';
  end if;

  if p_require_stock and coalesce(v_variant.stock, 0) <= 0 then
    return v_subject || ' necesita stock asignado.';
  end if;

  return null;
end;
$$;

-- Misma firma y mismo comportamiento: requisitos de ACTIVACIÓN (con stock).
create or replace function public.product_variant_activation_error(
  p_product_id bigint,
  p_variant_id bigint,
  p_primary boolean default false
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return public.product_variant_listing_error(p_product_id, p_variant_id, p_primary, true);
end;
$$;

create or replace function public.product_listing_error(
  p_product_id bigint,
  p_require_stock boolean
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_product public.productos%rowtype;
  v_primary_variant_id bigint;
  v_catalog_sku text;
begin
  select * into v_product
  from public.productos products
  where products.id = p_product_id;

  if not found then
    return 'El producto ya no existe.';
  end if;
  if nullif(btrim(coalesce(v_product.nombre, '')), '') is null then
    return 'Falta completar el título.';
  end if;

  select variants.id, variants.sku
  into v_primary_variant_id, v_catalog_sku
  from public.producto_variantes variants
  where variants.producto_id = p_product_id
  order by variants.orden, variants.id
  limit 1;

  v_catalog_sku := coalesce(v_catalog_sku, v_product.sku);
  if nullif(btrim(coalesce(v_catalog_sku, '')), '') is null then
    return 'El producto necesita un SKU.';
  end if;
  if coalesce(v_product.precio, 0) <= 0 then
    return 'El precio debe ser mayor a $0.';
  end if;
  if v_product.categoria_id is null
     or not exists (
       select 1 from public.categorias categories
       where categories.id = v_product.categoria_id
     ) then
    return 'Seleccioná una categoría.';
  end if;
  if nullif(btrim(coalesce(v_product.descripcion, '')), '') is null then
    return 'Completá la descripción.';
  end if;
  if not exists (
    select 1
    from public.producto_especificaciones specifications
    where specifications.producto_id = p_product_id
      and specifications.activo
      and nullif(btrim(coalesce(specifications.icono, '')), '') is not null
      and nullif(btrim(coalesce(specifications.texto, '')), '') is not null
  ) then
    return 'Agregá al menos una especificación activa.';
  end if;
  if coalesce(v_product.peso_empaquetado_kg, 0) <= 0
     or coalesce(v_product.alto_paquete_cm, 0) <= 0
     or coalesce(v_product.ancho_paquete_cm, 0) <= 0
     or coalesce(v_product.largo_paquete_cm, 0) <= 0 then
    return 'Completá peso, profundidad, ancho y largo.';
  end if;
  if v_primary_variant_id is null then
    return 'Creá al menos una variante.';
  end if;

  return public.product_variant_listing_error(
    p_product_id,
    v_primary_variant_id,
    true,
    p_require_stock
  );
end;
$$;

-- Misma firma y mismo comportamiento: requisitos de ACTIVACIÓN (con stock).
create or replace function public.product_activation_error(p_product_id bigint)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return public.product_listing_error(p_product_id, true);
end;
$$;

-- Deferred: el stock sólo se exige si ESTE evento activó el producto.
create or replace function public.validate_product_commercial_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product_active boolean;
  v_activating boolean := coalesce(new.activo, false)
    and (tg_op = 'INSERT' or not coalesce(old.activo, false));
  v_error text;
begin
  select products.activo into v_product_active
  from public.productos products
  where products.id = new.id;

  if coalesce(v_product_active, false) then
    v_error := public.product_listing_error(new.id, v_activating);
    if v_error is not null then
      raise exception '%', v_error;
    end if;
    if not exists (
      select 1
      from public.producto_variantes variants
      where variants.producto_id = new.id
        and variants.activo
    ) then
      raise exception 'El producto necesita al menos una variante activa.';
    end if;
  end if;
  return null;
end;
$$;

-- Deferred: el stock sólo se exige si ESTE evento activó la variante. El
-- chequeo del producto (ya activo) nunca exige stock: su activación la valida
-- validate_product_commercial_state.
create or replace function public.validate_variant_commercial_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product_id bigint := case
    when tg_op = 'DELETE' then old.producto_id
    else new.producto_id
  end;
  v_variant_id bigint := case
    when tg_op = 'DELETE' then old.id
    else new.id
  end;
  v_variant_active boolean;
  v_activating boolean := tg_op <> 'DELETE'
    and coalesce(new.activo, false)
    and (tg_op = 'INSERT' or not coalesce(old.activo, false));
  v_error text;
begin
  if tg_op <> 'DELETE' then
    select variants.producto_id, variants.activo
    into v_product_id, v_variant_active
    from public.producto_variantes variants
    where variants.id = v_variant_id;
  else
    v_variant_active := false;
  end if;

  if coalesce(v_variant_active, false) then
    if not exists (
      select 1 from public.productos products
      where products.id = v_product_id and products.activo
    ) then
      raise exception 'No podés activar esta variante porque el producto está inactivo.';
    end if;
    v_error := public.product_variant_listing_error(
      v_product_id,
      v_variant_id,
      false,
      v_activating
    );
    if v_error is not null then
      raise exception '%', v_error;
    end if;
  end if;

  if exists (
    select 1 from public.productos products
    where products.id = v_product_id and products.activo
  ) then
    v_error := public.product_listing_error(v_product_id, false);
    if v_error is not null then
      raise exception '%', v_error;
    end if;
    if not exists (
      select 1 from public.producto_variantes variants
      where variants.producto_id = v_product_id and variants.activo
    ) then
      raise exception 'No podés desactivar la única variante activa. Desactivá primero el producto.';
    end if;
  end if;

  return null;
end;
$$;

create or replace function public.confirm_transfer_auto_verification(
  p_order_id bigint,
  p_matched_payment_id text,
  p_matched_operation_type text,
  p_matched_payment_method_id text,
  p_matched_amount numeric,
  p_matched_identification_type text,
  p_matched_identification_number text,
  p_matched_dni_derived text,
  p_matched_bank_transfer_id text,
  p_matched_date_created timestamptz,
  p_matched_date_approved timestamptz,
  p_lease_id uuid
)
returns public.ordenes
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'pg_temp'
as $$
declare
  v_order public.ordenes%rowtype;
  v_now timestamptz := now();
  -- P0 (quinta auditoría): now() devuelve el timestamp de INICIO de la
  -- transacción -- queda congelado durante toda la ejecución, incluida
  -- cualquier espera real para adquirir el "for update" de abajo. Codex
  -- reprodujo: lease con 59s de antigüedad al arrancar la transacción, la
  -- transacción tarda/espera 2s más antes de evaluar la vigencia, la
  -- antigüedad REAL ya es 61s (vencida), pero now() seguía viendo 59s y la
  -- RPC confirmaba igual. v_lease_checked_at se asigna DESPUÉS del "for
  -- update" (más abajo) con clock_timestamp() -- tiempo de PARED real en el
  -- momento exacto de evaluar, nunca el de inicio de transacción -- y se usa
  -- ÚNICAMENTE para la comprobación de vigencia del lease. v_now se sigue
  -- usando para todo lo demás (timestamps de escritura: payment_confirmed_at,
  -- paid_at, transfer_last_verification_at, etc.) donde congelar el momento
  -- de inicio de transacción es el criterio correcto y no está relacionado
  -- con este bug.
  v_lease_checked_at timestamptz;
  v_previous_financial_status text;
  v_snapshot jsonb;
  v_expected_amount numeric;
  v_expected_cents bigint;
  v_matched_cents bigint;
  v_declared_cents bigint;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para esta operación.';
  end if;

  if coalesce(trim(p_matched_payment_id), '') = '' then
    raise exception 'INVALID_PAYMENT_ID: falta el identificador de Mercado Pago.';
  end if;

  select *
  into v_order
  from public.ordenes
  where id = p_order_id
  for update;

  -- Tiempo real de PARED, tomado recién acá -- inmediatamente DESPUÉS de
  -- que el "for update" de arriba ya terminó de esperar (si tuvo que
  -- esperar). Nunca reutilizar v_now (congelado al inicio de la
  -- transacción) para la comprobación de vigencia del lease de más abajo.
  v_lease_checked_at := clock_timestamp();

  if not found then
    raise exception 'ORDER_NOT_FOUND: no encontramos el pedido.';
  end if;

  if v_order.payment_method_id is distinct from 'transferencia' then
    raise exception 'NOT_TRANSFER_ORDER: este pedido no corresponde a transferencia bancaria.';
  end if;

  if lower(coalesce(v_order.estado, '')) = 'cancelado' then
    raise exception 'ORDER_CANCELLED: el pedido está cancelado.';
  end if;

  if coalesce(v_order.payment_status, '') not in ('pendiente_comprobante', 'en_revision') then
    raise exception 'ALREADY_RESOLVED: el pago de este pedido ya no admite verificación automática.';
  end if;

  -- P0 (tercera auditoría): validación de lease COMPLETA, bajo el mismo
  -- FOR UPDATE de arriba -- las cinco condiciones exigidas, en el orden que
  -- da el diagnóstico más específico posible:
  --
  --  1) transfer_verification_status debe seguir siendo 'checking' (hubo un
  --     claim y nadie lo resolvió/liberó todavía) -> si no,
  --     INVALID_VERIFICATION_STATE. Cubre tanto "nunca se hizo claim"
  --     (status por defecto, nunca 'checking') como "ya se resolvió en
  --     manual_review/pending mientras tanto".
  --  2) p_lease_id y el lease vigente en la fila deben ser AMBOS no nulos
  --     -> si cualquiera es NULL, LEASE_MISSING. Esto es lo que la versión
  --     anterior de este chequeo (IS DISTINCT FROM) dejaba pasar: NULL IS
  --     NOT DISTINCT FROM NULL en Postgres.
  --  3) deben coincidir EXACTAMENTE -> si no, LEASE_MISMATCH (un intento
  --     más nuevo ya reclamó este pedido).
  --  4) transfer_last_verification_at (fijado por el claim que otorgó este
  --     lease) debe seguir dentro de una ventana de vigencia FIJA de 60
  --     segundos -- hardcodeada acá, nunca un parámetro que el caller pueda
  --     manipular (ver comentario más arriba, antes de los DROP) -> si no,
  --     LEASE_EXPIRED. Comparado contra v_lease_checked_at (clock_timestamp(),
  --     tiempo real tomado DESPUÉS del "for update" de arriba), nunca contra
  --     v_now (congelado al inicio de la transacción -- ver comentario en la
  --     declaración de v_lease_checked_at más arriba).
  --
  -- Si cualquiera de las cuatro falla: NO se toca ningún campo de la orden.
  if coalesce(v_order.transfer_verification_status, '') <> 'checking' then
    raise exception 'INVALID_VERIFICATION_STATE: el pedido no tiene una verificación automática en curso.';
  end if;

  if p_lease_id is null or v_order.transfer_verification_lease_id is null then
    raise exception 'LEASE_MISSING: falta el identificador del intento de verificación vigente.';
  end if;

  if p_lease_id <> v_order.transfer_verification_lease_id then
    raise exception 'LEASE_MISMATCH: el intento de verificación ya no es el vigente (fue reemplazado por uno nuevo).';
  end if;

  if v_order.transfer_last_verification_at is null
     or v_order.transfer_last_verification_at <= v_lease_checked_at - interval '60 seconds' then
    raise exception 'LEASE_EXPIRED: el intento de verificación vigente venció.';
  end if;

  if exists (
    select 1 from public.ordenes
    where transfer_matched_payment_id = p_matched_payment_id
      and id <> p_order_id
  ) then
    raise exception 'TRANSFER_PAYMENT_ID_ALREADY_USED: esa transferencia ya fue utilizada para acreditar otro pedido.';
  end if;

  -- P0 (segunda auditoría): claim histórico e insert-only, independiente del
  -- valor actual de ordenes.transfer_matched_payment_id (que esta misma
  -- orden podría sobrescribir más adelante con otro payment.id). Una vez
  -- reclamado acá, este payment.id queda atado a esta orden para siempre.
  insert into public.transfer_verification_payment_claims (payment_id, order_id)
  values (p_matched_payment_id, p_order_id)
  on conflict (payment_id) do nothing;

  if not exists (
    select 1 from public.transfer_verification_payment_claims
    where payment_id = p_matched_payment_id
      and order_id = p_order_id
  ) then
    raise exception 'TRANSFER_PAYMENT_ID_ALREADY_USED: esa transferencia ya fue utilizada para acreditar otro pedido.';
  end if;

  -- P0: monto esperado BAJO EL LOCK ya tomado arriba -- nunca el monto que
  -- el caller haya leído antes de invocar esta RPC (puede quedar
  -- desactualizado durante el tiempo que tarda la consulta a Mercado Pago).
  -- Mismo criterio de columnas que usa el resto del proyecto:
  -- external_amount_due si existe, si no total.
  v_expected_amount := coalesce(v_order.external_amount_due, v_order.total);
  v_expected_cents := round(coalesce(v_expected_amount, -1) * 100);
  v_matched_cents := round(coalesce(p_matched_amount, -1) * 100);

  if v_expected_cents is null or v_expected_cents <= 0
     or v_matched_cents is null or v_matched_cents <> v_expected_cents then
    raise exception 'AMOUNT_MISMATCH: el monto vigente del pedido no coincide con el importe de la transferencia.';
  end if;

  if v_order.transfer_amount_declared is not null then
    v_declared_cents := round(v_order.transfer_amount_declared * 100);
    if v_declared_cents <> v_matched_cents then
      raise exception 'AMOUNT_MISMATCH: el monto declarado no coincide con el importe vigente del pedido.';
    end if;
  end if;

  v_previous_financial_status := coalesce(
    v_order.financial_status,
    v_order.payment_status,
    'pending_payment'
  );
  v_snapshot := jsonb_build_object(
    'operationType', p_matched_operation_type,
    'paymentMethodId', p_matched_payment_method_id,
    'identificationType', p_matched_identification_type,
    'identificationNumber', p_matched_identification_number,
    'dniDerivado', p_matched_dni_derived,
    'bankTransferId', p_matched_bank_transfer_id,
    'dateCreated', p_matched_date_created,
    'dateApproved', p_matched_date_approved
  );

  begin
    update public.ordenes
    set
      payment_status = 'confirmado',
      estado = 'pagado',
      financial_status = 'payment_confirmed',
      paid_at = coalesce(v_order.paid_at, v_now),
      payment_confirmed_by = null,
      payment_confirmed_at = v_now,
      payment_confirmed_amount = p_matched_amount,
      order_change_status = 'change_approved',
      order_change_extra_amount = 0,
      transfer_verification_status = 'auto_verified',
      transfer_verification_failure_reason = null,
      transfer_last_verification_at = v_now,
      transfer_matched_payment_id = p_matched_payment_id,
      transfer_match_snapshot = v_snapshot
    where id = v_order.id
    returning *
    into v_order;
  exception
    when unique_violation then
      raise exception 'TRANSFER_PAYMENT_ID_ALREADY_USED: esa transferencia ya fue utilizada para acreditar otro pedido.';
    when others then
      if sqlerrm !~* 'CHECKOUT_STOCK_INSUFFICIENT' then
        raise;
      end if;

      -- El dinero YA fue identificado contra Mercado Pago (y ya quedó en el
      -- historial de claims de arriba): aunque el stock ya no alcance para
      -- confirmar la orden, el payment.id tiene que quedar reservado para
      -- ESTE pedido de forma atómica (mismo lock de fila tomado arriba por
      -- el "for update"). A propósito no toca estado/financial_status: eso
      -- evita que este UPDATE angosto dispare de nuevo el guardián de
      -- inventario.
      begin
        update public.ordenes
        set
          payment_status = 'auto_verified_stock_conflict',
          transfer_verification_status = 'manual_review',
          transfer_verification_failure_reason = 'stock_conflict',
          transfer_last_verification_at = v_now,
          transfer_matched_payment_id = p_matched_payment_id,
          transfer_match_snapshot = v_snapshot
        where id = v_order.id
        returning *
        into v_order;
      exception
        when unique_violation then
          raise exception 'TRANSFER_PAYMENT_ID_ALREADY_USED: esa transferencia ya fue utilizada para acreditar otro pedido.';
      end;

      insert into public.order_audit_events (
        order_id, actor_type, actor_id, action, previous_status, new_status, metadata
      )
      values (
        v_order.id, 'system', null, 'transfer_auto_verification_stock_conflict',
        v_previous_financial_status, v_previous_financial_status,
        jsonb_build_object(
          'provider', 'mercadopago',
          'matchedPaymentId', p_matched_payment_id,
          'matchedAmount', p_matched_amount,
          'reason', 'inventory_unavailable_at_confirmation'
        )
      );

      return v_order;
  end;

  -- Los requisitos comerciales de productos/variantes son constraint triggers
  -- DIFERIDOS: sin esto, una violación aparecía recién en el COMMIT (fuera de
  -- esta función), el caller no podía distinguirla y el pedido quedaba en
  -- confirmation_error. Se evalúan acá, sólo esos dos y dentro de la misma
  -- transacción (ningún commit parcial): si fallan, se revierte todo.
  begin
    set constraints public.validate_product_commercial_state,
      public.validate_variant_commercial_state immediate;
  exception
    when others then
      raise exception 'CATALOG_STATE_INVALID: %', sqlerrm;
  end;
  set constraints public.validate_product_commercial_state,
    public.validate_variant_commercial_state deferred;

  insert into public.order_audit_events (
    order_id,
    actor_type,
    actor_id,
    action,
    previous_status,
    new_status,
    metadata
  )
  values (
    v_order.id,
    'system',
    null,
    'transfer_auto_verified',
    v_previous_financial_status,
    'payment_confirmed',
    jsonb_build_object(
      'provider', 'mercadopago',
      'matchedPaymentId', p_matched_payment_id,
      'matchedAmount', p_matched_amount,
      'operationType', p_matched_operation_type,
      'paymentMethodId', p_matched_payment_method_id
    )
  );

  return v_order;
end;
$$;

revoke all on function public.product_variant_listing_error(bigint, bigint, boolean, boolean)
  from public, anon, authenticated;
revoke all on function public.product_listing_error(bigint, boolean)
  from public, anon, authenticated;
revoke all on function public.confirm_transfer_auto_verification(bigint, text, text, text, numeric, text, text, text, text, timestamptz, timestamptz, uuid)
  from public, anon, authenticated;
grant execute on function public.confirm_transfer_auto_verification(bigint, text, text, text, numeric, text, text, text, text, timestamptz, timestamptz, uuid)
  to service_role;

comment on function public.product_variant_listing_error(bigint, bigint, boolean, boolean) is
  'Requisitos comerciales de una variante. p_require_stock=true sólo al activarla: una variante activa que se agota por una venta sigue siendo válida (Sin stock).';
comment on function public.product_listing_error(bigint, boolean) is
  'Requisitos comerciales de un producto. p_require_stock=true sólo al activarlo: un producto activo que se agota por una venta sigue siendo válido (Sin stock).';

commit;
