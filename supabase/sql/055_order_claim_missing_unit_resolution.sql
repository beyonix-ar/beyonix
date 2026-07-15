alter table public.order_claims
  drop constraint if exists order_claims_resolution_check,
  add constraint order_claims_resolution_check check (
    resolution is null
    or resolution in (
      'cambio_producto',
      'envio_unidad_faltante',
      'reintegro_total',
      'reintegro_parcial',
      'cupon_descuento',
      'rechazado',
      'otro'
    )
  );

alter table public.order_claims
  drop constraint if exists order_claims_offered_resolutions_check,
  add constraint order_claims_offered_resolutions_check check (
    offered_resolutions <@ array[
      'cambio_producto',
      'envio_unidad_faltante',
      'reintegro_total',
      'reintegro_parcial',
      'cupon_descuento',
      'otro'
    ]::text[]
  );

alter table public.order_claims
  drop constraint if exists order_claims_customer_selected_resolution_check,
  add constraint order_claims_customer_selected_resolution_check check (
    customer_selected_resolution is null
    or customer_selected_resolution in (
      'cambio_producto',
      'envio_unidad_faltante',
      'reintegro_total',
      'reintegro_parcial',
      'cupon_descuento',
      'otro'
    )
  );
