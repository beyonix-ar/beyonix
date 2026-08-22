import { supabase } from "@/lib/supabase/client"
import type { SupabaseAuditLog } from "@/lib/supabase/types"

// Resuelve IDs internos (producto_id, variant_id, categoria_id, user_id) a
// nombres humanos para la vista de Auditoría. Los eventos guardan una foto
// congelada de la fila afectada en before_data/after_data, pero cuando esa
// fila no tiene un campo "nombre" propio (una imagen, una compra de stock,
// una asignación de inventario) sólo queda el ID de la entidad relacionada.
// Este módulo hace un puñado de consultas agrupadas (una por tabla, nunca
// una por evento) para poder mostrar "Auriculares Bluetooth" en vez de
// "Producto #90".

export interface AuditEntityMaps {
  products: Map<string, string>
  variants: Map<string, { nombre: string; productoId: string | null; codigoBarra: string | null }>
  categories: Map<string, string>
  users: Map<string, string>
  // false mientras la primera consulta no terminó: un ID ausente del mapa
  // todavía puede existir y no haberse cargado. Sólo cuando ready es true
  // un ID ausente significa "se buscó y no existe" (registro eliminado).
  ready: boolean
}

export const emptyAuditEntityMaps: AuditEntityMaps = {
  products: new Map(),
  variants: new Map(),
  categories: new Map(),
  users: new Map(),
  ready: false,
}

const productIdFields = ["producto_id", "product_id"]
const variantIdFields = ["variant_id", "variante_id"]
const categoryIdFields = ["categoria_id", "category_id"]
const userIdFields = ["created_by", "target_user_id", "updated_by"]

function collectIds(logs: SupabaseAuditLog[], fields: string[]) {
  const ids = new Set<string>()

  for (const log of logs) {
    for (const data of [log.before_data, log.after_data]) {
      if (!data) continue
      for (const field of fields) {
        const value = data[field]
        if (value === null || value === undefined || value === "") continue
        ids.add(String(value))
      }
    }
  }

  return Array.from(ids)
}

export async function fetchAuditEntityMaps(logs: SupabaseAuditLog[]): Promise<AuditEntityMaps> {
  const productIds = collectIds(logs, productIdFields)
  const variantIds = collectIds(logs, variantIdFields)
  const categoryIds = collectIds(logs, categoryIdFields)
  const userIds = collectIds(logs, userIdFields)

  const [products, variants, categories, users] = await Promise.all([
    fetchMap("productos", productIds, "id, nombre", (row) => [
      String(row.id),
      String(row.nombre ?? ""),
    ]),
    fetchVariantMap(variantIds),
    fetchMap("categorias", categoryIds, "id, nombre", (row) => [
      String(row.id),
      String(row.nombre ?? ""),
    ]),
    fetchMap("profiles", userIds, "id, nombre, email", (row) => [
      String(row.id),
      String(row.nombre ?? row.email ?? ""),
    ]),
  ])

  return { products, variants, categories, users, ready: true }
}

async function fetchMap(
  table: string,
  ids: string[],
  columns: string,
  toEntry: (row: Record<string, unknown>) => [string, string],
) {
  const map = new Map<string, string>()
  if (ids.length === 0) return map

  try {
    const { data, error } = await supabase.from(table).select(columns).in("id", ids)
    if (error || !data) return map

    for (const row of data as unknown as Record<string, unknown>[]) {
      const [id, name] = toEntry(row)
      if (name) map.set(id, name)
    }
  } catch {
    // La resolución de nombres es un complemento visual: si falla, la
    // auditoría sigue funcionando con el identificador como respaldo.
  }

  return map
}

async function fetchVariantMap(ids: string[]) {
  const map = new Map<string, { nombre: string; productoId: string | null; codigoBarra: string | null }>()
  if (ids.length === 0) return map

  try {
    const { data, error } = await supabase
      .from("producto_variantes")
      .select("id, nombre, producto_id, codigo_barra")
      .in("id", ids)
    if (error || !data) return map

    for (const row of data as unknown as Record<string, unknown>[]) {
      map.set(String(row.id), {
        nombre: String(row.nombre ?? ""),
        productoId: row.producto_id ? String(row.producto_id) : null,
        codigoBarra: typeof row.codigo_barra === "string" && row.codigo_barra.trim() ? row.codigo_barra.trim() : null,
      })
    }
  } catch {
    // Igual que fetchMap: fallback silencioso a los IDs crudos.
  }

  return map
}

export function resolveProductName(maps: AuditEntityMaps, id: unknown): string | null {
  if (id === null || id === undefined || id === "") return null
  return maps.products.get(String(id)) || null
}

export function resolveVariantName(maps: AuditEntityMaps, id: unknown): string | null {
  if (id === null || id === undefined || id === "") return null
  return maps.variants.get(String(id))?.nombre || null
}

// Código de barras VIGENTE de la variante (no es un campo que la compra
// guarde en su propio snapshot). Para compras históricas es la mejor
// información disponible; en la práctica el código de barras de un
// producto prácticamente no cambia una vez cargado.
export function resolveVariantBarcode(maps: AuditEntityMaps, id: unknown): string | null {
  if (id === null || id === undefined || id === "") return null
  return maps.variants.get(String(id))?.codigoBarra ?? null
}

export function resolveCategoryName(maps: AuditEntityMaps, id: unknown): string | null {
  if (id === null || id === undefined || id === "") return null
  return maps.categories.get(String(id)) || null
}

export function resolveUserName(maps: AuditEntityMaps, id: unknown): string | null {
  if (id === null || id === undefined || id === "") return null
  return maps.users.get(String(id)) || null
}
