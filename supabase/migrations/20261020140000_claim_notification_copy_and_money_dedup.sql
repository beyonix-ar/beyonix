-- Ajustes finales a los avisos de reclamos en la campana, sin redefinir las
-- funciones que los insertan (commit_customer_order_claim, circuito financiero):
--   * reclamo formal recién creado: "Recibimos tu reclamo" en vez del texto de
--     ayuda ("Recibimos tu solicitud de ayuda"), que queda para las consultas;
--   * reintegro / saldo: si el cierre del reclamo ya avisó el resultado
--     ("Tu reintegro fue realizado" / "Tu saldo a favor ya está disponible"), el
--     aviso financiero que llega después no se suma. El orden inverso (primero
--     el aviso financiero, después el cierre) ya lo resuelve
--     notify_customer_claim_message (20261020130000).

begin;

create or replace function public.normalize_customer_claim_notification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim public.order_claims%rowtype;
begin
  if new.type = 'claim_started' and coalesce(new.source_key, '') ~ '^claim:[0-9]+:created$' then
    select * into v_claim from public.order_claims where id = split_part(new.source_key, ':', 2)::bigint;
    if found and coalesce(v_claim.failure_type, '') not in ('consulta_pedido', 'cancelar_compra') then
      new.title := 'Recibimos tu reclamo';
      new.body := 'Vamos a revisar tu reclamo del pedido BX-' || (1000 + v_claim.order_id) || ' y te avisamos por acá.';
    end if;
    return new;
  end if;

  if new.order_id is null or new.user_id is null or new.type not in ('order_refunded', 'customer_credit') then
    return new;
  end if;
  -- Saldo: sólo una acreditación (no el uso ni la devolución de saldo).
  if new.type = 'customer_credit' and not exists (
    select 1 from public.customer_credit_movements m
    where m.id::text = split_part(coalesce(new.source_key, ''), ':', 2) and m.movement_type = 'credit'
  ) then
    return new;
  end if;
  if exists (
    select 1
    from public.customer_notifications n
    join public.order_claims c on n.source_key = 'claim-resolved:' || c.id
    where n.user_id = new.user_id
      and n.order_id = new.order_id
      and n.type = 'claim_resolved'
      and n.created_at >= now() - interval '1 day'
      and c.status = 'cerrado'
      and c.cancelled_at is null
      and coalesce(c.resolution_summary->>'kind', c.resolution) in
        ('reintegro_total', 'reintegro_parcial', 'saldo_a_favor', 'cupon_descuento')
  ) then
    return null;
  end if;
  return new;
end;
$$;

drop trigger if exists normalize_customer_claim_notification on public.customer_notifications;
create trigger normalize_customer_claim_notification
before insert on public.customer_notifications
for each row execute function public.normalize_customer_claim_notification();

revoke all on function public.normalize_customer_claim_notification() from public, anon, authenticated;

commit;
