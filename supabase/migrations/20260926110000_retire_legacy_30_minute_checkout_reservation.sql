-- Cierre Fases 1-4: retira la lógica heredada de reserva de 30 minutos.
--
-- ÚNICA regla comercial vigente: la reserva del Paso 3 dura
-- checkout_step_reservation_ttl() (20 minutos) y todos los medios de pago la
-- comprometen sin renovarla:
--   * Mercado Pago:           commit_mercadopago_checkout_reservation (20260925130000)
--   * Transferencia / saldo:  commit_checkout_step_reservation        (20260926100000)
--
-- Lo que se retira (sin llamadores en app, RPC, triggers ni vistas; verificado
-- contra supabase/migrations y el baseline de producción 2026-09-21):
--   * validate_checkout_inventory_reservation(jsonb,text,bigint): wrapper de
--     Fase 1 sobre el validador heredado. Reemplazaba las filas de la sesión
--     por una reserva NUEVA de 30 minutos (renovación), aun vencida la del
--     Paso 3. Ninguna ruta lo usa desde el cierre de Fase 4.
--   * validate_checkout_inventory_reservation_before_step_reservations: el
--     validador heredado renombrado en 20260925120000 (sin permisos para
--     ningún rol de API).
--   * complete_cart_stock_reservation(text,bigint): vinculaba sin revalidar
--     stock; sin permisos para ningún rol desde 20260925120000.
--   * checkout_reservation_ttl(): los 30 minutos. Su único llamador restante
--     era el validador heredado.
--
-- Se conservan (no son lógica de 30 minutos): available_stock_for_session,
-- purge_expired_stock_reservations, release_cart_stock_reservation (endurecida
-- en 20260925120000) y release_order_stock_reservation.
--
-- ORDEN DE DESPLIEGUE: aplicar DESPUÉS de 20260925120000, 20260925130000 y
-- 20260926100000 y del deploy del código de las Fases 1-4. El código anterior
-- a esas fases todavía llama a validate_checkout_inventory_reservation desde
-- transferencia y saldo a favor.
--
-- DROP (no revoke): en plpgsql las llamadas no generan dependencias
-- registradas, por eso se verificó explícitamente que no queda ningún
-- llamador. Si alguno quedara, fallaría en vez de renovar reservas en
-- silencio -- el comportamiento seguro.
begin;

drop function if exists public.validate_checkout_inventory_reservation(jsonb, text, bigint);
drop function if exists public.validate_checkout_inventory_reservation_before_step_reservations(jsonb, text, bigint);
drop function if exists public.complete_cart_stock_reservation(text, bigint);
drop function if exists public.checkout_reservation_ttl();

notify pgrst, 'reload schema';

commit;
