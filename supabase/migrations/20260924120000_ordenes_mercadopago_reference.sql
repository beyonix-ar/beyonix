-- Identificador técnico de Mercado Pago, separado del número visible del
-- pedido (BX-1000 + id). Hasta ahora `external_reference` era `ordenes.id`,
-- y los ids pueden reutilizarse (la numeración ya se reinició una vez): un
-- pago aprobado de una orden vieja con el mismo número parecía pertenecer a
-- la orden nueva. Desde esta migración las preferencias usan
-- `external_reference = 'order:<mercadopago_reference>'`, un UUID que nunca
-- se reutiliza.
--
-- Estrategia para las órdenes históricas (sin backfill):
-- - La columna se agrega SIN default y el default se define después: así las
--   filas existentes quedan en NULL (legado explícito, siguen resolviéndose
--   por su referencia numérica) y sólo las órdenes nuevas reciben un UUID.
-- - Si una orden legada vuelve a generar una preferencia, la app le asigna
--   un UUID en ese momento (UPDATE condicional `where mercadopago_reference
--   is null`) y registra `mercadopago_reference_assigned_at`. Ese timestamp
--   es la ÚNICA señal que habilita aceptar todavía su referencia numérica
--   histórica, y siempre con la huella de checkout coincidente.
-- - El índice único admite múltiples NULL (legado) y ningún UUID repetido.
-- - Una vez asignado, el UUID es inmutable (trigger).

begin;

alter table public.ordenes
  add column if not exists mercadopago_reference uuid,
  add column if not exists mercadopago_reference_assigned_at timestamptz;

alter table public.ordenes
  alter column mercadopago_reference set default gen_random_uuid();

create unique index if not exists ordenes_mercadopago_reference_unique
  on public.ordenes (mercadopago_reference);

alter table public.ordenes
  drop constraint if exists ordenes_mercadopago_reference_assigned_check;
alter table public.ordenes
  add constraint ordenes_mercadopago_reference_assigned_check
  check (
    mercadopago_reference_assigned_at is null
    or mercadopago_reference is not null
  );

comment on column public.ordenes.mercadopago_reference is
  'UUID técnico usado como external_reference de Mercado Pago (order:<uuid>). NULL = orden legada identificada por su id numérico. Inmutable una vez asignado.';
comment on column public.ordenes.mercadopago_reference_assigned_at is
  'Sólo para órdenes legadas que recibieron UUID después de creadas: habilita aceptar su referencia numérica histórica (con huella de checkout coincidente). NULL en órdenes nuevas.';

create or replace function public.prevent_ordenes_mercadopago_reference_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.mercadopago_reference is not null
     and new.mercadopago_reference is distinct from old.mercadopago_reference then
    raise exception 'mercadopago_reference es inmutable (orden %)', old.id
      using errcode = 'check_violation';
  end if;

  if old.mercadopago_reference_assigned_at is not null
     and new.mercadopago_reference_assigned_at is distinct from old.mercadopago_reference_assigned_at then
    raise exception 'mercadopago_reference_assigned_at es inmutable (orden %)', old.id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists ordenes_mercadopago_reference_immutable on public.ordenes;
create trigger ordenes_mercadopago_reference_immutable
  before update of mercadopago_reference, mercadopago_reference_assigned_at
  on public.ordenes
  for each row
  execute function public.prevent_ordenes_mercadopago_reference_change();

commit;
