import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const migration = readFileSync(
  new URL(
    "../../supabase/migrations/20260826130000_andreani_branch_delivery.sql",
    import.meta.url,
  ),
  "utf8",
)

test("agrega las 7 columnas de sucursal destino, todas nullable (sin default ni not null)", () => {
  const columns = [
    "andreani_sucursal_id",
    "andreani_sucursal_codigo",
    "andreani_sucursal_nombre",
    "andreani_sucursal_direccion",
    "andreani_sucursal_localidad",
    "andreani_sucursal_provincia",
    "andreani_sucursal_cp",
  ]

  for (const column of columns) {
    assert.match(
      migration,
      new RegExp(`add column if not exists ${column} text(,|;|\\s*$)`, "m"),
      `${column} debe agregarse como text nullable, sin default`,
    )
    assert.doesNotMatch(
      migration,
      new RegExp(`${column} text not null`),
    )
  }

  assert.equal(
    (migration.match(/add column if not exists andreani_sucursal_/g) ?? []).length,
    7,
  )
})

test("no agrega ningún constraint que exija sucursal cuando shipping_type = 'sucursal' (pedidos históricos sin sucursal deben poder seguir existiendo)", () => {
  assert.doesNotMatch(migration, /add constraint/)
  assert.doesNotMatch(migration, /check\s*\(/)
})

test("el reclamo de creación ahora acepta domicilio Y sucursal, ya no sólo domicilio", () => {
  assert.match(migration, /shipping_type in \('domicilio', 'sucursal'\)/)
  assert.doesNotMatch(migration, /shipping_type = 'domicilio'/)
})

test("el resto de las guardas del reclamo atómico (pago, factura, cancelación, ambiente) se conservan intactas", () => {
  assert.match(migration, /invoice_status = 'authorized'/)
  assert.match(migration, /invoice_cae/)
  assert.match(migration, /lower\(coalesce\(estado, ''\)\) <> 'cancelado'/)
  assert.match(migration, /p_environment not in \('QA', 'PROD'\)/)
  assert.match(migration, /auth\.role\(\) <> 'service_role'/)
  assert.match(migration, /andreani_creation_status = 'rejected'/)
})

test("no toca ni borra ninguna migración anterior ni dato existente (sólo add column / create or replace function)", () => {
  assert.doesNotMatch(migration, /drop table/i)
  assert.doesNotMatch(migration, /drop column/i)
  assert.doesNotMatch(migration, /delete from/i)
  assert.doesNotMatch(migration, /truncate/i)
  assert.doesNotMatch(migration, /update public\.ordenes\s*\n\s*set\s+andreani_sucursal/i)
})
