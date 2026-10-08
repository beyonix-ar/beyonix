import { requireInternalUser } from "@/lib/auth/admin-api"
import {
  normalizeProductDescriptionInput,
  RichDescriptionInputError,
} from "@/lib/products/rich-description"
import { createRequestUserClient } from "@/lib/supabase/request-client"

// Alta de producto. Antes el navegador llamaba create_producto_completo_v2
// directo y la descripción enriquecida no se volvía a sanear server-side.
// La RPC se sigue ejecutando con la sesión del Admin (valida auth.uid() y
// deja la auditoría con su email); esta ruta sólo es el paso obligado que
// sanea la descripción y acota la entrada.
const MAX_BODY_BYTES = 1_000_000
const MAX_VARIANTS = 100
const MAX_IMAGES = 50
const MAX_SPECIFICATIONS = 100

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const isRecordList = (value: unknown, max: number): value is Record<string, unknown>[] =>
  Array.isArray(value) && value.length <= max && value.every(isRecord)

export async function POST(request: Request) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error

  const declaredLength = Number(request.headers.get("content-length") ?? "0")
  if (declaredLength > MAX_BODY_BYTES) {
    return Response.json({ error: "Los datos del producto son demasiado grandes." }, { status: 413 })
  }
  const raw = await request.text().catch(() => "")
  if (raw.length > MAX_BODY_BYTES) {
    return Response.json({ error: "Los datos del producto son demasiado grandes." }, { status: 413 })
  }
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    body = null
  }

  if (!isRecord(body) || !isRecord(body.producto)) {
    return Response.json({ error: "Los datos del producto no son válidos." }, { status: 400 })
  }
  const imagenes = body.imagenes ?? []
  const variantes = body.variantes ?? []
  const especificaciones = body.especificaciones ?? []
  if (
    !isRecordList(imagenes, MAX_IMAGES) ||
    !isRecordList(variantes, MAX_VARIANTS) ||
    !isRecordList(especificaciones, MAX_SPECIFICATIONS)
  ) {
    return Response.json({ error: "Los datos del producto no son válidos." }, { status: 400 })
  }

  const producto = { ...body.producto }
  try {
    producto.descripcion = normalizeProductDescriptionInput(producto.descripcion)
  } catch (error) {
    return Response.json(
      { error: error instanceof RichDescriptionInputError ? error.message : "La descripción no es válida." },
      { status: 400 },
    )
  }
  // El stock nunca se carga en el alta: se deriva del libro de inventario.
  delete producto.stock

  const userClient = createRequestUserClient(request)
  const { data, error } = await userClient.rpc("create_producto_completo_v2", {
    p_producto: producto,
    p_imagenes: imagenes,
    p_variantes: variantes,
    p_especificaciones: especificaciones,
  })

  if (error) {
    if (/create_producto_completo_v2|schema cache|PGRST202/i.test(error.message)) {
      return Response.json(
        { error: "Falta aplicar la migración 20260730170000_inventory_integrity_and_variant_sales.sql." },
        { status: 503 },
      )
    }
    if (/PRODUCT_DESCRIPTION_UNSAFE/.test(error.message)) {
      return Response.json({ error: "La descripción no es válida." }, { status: 400 })
    }
    // Mensajes propios de la RPC (raise exception en español) y violaciones
    // de unicidad/rango que el formulario ya traduce por código.
    if (error.code === "P0001" || error.code === "23505" || error.code === "23514") {
      return Response.json({ error: error.message, code: error.code }, { status: 409 })
    }
    console.warn("ADMIN_PRODUCT_CREATE_FAILED", { code: error.code ?? null })
    return Response.json({ error: "No se pudo crear el producto." }, { status: 500 })
  }

  return Response.json({ product: data }, { status: 201 })
}
