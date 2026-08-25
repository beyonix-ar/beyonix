-- El wizard "Devoluciones y reintegros" (app/admin/sections/pedidos/admin-pedidos.tsx)
-- y su endpoint (app/api/admin/orders/[id]/credit-note/route.ts) permitían
-- emitir una nota de crédito de devolución de cliente (devolucion_parcial,
-- devolucion_total, cambio_producto, cancelacion_antes_despacho) sin que
-- existiera ningún reclamo (order_claims) del cliente para el pedido: el RPC
-- begin_partial_credit_note solo validaba el claim_id *si* llegaba uno, pero
-- nunca exigía que llegara. Esto permitía simular un reclamo inexistente.
--
-- Esta migración reemplaza begin_partial_credit_note agregando el parámetro
-- p_operation_type y exigiendo un claim_id válido para los tipos de
-- operación que representan una devolución iniciada por el cliente. Los
-- tipos administrativos/contables (ajuste_manual, reembolso_excepcional)
-- siguen sin requerir reclamo, preservando la vía de nota de crédito
-- administrativa que no depende de order_claims.
--
-- Como el parámetro es nuevo, se hace drop explícito de la firma anterior:
-- "create or replace function" con una lista de parámetros distinta crea un
-- overload adicional en vez de reemplazar, lo que dejaría la firma vieja
-- (sin el chequeo de reclamo) todavía invocable.
drop function if exists public.begin_partial_credit_note(
  bigint, bigint, text, text, numeric, numeric, numeric,
  integer, bigint, uuid, jsonb
);

create or replace function public.begin_partial_credit_note(
  p_order_id bigint,
  p_claim_id bigint,
  p_destination text,
  p_reason text,
  p_items_amount numeric,
  p_manual_amount numeric,
  p_total_amount numeric,
  p_invoice_point integer,
  p_invoice_number bigint,
  p_created_by uuid,
  p_items jsonb,
  p_operation_type text
)
returns public.order_credit_notes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_note public.order_credit_notes;
  v_invoice_total numeric(12, 2);
  v_committed_total numeric(12, 2);
  v_item jsonb;
  v_order_item public.orden_items;
  v_committed_quantity integer;
begin
  perform pg_advisory_xact_lock(91091, p_order_id::integer);

  update public.order_credit_notes
  set status = 'error',
      error = 'La emisión quedó interrumpida antes de contactar a ARCA.',
      updated_at = now()
  where status = 'processing'
    and created_at < now() - interval '5 minutes';

  if p_destination not in ('external_refund', 'customer_balance', 'none') then
    raise exception 'INVALID_CREDIT_NOTE_DESTINATION';
  end if;

  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'CREDIT_NOTE_REASON_REQUIRED';
  end if;

  if round(coalesce(p_total_amount, 0), 2) <= 0
     or round(coalesce(p_total_amount, 0), 2)
        <> round(coalesce(p_items_amount, 0) + coalesce(p_manual_amount, 0), 2) then
    raise exception 'INVALID_CREDIT_NOTE_AMOUNT';
  end if;

  -- Solo las gestiones administrativas/contables (ajuste manual, reembolso
  -- excepcional) pueden emitirse sin un reclamo real del cliente. Cualquier
  -- otro tipo de operación representa una devolución iniciada por el
  -- cliente y exige un order_claims válido para el pedido.
  if coalesce(p_operation_type, '') not in ('ajuste_manual', 'reembolso_excepcional')
     and p_claim_id is null then
    raise exception 'CLAIM_REQUIRED';
  end if;

  select round(total::numeric, 2)
  into v_invoice_total
  from public.ordenes
  where id = p_order_id
    and invoice_status = 'authorized'
    and invoice_cae is not null
    and invoice_point = p_invoice_point
    and invoice_number = p_invoice_number
  for update;

  if v_invoice_total is null then
    raise exception 'AUTHORIZED_INVOICE_REQUIRED';
  end if;

  select coalesce(sum(total_amount), 0)
  into v_committed_total
  from public.order_credit_notes
  where order_id = p_order_id
    and status in ('processing', 'authorized');

  if round(v_committed_total + p_total_amount, 2) > v_invoice_total then
    raise exception 'CREDIT_NOTE_EXCEEDS_INVOICE';
  end if;

  if p_claim_id is not null and not exists (
    select 1
    from public.order_claims
    where id = p_claim_id and order_id = p_order_id
  ) then
    raise exception 'INVALID_CREDIT_NOTE_CLAIM';
  end if;

  for v_item in select value from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  loop
    select *
    into v_order_item
    from public.orden_items
    where id = (v_item->>'order_item_id')::bigint
      and orden_id = p_order_id;

    if not found then
      raise exception 'INVALID_CREDIT_NOTE_ITEM';
    end if;

    select coalesce(sum(cni.quantity), 0)
    into v_committed_quantity
    from public.order_credit_note_items cni
    join public.order_credit_notes cn on cn.id = cni.credit_note_id
    where cni.order_item_id = v_order_item.id
      and cn.status in ('processing', 'authorized');

    if (v_item->>'quantity')::integer <= 0
       or v_committed_quantity + (v_item->>'quantity')::integer > v_order_item.cantidad then
      raise exception 'CREDIT_NOTE_ITEM_QUANTITY_EXCEEDED';
    end if;
  end loop;

  insert into public.order_credit_notes (
    order_id,
    claim_id,
    destination,
    reason,
    items_amount,
    manual_amount,
    total_amount,
    invoice_point,
    invoice_number,
    created_by
  )
  values (
    p_order_id,
    p_claim_id,
    p_destination,
    trim(p_reason),
    round(p_items_amount, 2),
    round(p_manual_amount, 2),
    round(p_total_amount, 2),
    p_invoice_point,
    p_invoice_number,
    p_created_by
  )
  returning * into v_note;

  insert into public.order_credit_note_items (
    credit_note_id,
    order_item_id,
    quantity,
    unit_amount,
    total_amount,
    product_name,
    variant_name
  )
  select
    v_note.id,
    (value->>'order_item_id')::bigint,
    (value->>'quantity')::integer,
    round((value->>'unit_amount')::numeric, 4),
    round((value->>'total_amount')::numeric, 2),
    left(value->>'product_name', 240),
    nullif(left(value->>'variant_name', 240), '')
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb));

  return v_note;
exception
  when unique_violation then
    raise exception 'CREDIT_NOTE_PROCESSING_IN_PROGRESS';
end;
$$;

revoke all on function public.begin_partial_credit_note(
  bigint, bigint, text, text, numeric, numeric, numeric,
  integer, bigint, uuid, jsonb, text
) from public, anon, authenticated;

grant execute on function public.begin_partial_credit_note(
  bigint, bigint, text, text, numeric, numeric, numeric,
  integer, bigint, uuid, jsonb, text
) to service_role;
