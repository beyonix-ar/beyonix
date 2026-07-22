insert into public.site_settings (key, value, description)
values (
  'customer_credit_payments',
  '{"mercadoPagoSurchargePercent":8,"mercadoPagoMinimumAmount":10000}'::jsonb,
  'Configuración de medios de pago para cargas de saldo.'
)
on conflict (key) do update
set
  value = jsonb_build_object(
    'mercadoPagoMinimumAmount',
    coalesce(
      public.site_settings.value -> 'mercadoPagoMinimumAmount',
      '10000'::jsonb
    )
  ) || public.site_settings.value,
  updated_at = now();
