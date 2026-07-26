create index if not exists productos_categoria_id_desc_idx
  on public.productos (categoria_id, id desc);

create index if not exists productos_activo_id_desc_idx
  on public.productos (activo, id desc);

create index if not exists productos_destacado_id_desc_idx
  on public.productos (destacado, id desc);

create index if not exists productos_stock_id_desc_idx
  on public.productos (stock, id desc);

create index if not exists ordenes_usuario_created_at_idx
  on public.ordenes (usuario_id, created_at desc);

create index if not exists ordenes_cliente_email_created_at_idx
  on public.ordenes (lower(cliente_email), created_at desc)
  where cliente_email is not null;
