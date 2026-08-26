import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

// 20260817100000 crea las RPC y los cambios de esquema (constraints/nullability).
// 20260817110000 corrige audit_logs.action, 20260817120000 agrega el
// desacople de mercadolibre_sales y desactiva los recálculos automáticos
// intermedios, 20260817130000 desactiva además el trigger que re-vincula
// product_cost_entries al catálogo de costos, y 20260817140000 corrige el
// snapshot de article_name/sku (usaba el nombre de la variante -el color- en
// vez del nombre del producto) y agrega force_delete_purchase_super_admin.
// Cada una reemplaza las funciones con create or replace: 20260817140000 es
// la definición vigente. Los tests de comportamiento de las RPC corren
// contra ese archivo; los de esquema (que no se repiten ahí) contra el
// original.
const migration = readFileSync(
  new URL(
    "../../supabase/migrations/20260817100000_super_admin_force_delete.sql",
    import.meta.url,
  ),
  "utf8",
)
const fix = readFileSync(
  new URL(
    "../../supabase/migrations/20260817140000_fix_force_delete_article_name_and_purchase_delete.sql",
    import.meta.url,
  ),
  "utf8",
)
const latestProductFix = readFileSync(
  new URL(
    "../../supabase/migrations/20260820200000_force_delete_disables_catalog_relink_trigger.sql",
    import.meta.url,
  ),
  "utf8",
)
const purchaseDefinition = fix.slice(
  fix.indexOf(
    "create or replace function public.force_delete_purchase_super_admin(",
  ),
)

function countOccurrences(source: string, pattern: RegExp) {
  return (source.match(pattern) ?? []).length
}

test("no elimina ni recrea estructura de tablas/índices", () => {
  for (const source of [migration, fix]) {
    assert.doesNotMatch(source, /drop table/i)
    assert.doesNotMatch(source, /drop index/i)
    assert.doesNotMatch(source, /drop policy/i)
  }
})

test("define las tres RPC de eliminación forzada como security definer", () => {
  assert.match(
    latestProductFix,
    /create or replace function public\.force_delete_product_super_admin\(/,
  )
  assert.match(
    latestProductFix,
    /create or replace function public\.force_delete_product_variant_super_admin\(/,
  )
  assert.match(
    fix,
    /create or replace function public\.force_delete_purchase_super_admin\(/,
  )
  assert.equal(
    countOccurrences(latestProductFix, /language plpgsql\r?\nsecurity definer/g),
    2,
  )
  assert.equal(
    countOccurrences(purchaseDefinition, /language plpgsql\r?\nsecurity definer/g),
    1,
  )
})

test("force_delete_product(_variant)_super_admin sólo son ejecutables por service_role", () => {
  assert.equal(
    countOccurrences(
      fix,
      /revoke all on function public\.force_delete_product(_variant)?_super_admin\(bigint, uuid\)\s*\n\s*from public, anon, authenticated;/g,
    ),
    2,
  )
  assert.equal(
    countOccurrences(
      fix,
      /grant execute on function public\.force_delete_product(_variant)?_super_admin\(bigint, uuid\)\s*\n\s*to service_role;/g,
    ),
    2,
  )
})

test("las tres RPC verifican server-side que el actor sea super_admin", () => {
  assert.equal(countOccurrences(fix, /auth\.role\(\) <> 'service_role'/g), 3)
  assert.equal(
    countOccurrences(
      fix,
      /select rol into v_actor_role\s*\n\s*from public\.profiles\s*\n\s*where id = p_actor_id;/g,
    ),
    3,
  )
  assert.equal(
    countOccurrences(fix, /v_actor_role is distinct from 'super_admin'/g),
    3,
  )
})

test("preserva el historial comercial desacoplando en vez de borrar", () => {
  assert.match(
    fix,
    /update public\.product_cost_entries entries[\s\S]*?product_id = null,\s*\n\s*variant_id = null/,
  )
  assert.match(
    fix,
    /update public\.business_expenses expenses[\s\S]*?product_id = null,\s*\n\s*variant_id = null/,
  )
  assert.match(
    fix,
    /update public\.external_sales sales\s*\n\s*set product_id = null,\s*\n\s*variant_id = null/,
  )
  assert.match(
    fix,
    /update public\.inventory_return_movements movements\s*\n\s*set product_id = null,\s*\n\s*variant_id = null/,
  )
  // force_delete_product(_variant)_super_admin nunca borran product_cost_entries
  // (sólo lo desacoplan); la única fila que se borra ahí es la que elige
  // explícitamente SUPER_ADMIN vía force_delete_purchase_super_admin, por id.
  assert.doesNotMatch(
    fix,
    /delete from public\.product_cost_entries\s*\n\s*where entries\./,
  )
  assert.match(
    fix,
    /delete from public\.product_cost_entries\s*\n\s*where id = p_purchase_id;/,
  )
  assert.doesNotMatch(fix, /delete from public\.business_expenses/)
  assert.doesNotMatch(fix, /delete from public\.external_sales/)
  assert.doesNotMatch(fix, /delete from public\.inventory_return_movements/)
})

test("conserva un nombre legible cuando el artículo/gasto queda desvinculado", () => {
  assert.match(fix, /article_name = coalesce\(/)
  assert.match(fix, /product_name = coalesce\(/)
})

test("el snapshot de la compra usa el nombre del PRODUCTO como base, nunca sólo el color de la variante", () => {
  // Causa de las compras "Negro": el snapshot usaba variants.nombre (que
  // desde la corrección del modelo de variantes SIEMPRE es sólo el color)
  // como article_name completo. Ahora v_product_name es la base y el color
  // -si la fila tenía variante- se agrega entre paréntesis como calificador,
  // nunca reemplaza el nombre del producto.
  assert.equal(countOccurrences(fix, /coalesce\(v_product_name, 'Producto eliminado'\)/g), 2)
  assert.match(fix, /select ' \(' \|\| variants\.nombre \|\| '\)'/)
  assert.match(fix, /then coalesce\(v_product_name, 'Producto eliminado'\) \|\| ' \(' \|\| v_variant_name \|\| '\)'/)
  // El patrón viejo (variant name como único fallback de article_name, sin
  // pasar por v_product_name) no puede reaparecer.
  assert.doesNotMatch(
    fix,
    /nullif\(btrim\(entries\.article_name\), ''\),\s*\n\s*v_variant_name\s*\n\s*\)/,
  )
})

test("guarda también el SKU de la variante/producto como snapshot de la compra", () => {
  // Antes no se tocaba entries.sku en absoluto al desacoplar.
  assert.match(
    fix,
    /sku = coalesce\(nullif\(btrim\(entries\.sku\), ''\), v_variant_sku\)/,
  )
  assert.match(
    fix,
    /sku = coalesce\(\s*\n\s*nullif\(btrim\(entries\.sku\), ''\),\s*\n\s*\(\s*\n\s*select variants\.sku/,
  )
})

test("marca discretamente en notas que el producto de origen fue eliminado, sin tocar el nombre", () => {
  assert.equal(countOccurrences(fix, /\[Producto eliminado\]/g), 2)
})

test("force_delete_purchase_super_admin permite a SUPER_ADMIN eliminar una compra salteando la protección de stock consumido", () => {
  assert.match(
    fix,
    /create or replace function public\.force_delete_purchase_super_admin\(/,
  )
  assert.match(fix, /auth\.role\(\) <> 'service_role'/)
  assert.match(fix, /v_actor_role is distinct from 'super_admin'/)
  // No debe duplicar ni imitar la validación STOCK_INSUFICIENTE de
  // delete_product_purchase_atomic: esa RPC sigue intacta para el resto de
  // roles, ésta es la única vía para saltearla, exclusiva de SUPER_ADMIN.
  // (el string aparece únicamente en el comentario explicativo, no en un
  // raise exception dentro de la función).
  assert.doesNotMatch(fix, /raise exception[\s\S]{0,40}STOCK_INSUFICIENTE/)
  assert.match(
    fix,
    /revoke all on function public\.force_delete_purchase_super_admin\(uuid, uuid\)\s*\n\s*from public, anon, authenticated;/,
  )
  assert.match(
    fix,
    /grant execute on function public\.force_delete_purchase_super_admin\(uuid, uuid\)\s*\n\s*to service_role;/,
  )
})

test("desacopla también mercadolibre_sales (causa raíz del bloqueo por stock negativo)", () => {
  // El producto force-eliminado: mercadolibre_sales.product_id pasa a null
  // (la venta y sus campos propios -product_name/sku/net_amount- se
  // conservan). No hay columna variant_id propia: el mapeo vive en
  // raw_data.beyonix_cost_mapping.variant_id.
  assert.match(
    fix,
    /update public\.mercadolibre_sales sales\s*\n\s*set product_id = null\s*\n\s*where sales\.product_id = p_product_id;/,
  )
  // La variante force-eliminada: se conserva el product_id (el producto
  // sigue existiendo) y sólo se limpia el puntero a la variante dentro del
  // jsonb.
  assert.match(
    fix,
    /set raw_data = sales\.raw_data #- '\{beyonix_cost_mapping,variant_id\}'\s*\n\s*where sales\.product_id = v_product_id\s*\n\s*and public\.inventory_ml_variant_id\(sales\.raw_data\) = p_variant_id;/,
  )
  assert.doesNotMatch(fix, /delete from public\.mercadolibre_sales/)
})

test("desactiva el trigger que re-vincula compras sueltas al catálogo de costos mientras desacopla", () => {
  // link_cost_entry_to_shared_catalog dispara cuando product_id queda null
  // Y article_name queda no-nulo en la misma fila: exactamente lo que hace
  // el desacople de product_cost_entries. Sin desactivarlo, la compra se
  // re-vincula sola a un producto nuevo (o existente) y el producto
  // "eliminado" reaparece como stub.
  assert.equal(
    countOccurrences(fix, /disable trigger link_cost_entry_to_shared_catalog;/g),
    2,
  )
  assert.equal(
    countOccurrences(fix, /enable trigger link_cost_entry_to_shared_catalog;/g),
    2,
  )
})

test("responde con un mensaje propio del force-delete si igual queda un estado inesperado", () => {
  // El mensaje del guardia normal ("Reasigná primero el stock") no aplica a
  // un SUPER_ADMIN que ya pidió forzar la eliminación; si de todos modos
  // algo bloquea el DELETE final, se debe reemplazar por un mensaje que no
  // dé una instrucción que no corresponde a este flujo.
  assert.equal(
    countOccurrences(
      fix,
      /exception\s*\n\s*when others then\s*\n\s*raise exception\s*\n\s*'No se pudo completar la eliminación forzada/g,
    ),
    2,
  )
  assert.doesNotMatch(fix, /raise exception\s*\n\s*'Reasigná/)
})

test("sólo purga inventory_operation_log, que no es la fuente de verdad", () => {
  assert.equal(
    countOccurrences(fix, /delete from public\.inventory_operation_log/g),
    2,
  )
})

test("cada disable trigger tiene su enable trigger correspondiente en la misma transacción", () => {
  const disableMatches = [
    ...fix.matchAll(/alter table public\.(\S+) disable trigger (\w+);/g),
  ]
  const enableMatches = [
    ...fix.matchAll(/alter table public\.(\S+) enable trigger (\w+);/g),
  ]
  assert.ok(disableMatches.length > 0)
  const disableKeys = disableMatches
    .map((match) => `${match[1]}:${match[2]}`)
    .sort()
  const enableKeys = enableMatches.map((match) => `${match[1]}:${match[2]}`).sort()
  assert.deepEqual(disableKeys, enableKeys)
})

test("recalcula el stock derivado antes de borrar variantes/producto (evita el guardia de integridad)", () => {
  assert.match(
    fix,
    /perform public\.refresh_inventory_stock\(v_product_id\);[\s\S]*delete from public\.producto_variantes\s*\n\s*where id = p_variant_id;/,
  )
  assert.match(
    fix,
    /perform public\.refresh_inventory_stock\(p_product_id\);[\s\S]*delete from public\.producto_variantes\s*\n\s*where producto_id = p_product_id;[\s\S]*delete from public\.productos\s*\n\s*where id = p_product_id;/,
  )
})

test("audita la eliminación forzada en audit_logs con una acción válida para audit_logs_action_check", () => {
  // audit_logs.action sólo admite 'INSERT' | 'UPDATE' | 'DELETE'
  // (supabase/sql/020_roles_and_permissions.sql). 'FORCE_DELETE' viola ese
  // constraint y aborta la transacción completa: no puede reaparecer.
  assert.doesNotMatch(latestProductFix, /\r?\n\s*'FORCE_DELETE',\r?\n/)
  assert.doesNotMatch(purchaseDefinition, /\r?\n\s*'FORCE_DELETE',\r?\n/)
  assert.equal(countOccurrences(latestProductFix, /\r?\n\s*'DELETE',\r?\n/g), 2)
  assert.equal(countOccurrences(purchaseDefinition, /\r?\n\s*'DELETE',\r?\n/g), 1)
  assert.match(latestProductFix, /p_actor_id,\s*\n\s*jsonb_build_object\('nombre', v_variant_name/)
  assert.match(latestProductFix, /p_actor_id,\s*\n\s*jsonb_build_object\('nombre', v_product_name\)/)
  assert.equal(
    countOccurrences(latestProductFix, /jsonb_build_object\('reason', 'super_admin_force_delete'\)/g),
    2,
  )
})

test("relaja sólo las restricciones necesarias para permitir el desacople histórico", () => {
  assert.match(
    migration,
    /alter table public\.inventory_return_movements\s*\n\s*alter column product_id drop not null;/,
  )
  assert.match(
    migration,
    /business_expenses_product_fields_check[\s\S]*expense_type = 'product'\s*\n\s*and product_name is not null/,
  )
  assert.doesNotMatch(
    migration,
    /expense_type = 'product'\s*\n\s*and product_id is not null/,
  )
})
