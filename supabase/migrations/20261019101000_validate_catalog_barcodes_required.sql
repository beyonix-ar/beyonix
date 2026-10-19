-- La transacción anterior completó todos los códigos faltantes.
alter table public.producto_variantes
  validate constraint producto_variantes_codigo_barra_required;
