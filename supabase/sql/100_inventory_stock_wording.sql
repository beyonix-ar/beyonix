-- Actualiza únicamente la descripción de la vista, sin reconstruir inventario,
-- reemplazar funciones ni modificar datos.

comment on view public.inventory_stock_breakdown is
  'Explica el stock por producto y variante usando compras, ventas, devoluciones y salidas.';
