import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"
import type { DestructiveImpact } from "./destructive-operations.ts"

const actor = "10000000-0000-4000-8000-000000000001"
test("borrado confirmado SQL: impacto real, frase, conflicto, permisos, auditoría e idempotencia", async () => {
  const db = new PGlite()
  try {
    for (const path of ["lib/business/fixtures/purchase-cost-audit-schema.sql",
      "supabase/migrations/20260801093000_atomic_product_purchases.sql",
      "supabase/migrations/20260918150000_purchase_inventory_refresh_reproducibility.sql",
      "supabase/migrations/20260918160000_attach_purchase_cost_audit_trigger.sql",
      "supabase/migrations/20260918170000_force_delete_purchase_impact_check.sql",
      "supabase/migrations/20260922100000_admin_confirmed_force_delete.sql"]) await db.exec(readFileSync(path, "utf8"))
    await db.exec(`select set_config('request.jwt.claim.role','service_role',false);
      insert into auth.users(id) values('${actor}'); insert into profiles(id,rol) values('${actor}','super_admin');
      alter table productos add column nombre text, add column sku text;
      alter table producto_variantes add column nombre text, add column sku text;
      insert into productos(nombre,sku) values('Ñandú','SKU-1');
      insert into producto_variantes(producto_id,nombre,sku) values(1,'Azul','SKU-1-A');`)
    const { rows: purchase } = await db.query<{ id: string }>("select (save_product_purchase_atomic($1::jsonb,$2)).id", [JSON.stringify({ product_id: 1, quantity: 10, received_quantity: 6, reception_status: "parcial", purchase_date: "2026-01-01", unit_cost: 1000 }), actor])
    const id = purchase[0].id
    const preview = async (kind: string, target: string) => (await db.query<{ impact: DestructiveImpact }>("select admin_force_delete_impact($1,$2) impact", [kind, target])).rows[0].impact
    let impact = await preview("purchase", id)
    assert.equal(impact.product, "Ñandú")
    assert.equal(impact.receivedQuantity, 6)
    assert.equal(impact.currentStock, 6)
    assert.equal(impact.projectedStock, 0)
    assert.equal(impact.totalCost, 10000)
    const confirm = (phrase = impact.confirmation, fingerprint = impact.fingerprint, key = "test-delete-123") => db.query<{ result: { deleted: boolean; replayed: boolean } }>("select admin_confirm_force_delete('purchase',$1,$2,$3,$4,$5) result", [id, actor, phrase, fingerprint, key])
    await assert.rejects(confirm("sí"), /ADMIN_DELETE_CONFIRMATION/)
    await db.exec("update productos set nombre='Ñandú actualizado' where id=1")
    await assert.rejects(confirm(), /ADMIN_DELETE_CONFLICT/)
    impact = await preview("purchase", id)
    await db.exec(`update profiles set rol='admin' where id='${actor}'`)
    await assert.rejects(confirm(), /ADMIN_DELETE_FORBIDDEN/)
    await db.exec(`update profiles set rol='super_admin' where id='${actor}'`)
    const deleted = await confirm()
    assert.deepEqual(deleted.rows[0].result, { deleted: true, replayed: false })
    assert.deepEqual((await confirm()).rows[0].result, { deleted: true, replayed: true })
    assert.equal((await db.query("select * from admin_destructive_operations")).rows.length, 1)
    assert.equal((await db.query("select * from audit_logs where table_name='product_cost_entries' and action='DELETE'")).rows.length, 1)
    assert.equal((await preview("product", "1")).confirmation, "ELIMINAR PRODUCTO SKU-1")
    assert.equal((await preview("variant", "1")).confirmation, "ELIMINAR VARIANTE SKU-1-A")

    // Exercise the production delete functions too. Unrelated inventory trigger
    // bodies are inert in this fixture; deletion, unlinking and audit are real SQL.
    await db.exec(`
      alter table business_expenses add column variant_id bigint references producto_variantes(id), add column product_name text;
      alter table inventory_return_movements add column variant_id bigint references producto_variantes(id);
      alter table mercadolibre_sales add column raw_data jsonb;
      create table inventory_operation_log(id bigint generated always as identity, product_id bigint, variant_id bigint);
      create table inventory_variant_allocations(id bigint generated always as identity, product_id bigint, variant_id bigint);
      create table inventory_stock_adjustments(id bigint generated always as identity, product_id bigint, variant_id bigint);
      create table stock_reservations(id bigint generated always as identity, product_id bigint, variant_id bigint);
      create function inventory_ml_variant_id(data jsonb) returns bigint language sql as $$ select (data->'beyonix_cost_mapping'->>'variant_id')::bigint $$;
      create function fixture_inventory_trigger() returns trigger language plpgsql as $$ begin return coalesce(new,old); end $$;
    `)
    for (const [table, triggers] of Object.entries({
      product_cost_entries: ["link_cost_entry_to_shared_catalog"],
      external_sales: ["lock_inventory_external_sale", "zz_reject_negative_external_sale"],
      mercadolibre_sales: ["lock_inventory_mercadolibre_sale", "zz_reject_negative_mercadolibre_sale"],
      inventory_return_movements: ["validate_inventory_return_condition", "guard_inventory_return_variant_link"],
      inventory_operation_log: ["prevent_inventory_operation_log_mutation"],
    })) for (const trigger of triggers) await db.exec(`create trigger ${trigger} before update on ${table} for each row execute function fixture_inventory_trigger()`)
    await db.exec(readFileSync("supabase/migrations/20260820200000_force_delete_disables_catalog_relink_trigger.sql", "utf8"))
    await db.exec(`insert into product_cost_entries(product_id,variant_id,quantity,received_quantity,unit_cost) values(1,1,3,3,1000);
      insert into external_sales(product_id,variant_id) values(1,1);
      insert into inventory_return_movements(product_id,variant_id) values(1,1);`)
    for (const kind of ["variant", "product"]) {
      const target = await preview(kind, "1")
      const args = [kind, "1", actor, target.confirmation, target.fingerprint, `delete-${kind}-test`]
      await assert.rejects(db.query("select admin_confirm_force_delete($1,$2,$3,$4,$5,$6)", [...args.slice(0, 3), "sí", ...args.slice(4)]), /ADMIN_DELETE_CONFIRMATION/)
      await db.query("select admin_confirm_force_delete($1,$2,$3,$4,$5,$6)", args)
      const table = kind === "variant" ? "producto_variantes" : "productos"
      assert.equal((await db.query(`select * from ${table} where id=1`)).rows.length, 0)
      const column = kind === "variant" ? "variant_id" : "product_id"
      for (const history of ["product_cost_entries", "external_sales", "inventory_return_movements"]) {
        const rows = (await db.query<Record<string, unknown>>(`select * from ${history}`)).rows
        assert.equal(rows.length, 1, `${kind} conserva ${history}`)
        assert.equal(rows[0][column], null, `${kind} desvincula ${history}`)
      }
      assert.equal((await db.query("select * from audit_logs where table_name=$1 and action='DELETE'", [table])).rows.length, 1)
      const replay = await db.query<{ result: { replayed: boolean } }>("select admin_confirm_force_delete($1,$2,$3,$4,$5,$6) result", args)
      assert.equal(replay.rows[0].result.replayed, true)
    }
  } finally { await db.close() }
})
