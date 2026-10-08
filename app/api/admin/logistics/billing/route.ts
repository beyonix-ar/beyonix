import { requireInternalUser } from "@/lib/auth/admin-api"
import {
  BillingCsvError,
  billingEntriesFromCsv,
  billingErrorMessage,
  isBillingMovementType,
  loadOrderBillingEntries,
  loadUnmatchedBillingEntries,
  MAX_BILLING_CSV_BYTES,
  parseBillingAmount,
  parseBillingCsv,
  parseBillingDate,
  recordBillingEntries,
  updateBillingEntry,
  type BillingColumnMapping,
  type BillingEntryInput,
  type BillingField,
} from "@/lib/admin/andreani-billing"
import { LogisticsRangeError, parseLogisticsRange } from "@/lib/admin/logistics"

// Facturación real de Andreani: dato financiero, sólo Admin/Super Admin.
const ROLES = ["admin", "super_admin"] as const
// El CSV viaja como texto dentro del JSON: tope del archivo + margen.
const MAX_BODY_BYTES = MAX_BILLING_CSV_BYTES + 64_000
const NO_STORE = { "Cache-Control": "no-store" }

const positiveId = (value: unknown) => {
  const id = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null
}

async function readJson(request: Request): Promise<Record<string, unknown> | null | "too_large"> {
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return "too_large"
  const raw = await request.text().catch(() => "")
  if (raw.length > MAX_BODY_BYTES) return "too_large"
  try {
    const body: unknown = JSON.parse(raw)
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const tooLarge = () => Response.json({ error: "El archivo supera 1 MB." }, { status: 413 })
const invalid = (error = "Datos inválidos.") => Response.json({ error }, { status: 400 })

export async function GET(request: Request) {
  const auth = await requireInternalUser(request, [...ROLES])
  if ("error" in auth) return auth.error
  const params = new URL(request.url).searchParams
  try {
    const orderId = params.get("orderId")
    if (orderId !== null) {
      const id = positiveId(orderId)
      if (!id) return invalid("Pedido inválido.")
      return Response.json({ entries: await loadOrderBillingEntries(auth.admin, id) }, { headers: NO_STORE })
    }
    let range: ReturnType<typeof parseLogisticsRange>
    try {
      range = parseLogisticsRange(params.get("from"), params.get("to"))
    } catch (error) {
      return invalid(error instanceof LogisticsRangeError ? error.message : "Fechas inválidas.")
    }
    return Response.json({ entries: await loadUnmatchedBillingEntries(auth.admin, range) }, { headers: NO_STORE })
  } catch {
    return Response.json({ error: "No se pudo cargar la facturación." }, { status: 500 })
  }
}

function manualEntry(body: Record<string, unknown>): BillingEntryInput | null {
  const orderId = positiveId(body.orderId)
  const amount = typeof body.amount === "string" || typeof body.amount === "number" ? parseBillingAmount(String(body.amount)) : null
  const billedOn = typeof body.billedOn === "string" ? parseBillingDate(body.billedOn) : null
  const reference = typeof body.reference === "string" ? body.reference.trim() : ""
  const tracking = typeof body.tracking === "string" ? body.tracking.replace(/\s/g, "").toUpperCase() : ""
  const notes = typeof body.notes === "string" ? body.notes.trim() : ""
  if (!orderId || !amount || !billedOn || !reference || reference.length > 80 || notes.length > 1000) return null
  if (body.movementType !== undefined && !isBillingMovementType(body.movementType)) return null
  return {
    orderId,
    tracking: tracking || null,
    amount,
    billedOn,
    reference,
    ...(isBillingMovementType(body.movementType) ? { movementType: body.movementType } : {}),
    notes: notes || null,
  }
}

function readMapping(value: unknown): BillingColumnMapping | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const mapping: BillingColumnMapping = {}
  for (const [field, column] of Object.entries(value as Record<string, unknown>)) {
    if (!["tracking", "amount", "billedOn", "reference", "movementType", "notes"].includes(field)) return null
    if (column === null || column === "") continue
    if (typeof column !== "string" || column.length > 120) return null
    mapping[field as BillingField] = column
  }
  return mapping
}

export async function POST(request: Request) {
  const auth = await requireInternalUser(request, [...ROLES])
  if ("error" in auth) return auth.error
  const body = await readJson(request)
  if (body === "too_large") return tooLarge()
  if (!body) return invalid()

  try {
    if (body.action === "manual") {
      const entry = manualEntry(body)
      if (!entry) return invalid("Completá importe, fecha y referencia de la factura.")
      const [result] = await recordBillingEntries(auth.admin, { entries: [entry], source: "manual", actorId: auth.user.id })
      if (result.status === "invalid") return invalid(result.error)
      if (result.status === "conflict") {
        return Response.json({ error: "Esa factura ya está registrada para este envío con otro importe o fecha. Corregí el cargo existente.", result }, { status: 409 })
      }
      return Response.json({ result }, { status: result.status === "created" ? 201 : 200 })
    }

    if (body.action === "import") {
      if (typeof body.csv !== "string") return invalid("Adjuntá un archivo CSV.")
      const mapping = readMapping(body.mapping)
      if (!mapping) return invalid("Asignación de columnas inválida.")
      const { rows } = parseBillingCsv(body.csv)
      const { entries, rowNumbers, errors } = billingEntriesFromCsv(rows, mapping)
      const results = entries.length
        ? await recordBillingEntries(auth.admin, {
          entries,
          source: "csv",
          actorId: auth.user.id,
          dryRun: body.dryRun === true,
        })
        : []
      return Response.json({
        dryRun: body.dryRun === true,
        rows: [
          ...errors.map((error) => ({ row: error.row, status: "invalid" as const, error: error.error })),
          ...results.map((result) => ({ ...result, row: rowNumbers[result.index] })),
        ].sort((left, right) => (left.row ?? 0) - (right.row ?? 0)),
      }, { headers: NO_STORE })
    }
    return invalid("Acción inválida.")
  } catch (error) {
    if (error instanceof BillingCsvError) return invalid(error.message)
    const message = error instanceof Error ? error.message : ""
    if (/LOGISTICS_FORBIDDEN/.test(message)) return Response.json({ error: billingErrorMessage(message) }, { status: 403 })
    if (/BILLING_/.test(message)) return invalid(billingErrorMessage(message))
    console.warn("ANDREANI_BILLING_RECORD_FAILED")
    return Response.json({ error: "No se pudo registrar la facturación." }, { status: 500 })
  }
}

export async function PATCH(request: Request) {
  const auth = await requireInternalUser(request, [...ROLES])
  if ("error" in auth) return auth.error
  const body = await readJson(request)
  if (body === "too_large") return tooLarge()
  const entryId = positiveId(body?.entryId)
  const reason = typeof body?.reason === "string" ? body.reason.trim() : ""
  const rawPatch = body?.patch
  if (!body || !entryId || !rawPatch || typeof rawPatch !== "object" || Array.isArray(rawPatch)) return invalid()
  if (reason.length < 5 || reason.length > 500) return invalid("Indicá el motivo de la corrección (mínimo 5 caracteres).")

  const source = rawPatch as Record<string, unknown>
  const patch: Parameters<typeof updateBillingEntry>[1]["patch"] = {}
  if ("amount" in source) {
    const amount = typeof source.amount === "string" || typeof source.amount === "number" ? parseBillingAmount(String(source.amount)) : null
    if (!amount) return invalid("Importe inválido.")
    patch.amount = amount
  }
  if ("billedOn" in source) {
    const billedOn = typeof source.billedOn === "string" ? parseBillingDate(source.billedOn) : null
    if (!billedOn) return invalid("Fecha inválida.")
    patch.billedOn = billedOn
  }
  if ("reference" in source) {
    if (typeof source.reference !== "string" || !source.reference.trim() || source.reference.trim().length > 80) return invalid("Referencia inválida.")
    patch.reference = source.reference.trim()
  }
  if ("notes" in source) {
    if (source.notes !== null && (typeof source.notes !== "string" || source.notes.length > 1000)) return invalid("Observación inválida.")
    patch.notes = typeof source.notes === "string" ? source.notes.trim() || null : null
  }
  if ("movementType" in source) {
    if (!isBillingMovementType(source.movementType)) return invalid("Tipo de movimiento inválido.")
    patch.movementType = source.movementType
  }
  if ("orderId" in source) {
    const orderId = positiveId(source.orderId)
    if (!orderId) return invalid("Pedido inválido.")
    patch.orderId = orderId
  }
  if (!Object.keys(patch).length) return invalid("No hay cambios para guardar.")

  try {
    const entry = await updateBillingEntry(auth.admin, { entryId, patch, reason, actorId: auth.user.id })
    return Response.json({ entry }, { headers: NO_STORE })
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    if (/LOGISTICS_FORBIDDEN/.test(message)) return Response.json({ error: billingErrorMessage(message) }, { status: 403 })
    if (/BILLING_DUPLICATE|BILLING_ALREADY_MATCHED/.test(message)) return Response.json({ error: billingErrorMessage(message) }, { status: 409 })
    if (/BILLING_ENTRY_NOT_FOUND/.test(message)) return Response.json({ error: billingErrorMessage(message) }, { status: 404 })
    if (/BILLING_/.test(message)) return invalid(billingErrorMessage(message))
    console.warn("ANDREANI_BILLING_UPDATE_FAILED")
    return Response.json({ error: "No se pudo corregir el cargo." }, { status: 500 })
  }
}
