-- Financiación Mercado Pago: reemplaza el modelo excluyente de cuotas
-- (cuotas_sin_interes + cuotas_maximas: 3|6|null) por tres flags
-- independientes (2/3/6 cuotas).
--
-- Paso 1/2: agregar las columnas nuevas y migrar los datos. El DROP de las
-- columnas viejas queda en una migración separada (20260827100001) porque
-- Postgres no permite un ALTER TABLE ... DROP COLUMN sobre "productos" en
-- la misma transacción que un UPDATE que dispara sus triggers (eventos de
-- trigger pendientes, SQLSTATE 55006).

alter table public.productos
  add column if not exists cuotas_2_habilitadas boolean not null default false,
  add column if not exists cuotas_3_habilitadas boolean not null default false,
  add column if not exists cuotas_6_habilitadas boolean not null default false,
  add column if not exists promo_original_cuotas_2_habilitadas boolean,
  add column if not exists promo_original_cuotas_3_habilitadas boolean,
  add column if not exists promo_original_cuotas_6_habilitadas boolean;

-- Backfill 1:1 sin ambigüedad: el modelo anterior era excluyente por
-- construcción (un único <select> en el editor de producto), así que
-- cuotas_maximas=3 sólo pudo significar "3 cuotas habilitadas, 6 no" y
-- viceversa. 2 cuotas no existía como modalidad antes: arranca en false
-- para todos los productos existentes (nunca se habilita algo nuevo).
update public.productos
set
  cuotas_3_habilitadas = (cuotas_sin_interes is true and cuotas_maximas = 3),
  cuotas_6_habilitadas = (cuotas_sin_interes is true and cuotas_maximas = 6);

update public.productos
set
  promo_original_cuotas_3_habilitadas = (
    promo_original_cuotas_sin_interes is true and promo_original_cuotas_maximas = 3
  ),
  promo_original_cuotas_6_habilitadas = (
    promo_original_cuotas_sin_interes is true and promo_original_cuotas_maximas = 6
  )
where promo_event_id is not null;
