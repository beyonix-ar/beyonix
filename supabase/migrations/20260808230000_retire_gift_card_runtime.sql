begin;

-- Retira las superficies ejecutables del sistema discontinuado sin alterar
-- movimientos de saldo ni registros históricos financieros.
drop function if exists public.create_claimable_customer_gift_card(
  uuid, text, text, text, numeric, text, text, text, timestamptz
);
drop function if exists public.claim_customer_gift_card(uuid, uuid);
drop function if exists public.cancel_unclaimed_customer_gift_card(uuid, text);
drop function if exists public.reserve_customer_gift_card_email_delivery(uuid);
drop function if exists public.complete_customer_gift_card_email_delivery(
  uuid, boolean, text, text
);

do $$
begin
  if to_regclass('public.customer_gift_cards') is not null then
    execute 'drop policy if exists "Customers can read related gift cards" on public.customer_gift_cards';
    execute 'revoke all on table public.customer_gift_cards from anon, authenticated';
    execute 'comment on table public.customer_gift_cards is ''Archivo histórico del sistema discontinuado de tarjetas regalo. No admite operaciones desde la aplicación.''';

    if exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'customer_gift_cards'
    ) then
      alter publication supabase_realtime drop table public.customer_gift_cards;
    end if;
  end if;
end;
$$;

-- customer_store_benefits también almacena descuentos. Se conserva la tabla y
-- se limita la lectura de la aplicación al único tipo todavía operativo.
do $$
begin
  if to_regclass('public.customer_store_benefits') is not null then
    execute 'drop policy if exists "Customers can read own store benefits" on public.customer_store_benefits';
    execute 'drop policy if exists "Admins can create store benefits" on public.customer_store_benefits';
    execute $policy$
      create policy "Customers can read own discounts"
      on public.customer_store_benefits
      for select
      to authenticated
      using (user_id = auth.uid() and benefit_type = 'discount')
    $policy$;
    execute $policy$
      create policy "Admins can create discounts"
      on public.customer_store_benefits
      for insert
      to authenticated
      with check (
        public.current_user_role() in ('admin', 'super_admin')
        and benefit_type = 'discount'
      )
    $policy$;
  end if;
end;
$$;

commit;
