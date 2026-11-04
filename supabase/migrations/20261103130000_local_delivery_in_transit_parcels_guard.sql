-- Envío BEYONIX: guarda estricta de "En camino" ------------------------------
-- MIGRACIÓN B (endurecimiento). Aplicar DESPUÉS de desplegar el código que
-- define, imprime y confirma los bultos BEYONIX (requiere la migración A,
-- 20261103120000_local_delivery_parcels_labels.sql).
--
-- Un pedido Envío BEYONIX sólo puede pasar a En camino con pickeo completo,
-- bultos definidos y la etiqueta (BX-PKG) de TODOS los bultos del intento
-- vigente confirmada. La aplicación ya lo valida antes de escribir; esta
-- guarda lo vuelve a exigir en la misma fila que se actualiza, bajo su lock,
-- para cualquier camino de escritura. Sólo actúa al ENTRAR a en_camino: los
-- pedidos que ya estaban En camino o Entregado no se tocan.

begin;

create or replace function public.guard_local_delivery_in_transit()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.estado = 'en_camino' and old.estado is distinct from 'en_camino'
     and public.order_is_local_delivery(new)
     and not public.local_delivery_parcels_ready(new.id) then
    raise exception 'LOCAL_DELIVERY_PARCELS_NOT_READY';
  end if;
  return new;
end $$;

drop trigger if exists guard_local_delivery_in_transit on public.ordenes;
create trigger guard_local_delivery_in_transit before update of estado on public.ordenes
  for each row execute function public.guard_local_delivery_in_transit();

revoke all on function public.guard_local_delivery_in_transit() from public, anon, authenticated;

commit;
