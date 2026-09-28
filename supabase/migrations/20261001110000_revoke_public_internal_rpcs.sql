-- RPC SECURITY DEFINER internas que quedaron ejecutables por anon/authenticated
-- (grants por defecto del esquema) sin chequeo de rol propio:
--   * ensure_cost_catalog_product(text, text): crea productos (no publicados) o
--     cambia el SKU de artículos de costos. Sólo la usa el servidor con
--     service_role (/api/admin/costs/new-article) y el trigger
--     link_cost_entry_to_shared_catalog, que corre como owner.
--   * email_exists_for_password_recovery(text): permitía enumerar emails
--     registrados. La aplicación ya no la usa.
-- Sólo se quitan permisos: no cambia datos ni lógica. Idempotente.

do $$
begin
  if to_regprocedure('public.ensure_cost_catalog_product(text, text)') is not null then
    revoke execute on function public.ensure_cost_catalog_product(text, text) from public, anon, authenticated;
    grant execute on function public.ensure_cost_catalog_product(text, text) to service_role;
  end if;
  if to_regprocedure('public.email_exists_for_password_recovery(text)') is not null then
    revoke execute on function public.email_exists_for_password_recovery(text) from public, anon, authenticated;
    grant execute on function public.email_exists_for_password_recovery(text) to service_role;
  end if;
end;
$$;
