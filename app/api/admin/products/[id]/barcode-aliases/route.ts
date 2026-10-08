import { requireInternalUser } from "@/lib/auth/admin-api"
import { isPrintableBarcode, isReservedProductBarcode } from "@/lib/barcodes/codes"
import {
  BARCODE_ALIAS_CONFLICT_MESSAGE,
  type BarcodeAlias,
} from "@/lib/barcodes/barcode-aliases"

const MISSING_MIGRATION = "Falta aplicar la migración 20261008120000_catalog_random_dual_color_barcode_aliases.sql."

function parseProductId(value: string) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function isMissingTable(message: string) {
  return /catalog_barcode_aliases|schema cache|PGRST205/i.test(message)
}

type AliasRow = {
  barcode: string
  variant_id: number | string | null
  created_at: string
  producto_variantes: { nombre: string | null } | null
}

function toAlias(row: AliasRow): BarcodeAlias {
  return {
    barcode: row.barcode,
    variantId: row.variant_id == null ? null : Number(row.variant_id),
    variantName: row.producto_variantes?.nombre ?? null,
    createdAt: row.created_at,
  }
}

const ALIAS_SELECT = "barcode, variant_id, created_at, producto_variantes(nombre)"

// Códigos de barra equivalentes de un producto: con variante identifican esa
// variante física; sin variante, al grupo (mismo EAN para todos los colores).
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error

  const productId = parseProductId((await context.params).id)
  if (!productId) return Response.json({ error: "El producto indicado no es válido." }, { status: 400 })

  const { data, error } = await auth.admin
    .from("catalog_barcode_aliases")
    .select(ALIAS_SELECT)
    .eq("product_id", productId)
    .order("created_at", { ascending: true })
    .returns<AliasRow[]>()

  if (error) {
    return Response.json(
      { error: isMissingTable(error.message) ? MISSING_MIGRATION : "No se pudieron cargar los códigos equivalentes." },
      { status: isMissingTable(error.message) ? 503 : 500 },
    )
  }
  return Response.json({ aliases: (data ?? []).map(toAlias) })
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error

  const productId = parseProductId((await context.params).id)
  const body = (await request.json().catch(() => null)) as { barcode?: unknown; variantId?: unknown } | null
  const barcode = typeof body?.barcode === "string" ? body.barcode.trim() : ""
  const variantId = body?.variantId == null ? null : Number(body.variantId)

  if (!productId || (variantId != null && (!Number.isInteger(variantId) || variantId <= 0))) {
    return Response.json({ error: "Los datos del código equivalente no son válidos." }, { status: 400 })
  }
  if (!barcode || barcode.length > 64 || !isPrintableBarcode(barcode)) {
    return Response.json(
      { error: "Ingresá un código de barra válido (hasta 64 caracteres, sin acentos ni símbolos especiales)." },
      { status: 400 },
    )
  }
  if (isReservedProductBarcode(barcode)) {
    return Response.json(
      { error: "Ese formato está reservado para bultos y lotes de envío." },
      { status: 400 },
    )
  }

  const { data, error } = await auth.admin
    .from("catalog_barcode_aliases")
    .insert({
      normalized_barcode: barcode,
      barcode,
      product_id: productId,
      variant_id: variantId,
      created_by: auth.user.id,
    })
    .select(ALIAS_SELECT)
    .single<AliasRow>()

  if (error) {
    if (error.code === "23505" || /CATALOG_BARCODE_DUPLICATE/.test(error.message)) {
      return Response.json({ error: BARCODE_ALIAS_CONFLICT_MESSAGE }, { status: 409 })
    }
    if (/CATALOG_ALIAS_VARIANT_MISMATCH/.test(error.message) || error.code === "23503") {
      return Response.json({ error: "La variante elegida no pertenece a este producto." }, { status: 400 })
    }
    return Response.json(
      { error: isMissingTable(error.message) ? MISSING_MIGRATION : "No se pudo guardar el código equivalente." },
      { status: isMissingTable(error.message) ? 503 : 500 },
    )
  }
  return Response.json({ alias: toAlias(data) }, { status: 201 })
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error

  const productId = parseProductId((await context.params).id)
  const barcode = new URL(request.url).searchParams.get("barcode")?.trim() ?? ""
  if (!productId || !barcode) {
    return Response.json({ error: "El código equivalente indicado no es válido." }, { status: 400 })
  }

  const { data, error } = await auth.admin
    .from("catalog_barcode_aliases")
    .delete()
    .eq("product_id", productId)
    .eq("normalized_barcode", barcode)
    .select("barcode")

  if (error) {
    return Response.json(
      { error: isMissingTable(error.message) ? MISSING_MIGRATION : "No se pudo quitar el código equivalente." },
      { status: isMissingTable(error.message) ? 503 : 500 },
    )
  }
  if (!data?.length) {
    return Response.json({ error: "El código equivalente ya no existe." }, { status: 404 })
  }
  return Response.json({ removed: barcode })
}
