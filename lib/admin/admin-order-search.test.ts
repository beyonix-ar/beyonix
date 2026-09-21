import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

test("búsqueda global SQL: tracking, CAE/factura, SKU, MP, cliente y paginación fuera de primeros 50", async () => {
  const db = new PGlite()
  try {
    await db.exec(readFileSync("lib/orders/fixtures/return-reception-schema.sql", "utf8"))
    await db.exec(`alter table ordenes add column admin_visible_at timestamptz default now(),
      add column cliente_nombre text, add column cliente_email text, add column cliente_telefono text,
      add column tracking_number text, add column invoice_cae text, add column invoice_number text,
      add column payment_id text, add column mercadopago_preference_id text;
      alter table productos add column nombre text, add column sku text;
      alter table producto_variantes add column nombre text, add column sku text;
      insert into ordenes select from generate_series(1,60);
      insert into productos(nombre,sku) values ('Auricular Ñandú','SKU-UNICÓ');
      insert into orden_items(orden_id,producto_id,cantidad) values(1,1,1);
      update ordenes set tracking_number='AND-1234', invoice_cae='CAE-9876', invoice_number='0001-9900',
        payment_id='MP-6677', mercadopago_preference_id='PREFERENCE-7788', cliente_nombre='María Pérez', cliente_email='maria@test.invalid', cliente_telefono='1122334455' where id=1;`)
    await db.exec(readFileSync("supabase/migrations/20260922110000_admin_order_search.sql", "utf8"))
    await db.exec("select set_config('request.jwt.claim.role','service_role',false)")
    for (const term of ["AND-1234", "CAE-9876", "0001-9900", "SKU-UNICÓ", "MP-6677", "PREFERENCE-7788", "María", "maria@test", "112233", "Ñandú", "BX-1001"]) {
      const { rows } = await db.query<{ result: { ids: number[]; total: number } }>("select search_admin_orders($1,50,0) result", [term])
      assert.deepEqual(rows[0].result, { ids: [1], total: 1 }, term)
    }
    const { rows } = await db.query<{ result: { ids: number[]; total: number } }>("select search_admin_orders('BX',10,50) result")
    assert.equal(rows[0].result.ids.length, 10)
    assert.equal(rows[0].result.total, 60)
    const empty = await db.query<{ result: { ids: number[] } }>("select search_admin_orders('%_',10,0) result")
    assert.deepEqual(empty.rows[0].result.ids, [])
    await db.exec("select set_config('request.jwt.claim.role','authenticated',false)")
    await assert.rejects(db.query("select search_admin_orders('BX',10,0)"), /Acceso denegado/)
  } finally { await db.close() }
})
