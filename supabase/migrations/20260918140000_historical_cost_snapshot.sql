-- Auditoría 3/7 (Fase 2): snapshot de costo histórico para proteger
-- rentabilidad ya reportada de ediciones/borrados posteriores de compras.
--
-- Hoy el costo de venta (COGS/ganancia/margen) se recalcula dinámicamente en
-- cada lectura contra `product_cost_entries` -- no hay snapshot. Editar o
-- borrar una compra antigua reescribe silenciosamente la rentabilidad ya
-- reportada de ventas posteriores.
--
-- Estas columnas son puramente aditivas (nullable, sin default distinto de
-- NULL): no cambian ningún comportamiento existente por sí solas. La
-- aplicación (lib/business/product-costs.ts:resolveReportedUnitCost) las usa
-- como fuente preferida cuando existen, con fallback al recálculo dinámico
-- de siempre cuando son NULL -- así que ninguna venta histórica cambia de
-- comportamiento por esta migración.
--
-- El congelamiento en sí (cuándo y quién escribe esta columna) vive en
-- 20260919100000_deterministic_historical_cost_snapshot.sql (web/externas,
-- vía triggers) y en app/api/admin/mercadolibre-sales (ML, al vincular) --
-- esta migración sólo agrega el espacio para guardarlo.

alter table public.orden_items
  add column if not exists costo_unitario_historico numeric(12, 2);

alter table public.external_sales
  add column if not exists costo_unitario_historico numeric(12, 2);

alter table public.mercadolibre_sales
  add column if not exists costo_unitario_historico numeric(12, 2);

comment on column public.orden_items.costo_unitario_historico is
  'Costo unitario congelado server-side (promedio ponderado de mercadería recibida a la fecha de pago), en el momento en que la orden queda reconocida como vendida -- ver trigger freeze_order_items_historical_cost_after_order. NULL = todavía sin congelar (orden aún no vendida, o venta anterior a esta migración): se sigue recalculando dinámicamente contra product_cost_entries. Una vez seteado, nunca se sobreescribe.';

comment on column public.external_sales.costo_unitario_historico is
  'Igual semántica que orden_items.costo_unitario_historico, congelado al crear la fila (trigger freeze_external_sale_historical_cost_before_insert). No confundir con unit_cost, que es un valor manual tipeado por el admin al cargar la venta (usado sólo como fallback para artículos no catalogados).';

comment on column public.mercadolibre_sales.costo_unitario_historico is
  'Igual semántica que orden_items.costo_unitario_historico. Se congela explícitamente al vincular la venta a un producto/artículo de costos (app/api/admin/mercadolibre-sales PATCH .../link) -- antes de vincular no hay producto contra el cual calcular costo alguno.';
