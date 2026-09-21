-- Auditoría 3/7 (compras/reposición/costos), Fase 4, punto 1 -- CONFIRMADO
-- en vivo contra producción (solo lectura, 2026-09-18/19; ver reporte para el
-- detalle exacto de las consultas).
--
-- Estado real verificado en producción, ANTES de esta migración:
--
-- 1. product_cost_entries tiene GRANT INSERT/UPDATE/DELETE/SELECT/TRUNCATE/
--    REFERENCES/TRIGGER a `anon` Y a `authenticated` (information_schema.
--    role_table_grants) -- más amplio de lo que se había supuesto (sólo se
--    esperaba `authenticated`, heredado de supabase/sql/080_business_costs.
--    sql:130-150).
-- 2. RLS está ENABLED (relrowsecurity=true) con UNA sola policy PERMISSIVE:
--    "Admins manage product costs", FOR ALL, TO authenticated, USING/WITH
--    CHECK (current_user_role() = ANY (ARRAY['admin','super_admin'])).
-- 3. `anon` no tiene ninguna policy que lo alcance -- RLS lo bloquea por
--    completo pese a tener el GRANT (el grant sin policy es inerte, pero
--    innecesario: se revoca igual por buena práctica).
-- 4. `authenticated` SÍ puede ejercer el GRANT vía la policy: CONFIRMADO que
--    HOY, cualquier usuario autenticado con rol admin/super_admin puede hacer
--    INSERT/UPDATE/DELETE directo sobre product_cost_entries desde un
--    cliente Supabase normal (browser), saltando pg_advisory_xact_lock, la
--    idempotencia, el registro de actor (beyonix.actor_id) y el trigger de
--    auditoría -- las cuatro protecciones que sólo aplican pasando por
--    save_product_purchase_atomic / save_product_purchase_idempotent /
--    delete_product_purchase_atomic / force_delete_purchase_super_admin.
-- 5. `service_role` tiene rolbypassrls=true (confirmado): el backend
--    (Next.js, cliente auth.admin) nunca pasa por RLS ni por estos grants --
--    esta migración no le afecta en nada.
--
-- No se revoca SELECT (no es el problema reportado, y ambos roles lo
-- necesitan para lectura vía policy). No se toca la policy en sí (sigue
-- siendo necesaria para el SELECT). No se tocan otras tablas.

begin;

revoke insert, update, delete on public.product_cost_entries
  from authenticated;

revoke insert, update, delete on public.product_cost_entries
  from anon;

commit;
