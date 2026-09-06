-- RLS (Row Level Security) para order_claims / order_claim_messages /
-- order_claim_files. Auditoría confirmó que estas 3 tablas no tienen
-- ninguna policy hoy: toda la autorización real vive en los endpoints
-- (app/api/orders/[id]/claims/route.ts, app/api/admin/order-claims/...),
-- que siempre usan createAdminClient() (service_role). El rol service_role
-- de Supabase hace bypass de RLS automáticamente, así que habilitar RLS acá
-- SIN agregar policies para anon/authenticated no cambia el comportamiento
-- actual de la app -- sólo cierra el hueco de "no hay defensa en
-- profundidad a nivel DB": si en el futuro algún código llegara a golpear
-- estas tablas con el cliente anon/autenticado del navegador, el acceso
-- queda denegado por defecto en vez de expuesto.
--
-- No se tocan columnas, constraints, índices ni datos. Es un cambio
-- aditivo, seguro para reclamos históricos y sin pérdida de datos.
--
-- NOTA IMPORTANTE (reportada, no resuelta en esta migración): el DDL
-- fundacional de estas 3 tablas (CREATE TABLE, columnas agregadas para
-- reintegro/cupón/primera revisión/items afectados/reemplazo, y sus CHECK
-- constraints) no vive en supabase/migrations/ -- vive repartido en al
-- menos 10 archivos de supabase/sql/ (023, 024, 027, 029, 033, 034, 055,
-- 057, 090 y posiblemente otros), que es un archivo histórico/manual según
-- supabase/sql/README.md. Reconstruir una migración consolidada 100% fiel
-- a esos ~10 archivos requiere auditarlos uno por uno con cuidado (tipos,
-- defaults, constraints exactos) -- no se hizo en esta tarea para no
-- arriesgar una migración con datos incorrectos que el usuario ejecutaría
-- manualmente. Ver el punto 14 de la devolución final para el detalle.
alter table public.order_claims enable row level security;
alter table public.order_claim_messages enable row level security;
alter table public.order_claim_files enable row level security;
