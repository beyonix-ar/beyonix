-- Corrige 20261016100000: conditioned_catalog_variants (catálogo público,
-- consultado como anon) llama a order_has_active_stock_hold. En PostgreSQL el
-- permiso EXECUTE de una función usada dentro de una vista se verifica contra
-- quien consulta, no contra el dueño de la vista: sin este grant el catálogo
-- público fallaba con 42501. La función sólo responde si un pedido tiene una
-- retención física activa (booleano, sin otros datos).
grant execute on function public.order_has_active_stock_hold(bigint) to anon;

notify pgrst, 'reload schema';
