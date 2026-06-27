alter table public.order_claims
  add column if not exists offered_resolutions text[] not null default '{}',
  add column if not exists customer_selected_resolution text;

alter table public.order_claims
  drop constraint if exists order_claims_offered_resolutions_check,
  add constraint order_claims_offered_resolutions_check check (
    offered_resolutions <@ array[
      'cambio_producto',
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
      'reintegro_total',
      'reintegro_parcial',
      'cupon_descuento',
      'otro'
    )
  );
