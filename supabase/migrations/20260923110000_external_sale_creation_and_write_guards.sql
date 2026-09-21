begin;

alter table public.external_sales
  add column creation_idempotency_key text,
  add column creation_request jsonb;
create unique index external_sales_creation_key_uidx on public.external_sales(creation_idempotency_key)
  where creation_idempotency_key is not null;
alter table public.external_sales add constraint external_sales_creation_request_check check (
  (creation_idempotency_key is null and creation_request is null) or
  (creation_idempotency_key is not null and length(creation_idempotency_key) between 8 and 240 and creation_request is not null)
);

-- Policies cannot grant a privilege revoked at the table level. SELECT stays intact.
revoke insert, update, delete, truncate, references, trigger on public.external_sales from public, anon, authenticated;

create or replace function public.guard_external_sale_history()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.status = 'reversed' then
    -- Existing super-admin force-delete RPCs detach catalog references while
    -- preserving the sale. Allow only that backend operation, never an edit.
    if auth.role() is distinct from 'service_role'
       or (to_jsonb(new) - array['product_id', 'variant_id', 'updated_at'])
          is distinct from (to_jsonb(old) - array['product_id', 'variant_id', 'updated_at'])
       or (new.product_id is not null and new.product_id is distinct from old.product_id)
       or (new.variant_id is not null and new.variant_id is distinct from old.variant_id)
       or (new.product_id is not distinct from old.product_id and new.variant_id is not distinct from old.variant_id) then
      raise exception 'EXTERNAL_SALE_ALREADY_REVERSED';
    end if;
  end if;
  if new.creation_idempotency_key is distinct from old.creation_idempotency_key
     or new.creation_request is distinct from old.creation_request then
    raise exception 'EXTERNAL_SALE_CREATION_IMMUTABLE';
  end if;
  return new;
end;
$$;
create trigger guard_external_sale_history before update on public.external_sales
for each row execute function public.guard_external_sale_history();

create or replace function public.create_external_sale_idempotent(
  p_payload jsonb, p_actor_id uuid, p_idempotency_key text
)
returns public.external_sales language plpgsql security definer set search_path = public as $$
declare
  v_sale public.external_sales%rowtype;
  v_input public.external_sales%rowtype;
begin
  if auth.role() is distinct from 'service_role' or not exists (
    select 1 from public.profiles where id = p_actor_id and rol in ('admin', 'super_admin')
  ) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 8 and 240 then
    raise exception 'IDEMPOTENCY_KEY_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtext('external-sale-create'), hashtext(p_idempotency_key));
  select * into v_sale from public.external_sales where creation_idempotency_key = p_idempotency_key;
  if found then
    if v_sale.creation_request is distinct from p_payload or v_sale.created_by is distinct from p_actor_id then
      raise exception 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    end if;
    return v_sale;
  end if;
  select * into v_input from jsonb_populate_record(null::public.external_sales, p_payload);
  perform set_config('beyonix.actor_id', p_actor_id::text, true);
  insert into public.external_sales (
    sale_date, product_id, variant_id, product_name, sku, quantity, unit_price, unit_cost,
    gross_amount, fee_type, fee_value, fee_amount, shipping_amount, other_expense_amount,
    net_amount, payment_method, reference, customer_name, notes, created_by, updated_by,
    creation_idempotency_key, creation_request
  ) values (
    v_input.sale_date, v_input.product_id, v_input.variant_id, v_input.product_name, v_input.sku,
    v_input.quantity, v_input.unit_price, v_input.unit_cost, v_input.gross_amount,
    v_input.fee_type, v_input.fee_value, v_input.fee_amount, v_input.shipping_amount,
    v_input.other_expense_amount, v_input.net_amount, v_input.payment_method,
    v_input.reference, v_input.customer_name, v_input.notes, p_actor_id, p_actor_id,
    p_idempotency_key, p_payload
  ) returning * into v_sale;
  return v_sale;
end;
$$;
revoke all on function public.create_external_sale_idempotent(jsonb, uuid, text) from public, anon, authenticated;
grant execute on function public.create_external_sale_idempotent(jsonb, uuid, text) to service_role;
notify pgrst, 'reload schema';
commit;
