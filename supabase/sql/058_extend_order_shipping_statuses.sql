alter table public.ordenes
  drop constraint if exists ordenes_estado_check;

alter table public.ordenes
  add constraint ordenes_estado_check check (
    estado in (
      'pendiente',
      'pagado',
      'enviado',
      'en_camino',
      'visita_fallida',
      'en_sucursal',
      'retiro_pendiente',
      'retiro_vencido',
      'en_devolucion',
      'devuelto_beyonix',
      'entregado',
      'cancelado'
    )
  );
