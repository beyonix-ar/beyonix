import { requireInternalUser } from "@/lib/auth/admin-api"
import { describeMercadoLibreImportError, isMissingImportMigration } from "@/lib/mercadolibre/import-validation"
import {
  buildProductChannelMappingInsert,
  isSameMappingTarget,
  type MappingCatalogProduct,
} from "@/lib/mercadolibre/product-mapping-request"

const ROLES = ["admin", "super_admin"] as const
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAPPING_FIELDS = "id, mapping_type, match_key, external_sku, listing_id, variant_label, product_id, variant_id, origin, created_at"

function failure(message: string, fallback: string) {
  console.error("ML_PRODUCT_MAPPING_ERROR", message)
  return Response.json(
    { error: describeMercadoLibreImportError(message, fallback) },
    { status: isMissingImportMigration(message) ? 503 : 500 },
  )
}

/**
 * Guarda un vínculo explícito (alias de SKU histórico o publicación +
 * variante) para que futuras importaciones lo resuelvan sin volver a
 * preguntarlo. Nunca reemplaza en silencio un vínculo activo distinto.
 */
export async function POST(request: Request) {
  const auth = await requireInternalUser(request, [...ROLES])
  if ("error" in auth) return auth.error

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null

  const { data: catalog, error: catalogError } = await auth.admin
    .from("productos")
    .select("id, sku, producto_variantes(id, sku)")
  if (catalogError) return failure(catalogError.message, "No se pudo leer el catálogo.")

  const validated = buildProductChannelMappingInsert(body, (catalog ?? []) as unknown as MappingCatalogProduct[])
  if (!validated.ok) return Response.json({ error: validated.error }, { status: validated.status })
  const { insert } = validated

  // El vínculo manual no tiene vigencia (aplica a cualquier fecha): choca con
  // cualquier vínculo activo de la misma clave, salvo que sea idéntico.
  const { data: existing, error: existingError } = await auth.admin
    .from("product_channel_mappings")
    .select(`${MAPPING_FIELDS}, valid_from, valid_to`)
    .eq("channel", insert.channel)
    .eq("mapping_type", insert.mapping_type)
    .eq("match_key", insert.match_key)
    .eq("active", true)
  if (existingError) return failure(existingError.message, "No se pudieron consultar los vínculos guardados.")
  const [current, ...others] = existing ?? []
  if (current) {
    if (!others.length && current.valid_from == null && current.valid_to == null && isSameMappingTarget(current, insert)) {
      return Response.json({ mapping: current, created: false })
    }
    return Response.json(
      { error: "Ya existe un vínculo activo para esa clave. Quitalo antes de crear uno nuevo." },
      { status: 409 },
    )
  }

  const { data: created, error: insertError } = await auth.admin
    .from("product_channel_mappings")
    .insert({ ...insert, created_by: auth.user.id })
    .select(MAPPING_FIELDS)
    .single()
  if (insertError) {
    if (/PRODUCT_MAPPING_OVERLAP/.test(insertError.message)) {
      return Response.json({ error: "Otro administrador acaba de vincular esa clave. Volvé a analizar el archivo." }, { status: 409 })
    }
    if (/PRODUCT_MAPPING_VARIANT/.test(insertError.message)) {
      return Response.json({ error: "Elegí la variante exacta del producto." }, { status: 400 })
    }
    return failure(insertError.message, "No se pudo guardar el vínculo.")
  }

  return Response.json({ mapping: created, created: true }, { status: 201 })
}

/** Desactiva un vínculo (queda en el historial y en la auditoría; no se borra). */
export async function DELETE(request: Request) {
  const auth = await requireInternalUser(request, [...ROLES])
  if ("error" in auth) return auth.error

  const id = new URL(request.url).searchParams.get("id") ?? ""
  if (!UUID_PATTERN.test(id)) return Response.json({ error: "El vínculo indicado no es válido." }, { status: 400 })

  const { data, error } = await auth.admin
    .from("product_channel_mappings")
    .update({ active: false, deactivated_at: new Date().toISOString(), deactivated_by: auth.user.id })
    .eq("id", id)
    .eq("active", true)
    .select("id")
    .maybeSingle()
  if (error) return failure(error.message, "No se pudo quitar el vínculo.")
  if (!data) return Response.json({ error: "El vínculo ya no estaba activo." }, { status: 409 })

  return Response.json({ success: true })
}
