insert into public.site_settings (key, value, description)
values (
  'stock',
  '{"criticalStockThreshold":3,"lowStockThreshold":6,"availableStockThreshold":7}'::jsonb,
  'Umbrales de color para el estado del stock.'
)
on conflict (key) do nothing;
