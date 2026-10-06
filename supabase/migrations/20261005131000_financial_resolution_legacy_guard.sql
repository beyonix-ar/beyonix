-- Una intención financiera elegida por Admin impide que los flujos anteriores
-- creen dinero/comprobantes con otro destino mientras está en curso.
create or replace function public.guard_claim_refund_proof()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_resolution_id uuid;
begin
  select id into v_resolution_id from public.order_financial_resolutions
    where order_id=new.order_id;
  if v_resolution_id is not null and new.financial_resolution_id is distinct from v_resolution_id then
    raise exception 'FINANCIAL_CHOICE_CONFLICT';
  end if;
  perform public.assert_order_claim_money_released(new.order_id);
  return new;
end;
$$;
revoke all on function public.guard_claim_refund_proof() from public,anon,authenticated;

create or replace function public.guard_order_financial_note_choice()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_choice text;
begin
  select choice into v_choice from public.order_financial_resolutions
    where order_id=new.order_id;
  if v_choice is not null and new.destination<>'none' and
     ((v_choice='beyonix_credit' and new.destination<>'customer_balance') or
      (v_choice in ('manual_refund','mercadopago_refund') and new.destination<>'external_refund')) then
    raise exception 'FINANCIAL_CHOICE_CONFLICT';
  end if;
  return new;
end;
$$;
drop trigger if exists ab_guard_order_financial_note_choice on public.order_credit_notes;
create trigger ab_guard_order_financial_note_choice before insert or update of destination
  on public.order_credit_notes for each row execute function public.guard_order_financial_note_choice();
revoke all on function public.guard_order_financial_note_choice() from public,anon,authenticated;

create or replace function public.guard_order_financial_resolution_note()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  if exists (
    select 1 from public.order_credit_notes n where n.order_id=new.order_id
      and n.status in ('processing','authorized') and n.destination<>'none'
      and ((new.choice='beyonix_credit' and n.destination<>'customer_balance') or
           (new.choice in ('manual_refund','mercadopago_refund') and n.destination<>'external_refund'))
  ) then raise exception 'FINANCIAL_CHOICE_CONFLICT'; end if;
  return new;
end;
$$;
drop trigger if exists guard_order_financial_resolution_note on public.order_financial_resolutions;
create trigger guard_order_financial_resolution_note before insert
  on public.order_financial_resolutions for each row execute function public.guard_order_financial_resolution_note();
revoke all on function public.guard_order_financial_resolution_note() from public,anon,authenticated;

notify pgrst, 'reload schema';
