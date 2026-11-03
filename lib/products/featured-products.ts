/**
 * Productos destacados con orden manual: `productos.destacado` dice si el
 * producto está destacado y `productos.featured_position` (1, 2, 3…) su lugar
 * en Home. La unicidad de la posición la garantiza la base (índice único
 * parcial + `set_product_featured_position`); este módulo sólo comparte el
 * orden, la validación de entrada y los mensajes entre Home, Admin y la API.
 */

/** Tope de posición que ofrece Admin (la base sólo exige > 0). */
export const FEATURED_POSITION_MAX = 99

export interface ProductFeaturedState {
  destacado: boolean
  /** `null` = destacado sin posición (va después de los posicionados). */
  featuredPosition: number | null
}

export interface ProductFeaturedUpdate extends ProductFeaturedState {
  /** Revisión de la ficha que cargó el editor; ausente desde el listado. */
  expectedRevision: number | null
}

interface OrderableQuery<Query> {
  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }): Query
}

/**
 * Orden de los destacados en Home: posición manual (sin posición al final),
 * después los más nuevos y, como desempate estable, el id más alto. Nunca el
 * nombre. `withPosition = false` es el orden previo a la migración.
 */
export function orderFeaturedProducts<Query extends OrderableQuery<Query>>(
  query: Query,
  withPosition = true,
): Query {
  const positioned = withPosition
    ? query.order("featured_position", { ascending: true, nullsFirst: false })
    : query
  return positioned
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
}

interface FeaturedSortable {
  id: number
  created_at: string
  featured_position?: number | null
}

/** Mismo orden que `orderFeaturedProducts`, para datos ya cargados. */
export function compareFeaturedProducts(left: FeaturedSortable, right: FeaturedSortable) {
  const leftPosition = left.featured_position ?? null
  const rightPosition = right.featured_position ?? null
  if (leftPosition !== rightPosition) {
    if (leftPosition == null) return 1
    if (rightPosition == null) return -1
    return leftPosition - rightPosition
  }
  const byDate = Date.parse(right.created_at) - Date.parse(left.created_at)
  if (byDate) return byDate
  return right.id - left.id
}

/** La columna todavía no existe (código desplegado antes que la migración). */
export function isMissingFeaturedPositionError(error: { code?: string; message?: string } | null) {
  if (!error) return false
  return /featured_position/i.test(error.message ?? "") &&
    (error.code === "42703" || /does not exist|could not find|schema cache/i.test(error.message ?? ""))
}

/**
 * Consulta de destacados con el orden manual; si la migración todavía no se
 * aplicó, se repite con el orden anterior en vez de dejar Home sin productos.
 */
export async function queryFeaturedProducts<Row>(
  run: (withPosition: boolean) => PromiseLike<{
    data: Row[] | null
    error: { code?: string; message?: string } | null
  }>,
) {
  const result = await run(true)
  return isMissingFeaturedPositionError(result.error) ? run(false) : result
}

export function getFeaturedState(product: {
  destacado?: boolean | null
  featured_position?: number | null
}): ProductFeaturedState {
  const destacado = product.destacado === true
  return {
    destacado,
    featuredPosition: destacado ? (product.featured_position ?? null) : null,
  }
}

export function isValidFeaturedPosition(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= FEATURED_POSITION_MAX
  )
}

export class FeaturedUpdateInputError extends Error {}

/**
 * Valida el pedido del Admin. Quitar el destacado siempre limpia la posición
 * (no se acepta una posición sin destacado); destacar sin posición es válido.
 */
export function parseFeaturedUpdateInput(body: unknown): ProductFeaturedUpdate {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new FeaturedUpdateInputError("Los datos del destacado no son válidos.")
  }
  const input = body as Record<string, unknown>
  if (typeof input.destacado !== "boolean") {
    throw new FeaturedUpdateInputError("Indicá si el producto queda destacado.")
  }
  const rawPosition = input.featuredPosition ?? null
  if (rawPosition !== null && !isValidFeaturedPosition(rawPosition)) {
    throw new FeaturedUpdateInputError(
      `La posición debe ser un número entero entre 1 y ${FEATURED_POSITION_MAX}.`,
    )
  }
  if (!input.destacado && rawPosition !== null) {
    throw new FeaturedUpdateInputError("Un producto sin destacar no puede tener posición.")
  }
  const rawRevision = input.expectedRevision ?? null
  if (
    rawRevision !== null &&
    !(typeof rawRevision === "number" && Number.isSafeInteger(rawRevision) && rawRevision >= 0)
  ) {
    throw new FeaturedUpdateInputError("La revisión del producto no es válida.")
  }
  return {
    destacado: input.destacado,
    featuredPosition: input.destacado ? (rawPosition as number | null) : null,
    expectedRevision: rawRevision as number | null,
  }
}

export const FEATURED_MIGRATION_FILE = "20261102120000_product_featured_position.sql"

/** Error de `set_product_featured_position` → respuesta para Admin (sin detalles técnicos). */
export function mapFeaturedRpcError(error: { code?: string; message?: string }) {
  const message = error.message ?? ""
  if (/set_product_featured_position|PGRST202|42883/i.test(`${error.code ?? ""} ${message}`) ||
      isMissingFeaturedPositionError(error)) {
    return { status: 503, error: `Falta aplicar la migración ${FEATURED_MIGRATION_FILE}.` }
  }
  if (error.code === "23505") {
    return { status: 409, error: message || "Esa posición ya está ocupada por otro producto destacado.", code: "featured_position_taken" }
  }
  if (error.code === "40001") {
    return { status: 409, error: message, code: "product_revision_conflict" }
  }
  if (error.code === "P0002") return { status: 404, error: "El producto ya no existe." }
  if (error.code === "22023") return { status: 400, error: message || "Los datos del destacado no son válidos." }
  return { status: 500, error: "No se pudo actualizar el destacado del producto." }
}
