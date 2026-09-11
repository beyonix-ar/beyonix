import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), "utf8")
const migration = read("supabase/migrations/20260911140000_restrict_order_items_client_writes.sql")
const fixture = read("lib/orders/fixtures/order-items-authorization.sql")
const customer = "10000000-0000-4000-8000-000000000001"
const other = "10000000-0000-4000-8000-000000000002"
const admin = "10000000-0000-4000-8000-000000000003"
const superAdmin = "10000000-0000-4000-8000-000000000004"
const withoutProfile = "10000000-0000-4000-8000-000000000005"
const states = [
  ["pendiente", "pending"],
  ["pagado", "approved"],
  ["pendiente", "confirmado"],
  ["preparado", "confirmado"],
  ["enviado", "confirmado"],
]
type ApiRole = "anon" | "authenticated" | "service_role"

async function asRole<T>(db: PGlite, role: ApiRole, uid: string | null, action: () => Promise<T>) {
  await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ role, sub: uid })])
  await db.exec(`set role ${role}`)
  try {
    return await action()
  } finally {
    await db.exec("reset role")
  }
}

async function setup(db: PGlite) {
  await db.exec(fixture)
  for (const [id, role] of [[customer, "cliente"], [other, "cliente"], [admin, "admin"], [superAdmin, "super_admin"]]) {
    await db.query("insert into public.profiles values ($1,$2)", [id, role])
  }
  await db.exec("insert into public.productos values (1,20)")
  for (const [index, [status, paymentStatus]] of states.entries()) {
    await db.query("insert into public.ordenes values ($1,$2,$3,$4,100,100,100)",
      [index + 1, customer, status, paymentStatus])
  }
  await db.query("insert into public.ordenes values (10,$1,'pendiente','pending',100,100,100),(11,null,'pendiente','pending',100,100,100)", [other])
  await db.exec(`insert into public.orden_items(orden_id,producto_id,cantidad,precio)
    select id,1,1,100 from public.ordenes order by id`)
}

// Todos los pedidos/ítems son sintéticos y viven exclusivamente en PGlite en
// memoria. No hay red, credenciales, RPC financieras ni aplicación en Supabase.
test("PostgreSQL: cierre de escrituras directas sobre orden_items", async (t) => {
  const db = new PGlite()
  try {
    await setup(db)
    await t.test("antes: INSERT propio permite ampliar pedidos en todos los estados sin recalcular el total", async () => {
      await asRole(db, "authenticated", customer, async () => {
        for (const [index] of states.entries()) {
          await db.query("insert into public.orden_items(orden_id,producto_id,cantidad,precio) values ($1,1,1,500)", [index + 1])
        }
        const result = await db.query<{ total: string; original_total: string; external_amount_due: string; subtotal: string }>(`
          select o.total,o.original_total,o.external_amount_due,sum(i.cantidad*i.precio) subtotal
          from public.ordenes o join public.orden_items i on i.orden_id=o.id
          group by o.id order by o.id`)
        assert.equal(result.rows.length, states.length)
        for (const row of result.rows) assert.deepEqual(row, {
          total: "100", original_total: "100", external_amount_due: "100", subtotal: "600",
        })
      })
    })

    await t.test("antes: RLS impide INSERT ajeno y UPDATE/DELETE de clientes, aunque existan grants", async () => {
      await asRole(db, "authenticated", customer, async () => {
        await assert.rejects(db.exec("insert into public.orden_items(orden_id,producto_id,cantidad,precio) values (10,1,1,500)"),
          /row-level security/)
        assert.equal((await db.query("update public.orden_items set precio=1 where orden_id=1 returning id")).rows.length, 0)
        assert.equal((await db.query("delete from public.orden_items where orden_id=1 returning id")).rows.length, 0)
      })
    })

    const beforeRows = (await db.query("select * from public.orden_items order by id")).rows
    const beforeTriggers = (await db.query("select pg_get_triggerdef(oid) definition from pg_trigger where tgrelid='public.orden_items'::regclass order by tgname")).rows
    const beforeReadPolicy = (await db.query("select * from pg_policies where schemaname='public' and tablename='orden_items' and policyname='Users can read own order items'")).rows

    // Sólo ejecuta las seis sentencias de ACL/policies de la propuesta contra
    // el fixture en memoria; no aplica la migración a ninguna instancia Supabase.
    const statements = migration.match(/(?:revoke all privileges|grant select|drop policy if exists|create policy)[\s\S]*?;/g) ?? []
    assert.equal(statements.length, 6)
    await db.exec(statements.join("\n"))

    await t.test("después: sólo SELECT para clientes, DML conservado para service_role, PUBLIC sin grants", async () => {
      const rows = (await db.query<{ role: string; read: boolean; write: boolean }>(`
        select role,has_table_privilege(role,'public.orden_items','SELECT') read,
          has_table_privilege(role,'public.orden_items','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') write
        from unnest(array['anon','authenticated','service_role','unrelated_role']) role`)).rows
      assert.deepEqual(rows, [
        { role: "anon", read: true, write: false },
        { role: "authenticated", read: true, write: false },
        { role: "service_role", read: true, write: true },
        { role: "unrelated_role", read: false, write: false },
      ])
      const publicGrants = await db.query(`select 1 from pg_class c, lateral aclexplode(c.relacl) acl
        where c.oid='public.orden_items'::regclass and acl.grantee=0`)
      assert.equal(publicGrants.rows.length, 0)
      const policies = (await db.query<{ cmd: string }>("select cmd from pg_policies where schemaname='public' and tablename='orden_items'")).rows
      assert.equal(policies.length, 2)
      assert.ok(policies.every(({ cmd }) => cmd === "SELECT"))
      assert.equal((await db.query<{ rls: boolean }>("select relrowsecurity rls from pg_class where oid='public.orden_items'::regclass")).rows[0].rls, true)
    })

    await t.test("después: INSERT/UPDATE/DELETE fallan incluso con ownership, perfil admin y estados pagados/enviados", async () => {
      const actors: [ApiRole, string | null][] = [
        ["anon", null], ["authenticated", null], ["authenticated", withoutProfile],
        ["authenticated", customer], ["authenticated", admin], ["authenticated", superAdmin],
      ]
      for (const [role, uid] of actors) {
        await asRole(db, role, uid, async () => {
          for (const [index] of states.entries()) {
            const orderId = index + 1
            for (const statement of [
              "insert into public.orden_items(orden_id,producto_id,cantidad,precio) values ($1,1,1,500)",
              "update public.orden_items set precio=1,cantidad=2 where orden_id=$1",
              "delete from public.orden_items where orden_id=$1",
            ]) await assert.rejects(db.query(statement, [orderId]), /permission denied for table orden_items/)
          }
          await assert.rejects(db.exec("truncate public.orden_items"), /permission denied for table orden_items/)
        })
      }
      assert.deepEqual((await db.query("select * from public.orden_items order by id")).rows, beforeRows)
    })

    await t.test("después: conserva lectura propia/admin y no expone ítems ajenos ni de invitados", async () => {
      await asRole(db, "authenticated", customer, async () => {
        const rows = (await db.query<{ orden_id: number }>("select distinct orden_id from public.orden_items order by orden_id")).rows
        assert.deepEqual(rows.map(({ orden_id }) => orden_id), [1, 2, 3, 4, 5])
      })
      await asRole(db, "authenticated", other, async () => {
        assert.deepEqual((await db.query("select distinct orden_id from public.orden_items")).rows, [{ orden_id: 10 }])
      })
      await asRole(db, "authenticated", admin, async () => {
        assert.equal((await db.query("select * from public.orden_items")).rows.length, beforeRows.length)
      })
      await asRole(db, "anon", null, async () => {
        assert.equal((await db.query("select * from public.orden_items")).rows.length, 0)
      })
      assert.deepEqual((await db.query("select * from pg_policies where schemaname='public' and tablename='orden_items' and policyname='Users can read own order items'")).rows, beforeReadPolicy)
    })

    await t.test("después: backend conserva INSERT, garantías UPDATE y limpieza DELETE, incluido checkout invitado", async () => {
      await asRole(db, "service_role", null, async () => {
        for (const orderId of [1, 2, 3, 4, 5, 11]) {
          const inserted = await db.query<{ id: number }>("insert into public.orden_items(orden_id,producto_id,cantidad,precio) values ($1,1,1,100) returning id", [orderId])
          const id = inserted.rows[0].id
          const updated = await db.query<{ warranty_status: string }>("update public.orden_items set warranty_status='active' where id=$1 returning warranty_status", [id])
          assert.equal(updated.rows[0].warranty_status, "active")
          assert.equal((await db.query("delete from public.orden_items where id=$1 returning id", [id])).rows.length, 1)
        }
      })
      assert.deepEqual((await db.query("select pg_get_triggerdef(oid) definition from pg_trigger where tgrelid='public.orden_items'::regclass order by tgname")).rows, beforeTriggers)
    })

    await t.test("después: una escritura SQL DEFINER legítima conserva privilegios del dueño", async () => {
      await db.exec(`create function public.test_item_backend_update(p_order_id bigint) returns void
        language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$ begin
        if auth.role() is distinct from 'service_role' then raise exception 'FORBIDDEN'; end if;
        update public.orden_items set warranty_status='active' where orden_id=p_order_id;
        end $$;
        revoke all on function public.test_item_backend_update(bigint) from public,anon,authenticated;
        grant execute on function public.test_item_backend_update(bigint) to service_role;`)
      await asRole(db, "service_role", null, async () => {
        await db.query("select public.test_item_backend_update(1)")
        const rows = (await db.query<{ warranty_status: string }>("select warranty_status from public.orden_items where orden_id=1")).rows
        assert.ok(rows.length > 0 && rows.every(({ warranty_status }) => warranty_status === "active"))
      })
    })
  } finally {
    await db.close()
  }
})

test("los únicos escritores TypeScript de ítems siguen en backend; los tres checkouts usan service_role", () => {
  const writers: string[] = []
  function scan(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) scan(path)
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
        if (/\.from\(["']orden_items["']\)\s*\.\s*(insert|update|delete|upsert)\(/.test(readFileSync(path, "utf8"))) {
          writers.push(relative(root, path).replaceAll("\\", "/"))
        }
      }
    }
  }
  for (const directory of ["app", "lib", "hooks", "context", "components"]) scan(join(root, directory))
  assert.deepEqual(writers.sort(), [
    "app/api/admin/pedidos/[id]/warranty/[itemId]/route.ts",
    "lib/orders/checkout-inventory.ts",
    "lib/orders/checkout-order-creation.ts",
    "lib/orders/warranty-activation.ts",
  ].sort())
  for (const path of ["app/api/transferencia/create-order/route.ts", "app/api/mercadopago/create-preference/route.ts"]) {
    const source = read(path)
    assert.match(source, /const admin = createAdminClient\(\)/)
    assert.match(source, /const orderClient = admin/)
    assert.match(source, /insertCheckoutOrderItemsAndValidateInventory\(\{\s*orderClient,\s*admin,/)
  }
  const creditCheckout = read("app/api/customer-credit/create-order/route.ts")
  assert.match(creditCheckout, /const admin = createAdminClient\(\)/)
  assert.match(creditCheckout, /insertCheckoutOrderItemsAndValidateInventory\(\{\s*orderClient: admin,/)
})
