-- Los créditos y débitos manuales del panel anterior eran ajustes de saldo,
-- pero se guardaban incorrectamente como Gift Cards y, en créditos, vencían.
update public.customer_credit_movements
set
  metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
    'created_from', 'admin_balance_adjustment',
    'source_kind', 'balance_adjustment',
    'reclassified_at', now()
  ),
  expires_at = null
where metadata->>'created_from' = 'admin_gift_card_panel';

comment on table public.customer_credit_movements is
  'Libro de movimientos de saldo. Los ajustes administrativos usan source_kind balance_adjustment; las Gift Cards usan source_kind gift_card.';
