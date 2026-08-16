-- Hace que la transición sea segura también durante despliegues escalonados:
-- el código anterior puede omitir admin_visible_at sin exponer ni bloquear
-- intentos técnicos de Mercado Pago.

create or replace function public.set_order_admin_visibility()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.payment_method_id = 'mercadopago' then
    if new.payment_status = 'approved'
       and new.financial_status in (
         'payment_confirmed',
         'cancellation_requested',
         'refund_pending',
         'refunded'
       )
       and new.payment_confirmed_at is not null
       and new.payment_id is not null then
      new.admin_visible_at := coalesce(
        new.admin_visible_at,
        new.payment_confirmed_at,
        new.paid_at,
        now()
      );
    else
      new.admin_visible_at := null;
    end if;
  else
    new.admin_visible_at := coalesce(
      new.admin_visible_at,
      new.created_at,
      now()
    );
  end if;

  return new;
end;
$$;

drop trigger if exists set_order_admin_visibility on public.ordenes;
create trigger set_order_admin_visibility
before insert or update of
  payment_method_id,
  payment_status,
  financial_status,
  payment_confirmed_at,
  payment_id,
  paid_at,
  admin_visible_at
on public.ordenes
for each row execute function public.set_order_admin_visibility();

revoke all on function public.set_order_admin_visibility() from public;

comment on function public.set_order_admin_visibility() is
  'Impide que intentos MP pendientes entren al flujo admin y fija una única fecha al confirmarse el pago.';
