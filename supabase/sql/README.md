# Histórico — no es la fuente de verdad

Esta carpeta **no representa el estado actual de la base de datos**. Es un
registro manual del esquema que se fue armando antes (y en paralelo) de
adoptar `supabase/migrations/` con el CLI de Supabase.

## Fuente de verdad

La única fuente de verdad operativa del esquema es **`supabase/migrations/`**.
Está sincronizada 1:1 con el proyecto remoto (comprobable con
`supabase migration list`).

## Por qué sigue existiendo esta carpeta

Gran parte del esquema (aproximadamente hasta la numeración `092_*`) se aplicó al
remoto manualmente, antes de que el proyecto empezara a versionar cambios
como migraciones con el CLI (`supabase/migrations/` arranca el
2026-07-29 con una migración base vacía, porque el esquema ya existía). Para
esos archivos, `supabase/sql/` es el único registro legible que queda de cómo
se construyó esa parte del esquema.

A partir de ahí, varios archivos numerados en esta carpeta tienen una
migración equivalente en `supabase/migrations/` — pero **no todos**, y al
menos un caso confirmado (`103_separate_conditioned_return_stock.sql` /
`104_conditioned_stock_management.sql`) quedó desactualizado respecto de una
corrección posterior que sólo existe en `supabase/migrations/`
(`20260801103000_fix_return_condition_validation.sql`). No asumas que un
archivo de acá es correcto o vigente sin cruzarlo contra
`supabase/migrations/`.

## Reglas para trabajar acá

- **No editar** estos archivos para "corregir" algo. Si hace falta un cambio
  de esquema, se crea una migración nueva en `supabase/migrations/`.
- **No aplicar** manualmente un archivo de acá contra la base para resolver
  un error de "falta esta columna/función" — eso puede reintroducir lógica ya
  superada. Buscá primero si `supabase/migrations/` ya lo resuelve.
- **No borrar** archivos sueltos sin verificar referencias. Al menos
  `lib/customer-credit/customer-balance-retirement.test.ts` lee
  `057_customer_credit_balance.sql` como fixture de un test de contrato.
