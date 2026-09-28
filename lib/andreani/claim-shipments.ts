import "server-only"

import { randomUUID } from "node:crypto"

import type { createAdminClient } from "../supabase/admin.ts"
import {
  DEFAULT_ANDREANI_COMMERCIAL_SETTINGS,
  getAndreaniCommercialSettings,
  type AndreaniCommercialSettings,
} from "../site-settings.ts"
import type {
  ClaimExchangeOutcome,
  ClaimShipmentCreationStatus,
  ClaimShipmentDirection,
  ClaimShipmentModality,
  ClaimShipmentStatus,
} from "../orders/claim-shipment-view.ts"

import {
  AndreaniError,
  crearOrdenEnvio,
  getEstadoOrden,
  getEtiquetas,
  normalizeAndreaniError,
} from "./client.ts"
import { aggregateAndreaniPackage, loadAndreaniBranchCatalog } from "./checkout-quote.ts"
import {
  ANDREANI_ORDER_SELECT,
  assertAndreaniProdShipmentCreationAuthorized,
  buildAndreaniShipmentEnvio,
  buildConsolidatedProduct,
  crearOrdenEnvioConReintentoDeAutenticacion,
  formatAndreaniErrorForPersistence,
  loadOrderShipmentItems,
  resolveAndreaniShipmentCreationConfig,
  type AndreaniOrderRow,
  type AndreaniShipmentCreationConfig,
} from "./order-shipment.ts"
import {
  fetchAndreaniOrderTrackingSnapshot,
  type AndreaniOrderTrackingSnapshot,
} from "./order-tracking-sync.ts"
import {
  ANDREANI_DNI_PATTERN,
  ANDREANI_EMAIL_MAX_LENGTH,
  ANDREANI_PHONE_MAX_DIGITS,
  ANDREANI_PHONE_MIN_DIGITS,
  ANDREANI_RECIPIENT_NAME_MAX_LENGTH,
} from "./shipment-limits.ts"
import { parseAndreaniTimestamp } from "./tracking-timestamps.ts"
import { mapAndreaniEventToLogisticsPhase } from "./tracking-status-mapping.ts"
import type {
  AndreaniBranch,
  AndreaniCreateShipmentRequest,
  AndreaniEnvironment,
  AndreaniLabelResponse,
  AndreaniTrackingEvent,
} from "./types.ts"
import { ANDREANI_PROVIDER_DISABLED_MESSAGE } from "./types.ts"

/**
 * Operaciones Andreani de un reclamo (order_claim_shipments). La postventa es
 * SIEMPRE por sucursal Andreani (nunca domicilio, aunque la compra haya sido a
 * domicilio): la sucursal de cada tramo la fija el Admin (verificada contra el
 * catálogo de Andreani para el destino del pedido) o es la de la compra.
 *
 *   cambio     CAMBIO sucursal  ANDREANI_{ENV}_EXCHANGE_BRANCH_CONTRACT
 *              Andreani entrega el nuevo en la sucursal al recibir el original.
 *   devolucion RETIRO sucursal  ANDREANI_{ENV}_RETURN_DROPOFF_CONTRACT
 *              El cliente despacha en la sucursal hacia BEYONIX.
 *   reemplazo  VENTA sucursal   ANDREANI_{ENV}_BRANCH_CONTRACT (el de la venta)
 *              Reenvío tras recepción + inspección, a la sucursal.
 *
 * Todas: POST /v2/ordenes-de-envio con las barreras existentes
 * (ANDREANI_SHIPMENT_ENV y autorización explícita de PROD), candado en la base
 * antes de llamar a Andreani, resultado incierto -> revisión manual y
 * conciliación de un admin; nunca un segundo POST automático. Ninguna función
 * de este archivo modifica stock: sólo la base mueve unidades.
 */

type AdminClient = ReturnType<typeof createAdminClient>

export type {
  ClaimShipmentCreationStatus,
  ClaimShipmentDirection,
  ClaimShipmentModality,
  ClaimShipmentStatus,
}

export interface ClaimShipmentRow {
  id: number
  claim_id: number
  order_id: number
  direction: ClaimShipmentDirection
  attempt: number
  status: ClaimShipmentStatus
  exchange_outcome: ClaimExchangeOutcome | null
  modality: ClaimShipmentModality | null
  /** NULL sólo en filas heredadas del modelo inicial (nunca se generan de nuevo). */
  branch_id: string | null
  branch_name: string | null
  branch_address: string | null
  environment: AndreaniEnvironment | null
  contract: string | null
  andreani_envio_id: string | null
  andreani_tracking: string | null
  andreani_estado: string | null
  andreani_last_event: string | null
  andreani_last_event_at: string | null
  incident_open: boolean
  incident_event: string | null
  review_required: boolean
  review_event: string | null
  legacy: boolean
  branch_custody_since: string | null
  cost_amount: number | string | null
  creation_status: ClaimShipmentCreationStatus
  creation_error: string | null
  creation_started_at: string | null
  delivered_at: string | null
  closed_at: string | null
  last_checked_at: string | null
}

export const CLAIM_SHIPMENT_SELECT =
  "id, claim_id, order_id, direction, attempt, status, exchange_outcome, modality, branch_id, branch_name, branch_address, environment, contract, andreani_envio_id, andreani_tracking, andreani_estado, andreani_last_event, andreani_last_event_at, incident_open, incident_event, review_required, review_event, legacy, branch_custody_since, cost_amount, creation_status, creation_error, creation_started_at, delivered_at, closed_at, last_checked_at"

export interface AndreaniClaimContracts {
  shipment: AndreaniShipmentCreationConfig
  returnBranchContract?: string
  exchangeBranchContract?: string
}

interface ClaimRow {
  id: number
  order_id: number
  status: string
  resolution: string | null
}

const IN_PROGRESS_MESSAGE =
  "La operación Andreani ya se está generando o requiere conciliación manual antes de reintentar."
const MISSING_CUSTOMER_DATA_MESSAGE =
  "Faltan datos del cliente (nombre, email, teléfono o DNI) para generar la operación Andreani."
const ID_PREFIX: Record<ClaimShipmentDirection, string> = { devolucion: "R", cambio: "C", reemplazo: "E" }
const RPC_MESSAGES: Record<string, string> = {
  CLAIM_SHIPMENT_NOT_READY: "El reclamo no tiene una solución aceptada que requiera esta operación.",
  CLAIM_SHIPMENT_NOT_READY_RESERVATION: "Primero reservá el producto de reemplazo para todas las unidades que el cliente entrega.",
  CLAIM_SHIPMENT_NOT_READY_RECEPTION: "El reemplazo por envío se genera cuando el producto original ya está en BEYONIX.",
  CLAIM_SHIPMENT_CLOSED: "Esta operación ya está cerrada.",
  CLAIM_SHIPMENT_NOT_FOUND: "El reclamo no tiene esa operación.",
  CLAIM_SHIPMENT_ENVIO_IN_USE: "Esa orden Andreani ya está vinculada a otra operación o a un pedido.",
  CLAIM_SHIPMENT_RECONCILIATION_NOT_PENDING: "No hay una creación incierta para conciliar.",
  CLAIM_SHIPMENT_RECONCILIATION_FORBIDDEN: "Sólo un administrador puede conciliar con Andreani.",
  CLAIM_SHIPMENT_INVALID: "Revisá los datos de la conciliación.",
}

function text(value: string | null | undefined) {
  return typeof value === "string" ? value.trim() : ""
}

// ── Contratos y modalidad ────────────────────────────────────────────────────

export function resolveAndreaniClaimContracts(env: NodeJS.ProcessEnv = process.env): AndreaniClaimContracts {
  const shipment = resolveAndreaniShipmentCreationConfig(env)
  const read = (suffix: string) => text(env[`ANDREANI_${shipment.environment}_${suffix}`]) || undefined
  return {
    shipment,
    returnBranchContract: read("RETURN_DROPOFF_CONTRACT"),
    exchangeBranchContract: read("EXCHANGE_BRANCH_CONTRACT"),
  }
}

type ClaimOrder = Pick<
  AndreaniOrderRow,
  "id" | "cliente_nombre" | "cliente_email" | "cliente_telefono" | "cliente_dni"
>

function requireContract(contract: string | undefined, name: string, environment: AndreaniEnvironment) {
  if (!contract) {
    throw new AndreaniError("CONFIGURATION_ERROR", `Falta configurar el contrato ${name} de Andreani ${environment}. La operación queda pendiente.`)
  }
  return contract
}

/**
 * Modalidad y contrato del tramo: SIEMPRE sucursal. Nunca un contrato de
 * domicilio ni otro servicio como fallback silencioso.
 */
export function chooseClaimShipmentModality(
  direction: ClaimShipmentDirection,
  contracts: AndreaniClaimContracts,
): { modality: ClaimShipmentModality; contract: string } {
  const environment = contracts.shipment.environment
  if (direction === "cambio") {
    return { modality: "cambio_sucursal", contract: requireContract(contracts.exchangeBranchContract, "de CAMBIO sucursal", environment) }
  }
  if (direction === "devolucion") {
    return { modality: "despacho_sucursal", contract: requireContract(contracts.returnBranchContract, "de RETIRO sucursal", environment) }
  }
  return { modality: "entrega_sucursal", contract: requireContract(contracts.shipment.sucursalContrato, "de VENTA sucursal", environment) }
}

function branchIdOf(leg: Pick<ClaimShipmentRow, "branch_id">) {
  const branchId = text(leg.branch_id)
  if (!/^\d{1,12}$/.test(branchId)) {
    throw new AndreaniError("VALIDATION_ERROR", "La operación no tiene una sucursal Andreani válida.")
  }
  return branchId
}

function assertCustomerContact(order: ClaimOrder) {
  const nombreCompleto = text(order.cliente_nombre)
  const email = text(order.cliente_email)
  const telefono = text(order.cliente_telefono).replace(/\D/g, "")
  const dni = text(order.cliente_dni)
  if (
    !nombreCompleto ||
    nombreCompleto.length > ANDREANI_RECIPIENT_NAME_MAX_LENGTH ||
    !email ||
    email.length > ANDREANI_EMAIL_MAX_LENGTH ||
    telefono.length < ANDREANI_PHONE_MIN_DIGITS ||
    telefono.length > ANDREANI_PHONE_MAX_DIGITS ||
    !ANDREANI_DNI_PATTERN.test(dni)
  ) {
    throw new AndreaniError("VALIDATION_ERROR", MISSING_CUSTOMER_DATA_MESSAGE)
  }
  return { nombreCompleto, email, telefono, dni }
}

/**
 * Devolución: el cliente despacha en la sucursal del tramo (remitente) y
 * BEYONIX recibe en su sucursal Andreani. Nunca un retiro en domicilio.
 */
export function buildClaimReturnEnvio(
  order: ClaimOrder,
  reference: string,
  shipment: AndreaniShipmentCreationConfig,
  contract: string,
  branchId: string,
): Omit<AndreaniCreateShipmentRequest, "bultos"> {
  const contact = assertCustomerContact(order)
  return {
    contrato: contract,
    idPedido: reference,
    origen: { sucursal: { id: branchId } },
    destino: { sucursal: { id: shipment.sucursalOrigenId } },
    remitente: {
      nombreCompleto: contact.nombreCompleto,
      email: contact.email,
      documentoTipo: "DNI",
      documentoNumero: contact.dni,
      // Celular = 1 para remitente.
      telefonos: [{ tipo: 1, numero: contact.telefono }],
    },
    destinatario: [
      {
        nombreCompleto: shipment.remitenteNombre,
        email: shipment.remitenteEmail,
        documentoTipo: shipment.remitenteDocumentoTipo,
        documentoNumero: shipment.remitenteDocumentoNumero,
        // Celular = 2 para destinatario.
        telefonos: shipment.remitenteTelefono ? [{ tipo: 2, numero: shipment.remitenteTelefono }] : undefined,
      },
    ],
  }
}

export function claimShipmentReference(orderId: number, claimId: number, direction: ClaimShipmentDirection, attempt: number) {
  return `${orderId}-${ID_PREFIX[direction]}${claimId}${attempt > 1 ? `-${attempt}` : ""}`
}

// ── Creación idempotente ─────────────────────────────────────────────────────

export interface ClaimShipmentCreationDependencies {
  env?: NodeJS.ProcessEnv
  crearOrdenEnvio?: typeof crearOrdenEnvio
  getAndreaniCommercialSettings?: () => Promise<AndreaniCommercialSettings>
}

export interface ClaimShipmentCreationResult {
  status: "created" | "reused"
  shipment: ClaimShipmentRow
}

function rpcErrorMessage(message: string) {
  const code = Object.keys(RPC_MESSAGES).find((key) => new RegExp(`\\b${key}\\b`).test(message))
  return code ? RPC_MESSAGES[code] : "No se pudo registrar la operación Andreani del reclamo."
}

async function rpcShipment(admin: AdminClient, name: string, args: Record<string, unknown>): Promise<ClaimShipmentRow | null> {
  const { data, error } = await admin.rpc(name, args)
  if (error) {
    const message = error.code === "23505" ? "CLAIM_SHIPMENT_ENVIO_IN_USE" : error.message
    throw new AndreaniError(/NOT_READY|CLOSED|NOT_FOUND|IN_USE|INVALID|NOT_PENDING|FORBIDDEN/.test(message) ? "VALIDATION_ERROR" : "REQUEST_FAILED",
      rpcErrorMessage(message))
  }
  const row = Array.isArray(data) ? data[0] : data
  return (row && typeof row === "object" && "claim_id" in row && row.claim_id !== null ? row : null) as ClaimShipmentRow | null
}

export async function loadClaimShipment(admin: AdminClient, shipmentId: number) {
  const { data, error } = await admin.from("order_claim_shipments").select(CLAIM_SHIPMENT_SELECT).eq("id", shipmentId).maybeSingle()
  if (error) throw new AndreaniError("REQUEST_FAILED", "No se pudo leer la operación del reclamo.")
  return (data ?? null) as ClaimShipmentRow | null
}

/**
 * ¿Andreani pudo haber creado la orden? Mismo criterio que el envío B2C del
 * pedido: timeout, respuesta inválida, 5xx y 408/409 son inciertos (409 puede
 * ser "ya existe"); sólo lo que prueba que NO se creó se marca reintentable.
 */
export function isUncertainClaimCreationFailure(error: unknown) {
  if (!(error instanceof AndreaniError)) return true
  if (error.code === "TIMEOUT" || error.code === "INVALID_RESPONSE") return true
  if (error.code === "SERVICE_UNAVAILABLE") return error.status === null || error.status >= 500
  if (error.code === "REQUEST_FAILED") return error.status === null || error.status === 408 || error.status === 409 || error.status >= 500
  return false
}

interface PreparedClaimShipment {
  environment: AndreaniEnvironment
  modality: ClaimShipmentModality
  contract: string
  order: AndreaniOrderRow
  envio: Omit<AndreaniCreateShipmentRequest, "bultos">
  reference: string
  description: string
}

async function prepareClaimShipment(
  admin: AdminClient,
  leg: ClaimShipmentRow,
  claim: ClaimRow,
  env: NodeJS.ProcessEnv,
  dependencies: ClaimShipmentCreationDependencies,
): Promise<PreparedClaimShipment> {
  const settings = await (dependencies.getAndreaniCommercialSettings ?? getAndreaniCommercialSettings)()
    .catch(() => DEFAULT_ANDREANI_COMMERCIAL_SETTINGS)
  if (!settings.enabled) throw new AndreaniError("PROVIDER_DISABLED", ANDREANI_PROVIDER_DISABLED_MESSAGE)
  const contracts = resolveAndreaniClaimContracts(env)
  assertAndreaniProdShipmentCreationAuthorized(contracts.shipment.environment, env)
  const { data, error } = await admin.from("ordenes").select(ANDREANI_ORDER_SELECT).eq("id", claim.order_id).maybeSingle()
  if (error || !data) throw new AndreaniError("VALIDATION_ERROR", "No encontramos el pedido del reclamo.")
  const order = data as unknown as AndreaniOrderRow
  const choice = chooseClaimShipmentModality(leg.direction, contracts)
  const branchId = branchIdOf(leg)
  const reference = claimShipmentReference(order.id, claim.id, leg.direction, Number(leg.attempt ?? 1))
  // Cambio y reenvío salen de BEYONIX hacia la SUCURSAL del tramo (mismo
  // armado que la entrega en sucursal de una venta, aunque la compra haya sido
  // a domicilio); la devolución va del cliente, desde esa sucursal, a BEYONIX.
  const envio = leg.direction === "devolucion"
    ? buildClaimReturnEnvio(order, reference, contracts.shipment, choice.contract, branchId)
    : {
        ...buildAndreaniShipmentEnvio({ ...order, shipping_type: "sucursal", andreani_sucursal_id: branchId }, contracts.shipment),
        contrato: choice.contract,
        idPedido: reference,
      }
  const label = leg.direction === "cambio" ? "Cambio" : leg.direction === "devolucion" ? "Devolución" : "Reemplazo"
  return {
    environment: contracts.shipment.environment,
    modality: choice.modality,
    contract: choice.contract,
    order,
    envio,
    reference,
    description: `${label} reclamo ${claim.id} · Pedido BX-${1000 + order.id}`,
  }
}

/** Bulto con EXACTAMENTE las unidades asignadas al tramo por la base. */
async function loadLegPackage(admin: AdminClient, leg: ClaimShipmentRow, orderId: number) {
  const role = leg.direction === "devolucion" ? "original" : "reemplazo"
  const { data, error } = await admin.from("order_claim_units").select("order_item_id, replacement_id")
    .eq("shipment_id", leg.id).eq("role", role)
  if (error) throw new AndreaniError("REQUEST_FAILED", "No se pudieron leer las unidades de la operación.")
  const rows = (data ?? []) as Array<{ order_item_id: number; replacement_id: number | null }>
  if (!rows.length) throw new AndreaniError("VALIDATION_ERROR", "La operación no tiene unidades asignadas.")
  const quantities = new Map<number, number>()
  for (const row of rows) quantities.set(Number(row.order_item_id), (quantities.get(Number(row.order_item_id)) ?? 0) + 1)

  const variants = new Map<number, number>()
  if (role === "reemplazo") {
    const ids = [...new Set(rows.map((row) => Number(row.replacement_id)))]
    const { data: replacements, error: replacementError } = await admin.from("order_replacements")
      .select("id, original_order_item_id, replacement_variant_id").in("id", ids)
    if (replacementError) throw new AndreaniError("REQUEST_FAILED", "No se pudieron leer los reemplazos reservados.")
    for (const row of (replacements ?? []) as Array<{ original_order_item_id: number; replacement_variant_id: number }>) {
      const itemId = Number(row.original_order_item_id)
      const previous = variants.get(itemId)
      if (previous !== undefined && previous !== Number(row.replacement_variant_id)) {
        throw new AndreaniError("VALIDATION_ERROR", "El reemplazo usa varias variantes para un mismo producto: separalo en operaciones distintas o gestionalo fuera de Andreani.")
      }
      variants.set(itemId, Number(row.replacement_variant_id))
    }
  }
  return aggregateAndreaniPackage(await loadOrderShipmentItems(admin, orderId, quantities, variants))
}

/**
 * Genera la operación Andreani del tramo. Doble click / reintento / dos
 * pestañas: una sola orden. Resultado incierto: revisión manual.
 */
export async function createClaimShipment(
  admin: AdminClient,
  shipmentId: number,
  dependencies: ClaimShipmentCreationDependencies = {},
): Promise<ClaimShipmentCreationResult> {
  const env = dependencies.env ?? process.env
  const leg = await loadClaimShipment(admin, shipmentId)
  if (!leg) throw new AndreaniError("VALIDATION_ERROR", RPC_MESSAGES.CLAIM_SHIPMENT_NOT_FOUND)
  if (leg.creation_status === "created") return { status: "reused", shipment: leg }
  if (leg.creation_status === "processing" || leg.creation_status === "manual_review") {
    throw new AndreaniError("REQUEST_FAILED", IN_PROGRESS_MESSAGE)
  }
  if (leg.closed_at) throw new AndreaniError("VALIDATION_ERROR", RPC_MESSAGES.CLAIM_SHIPMENT_CLOSED)
  const { data: claimData, error: claimError } = await admin.from("order_claims")
    .select("id, order_id, status, resolution").eq("id", leg.claim_id).maybeSingle()
  if (claimError) throw new AndreaniError("REQUEST_FAILED", "No se pudo leer el reclamo.")
  const claim = claimData as ClaimRow | null
  if (!claim) throw new AndreaniError("VALIDATION_ERROR", "No encontramos el reclamo.")

  // Lo que falla ANTES de tomar el tramo queda visible como motivo, sin candado.
  let prepared: PreparedClaimShipment
  try {
    prepared = await prepareClaimShipment(admin, leg, claim, env, dependencies)
  } catch (error) {
    await rpcShipment(admin, "fail_order_claim_shipment_creation", {
      p_shipment_id: shipmentId, p_token: null, p_error: normalizeAndreaniError(error, env).message, p_outcome: "blocked",
    }).catch(() => null)
    throw error
  }

  const token = randomUUID()
  const claimed = await rpcShipment(admin, "claim_order_claim_shipment_creation", {
    p_shipment_id: shipmentId, p_token: token,
    p_environment: prepared.environment, p_modality: prepared.modality, p_contract: prepared.contract,
  })
  if (!claimed) throw new AndreaniError("REQUEST_FAILED", IN_PROGRESS_MESSAGE)
  if (claimed.creation_status === "created") return { status: "reused", shipment: claimed }

  // Después de tomar el tramo: el bulto son exactamente sus unidades. Un
  // fallo acá es previo al POST: Andreani no creó nada.
  let packageData: Awaited<ReturnType<typeof loadLegPackage>>
  try {
    packageData = await loadLegPackage(admin, claimed, prepared.order.id)
  } catch (error) {
    await rpcShipment(admin, "fail_order_claim_shipment_creation", {
      p_shipment_id: shipmentId, p_token: token,
      p_error: normalizeAndreaniError(error, env).message, p_outcome: "failed",
    }).catch(() => null)
    throw error
  }

  let envioId: string
  let tracking: string | null
  let estado: string
  try {
    const response = await crearOrdenEnvioConReintentoDeAutenticacion(
      dependencies.crearOrdenEnvio ?? crearOrdenEnvio,
      {
        envio: prepared.envio,
        items: [{
          producto: buildConsolidatedProduct(prepared.order.id, packageData),
          bulto: {
            volumenCm: packageData.volumenCm3,
            valorDeclaradoConImpuestos: packageData.valorDeclarado,
            referencias: [{ meta: "idCliente", contenido: prepared.reference }],
            descripcion: prepared.description,
          },
        }],
      },
      {
        env: { ...env, ANDREANI_ENV: prepared.environment, ANDREANI_TARIFF_ENV: prepared.environment },
        productionAccess: prepared.environment === "PROD" ? "shipment-creation" : undefined,
      },
    )
    if (response.estado === "Rechazado") {
      throw new AndreaniError("REQUEST_FAILED", response.motivo || "Andreani rechazó la orden.", { status: 422 })
    }
    const bulto = response.bultos[0]
    const id = response.agrupadorDeBultos || bulto?.numeroDeEnvio
    if (!id) throw new AndreaniError("INVALID_RESPONSE", "Andreani no devolvió un identificador de la orden.")
    envioId = id
    tracking = bulto?.numeroDeEnvio ?? null
    estado = response.estado
  } catch (error) {
    await rpcShipment(admin, "fail_order_claim_shipment_creation", {
      p_shipment_id: shipmentId, p_token: token,
      p_error: formatAndreaniErrorForPersistence(normalizeAndreaniError(error, env)),
      p_outcome: isUncertainClaimCreationFailure(error) ? "manual_review" : "failed",
    }).catch(() => null)
    throw error
  }

  try {
    const completed = await rpcShipment(admin, "complete_order_claim_shipment_creation", {
      p_shipment_id: shipmentId, p_token: token,
      p_envio_id: envioId, p_tracking: tracking, p_estado: estado,
      // POST /v2/ordenes-de-envio no informa costo: no se inventa uno.
      p_cost_amount: null,
    })
    if (!completed) throw new Error("sin fila")
    return { status: "created", shipment: completed }
  } catch {
    // Andreani SÍ creó la operación: nunca se marca como reintentable.
    await rpcShipment(admin, "fail_order_claim_shipment_creation", {
      p_shipment_id: shipmentId, p_token: token,
      p_error: `Andreani creó la orden ${envioId} pero no se pudo guardar. Conciliar con ese número; no reintentar.`,
      p_outcome: "manual_review",
    }).catch(() => null)
    throw new AndreaniError("REQUEST_FAILED", `Andreani creó la orden ${envioId}, pero no se pudo guardar. Requiere conciliación.`)
  }
}

// ── Sucursal del tramo ───────────────────────────────────────────────────────

export interface ClaimBranch {
  /** idgla: sólo uso interno (nunca se muestra al cliente). */
  id: string
  name: string
  address: string | null
  locality: string
  province: string
  postalCode: string | null
}

export interface ClaimBranchDependencies {
  env?: NodeJS.ProcessEnv
  loadCatalog?: (environment: AndreaniEnvironment) => Promise<AndreaniBranch[]>
}

const BRANCH_UNAVAILABLE_MESSAGE =
  "No pudimos consultar las sucursales de Andreani. Intentá de nuevo en unos minutos: sin una sucursal válida no se puede generar la logística."

function normalizeSearch(value: string | null | undefined) {
  return text(value).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ")
}

function toClaimBranch(branch: AndreaniBranch): ClaimBranch {
  const street = [text(branch.direccion.calle), text(branch.direccion.numero)].filter(Boolean).join(" ")
  return {
    id: String(branch.id),
    name: text(branch.descripcion) || `Sucursal ${branch.id}`,
    address: street || null,
    locality: text(branch.direccion.localidad),
    province: text(branch.direccion.provincia),
    postalCode: text(branch.direccion.codigoPostal) || null,
  }
}

/**
 * Catálogo real de Andreani, en el MISMO ambiente donde se van a crear las
 * operaciones de reclamos (idgla distintos entre QA y PROD). Si Andreani no
 * responde, error claro: nunca una sucursal "de repuesto".
 */
async function claimBranchCatalog(dependencies: ClaimBranchDependencies) {
  const env = dependencies.env ?? process.env
  const environment = resolveAndreaniShipmentCreationConfig(env).environment
  try {
    return await (dependencies.loadCatalog ?? ((target: AndreaniEnvironment) => loadAndreaniBranchCatalog(target, { env })))(environment)
  } catch (error) {
    console.error("ANDREANI_CLAIM_BRANCH_CATALOG_ERROR", normalizeAndreaniError(error, env))
    throw new AndreaniError("SERVICE_UNAVAILABLE", BRANCH_UNAVAILABLE_MESSAGE)
  }
}

/** Buscador del Admin: por nombre, localidad, provincia, dirección o código postal. */
export async function searchClaimBranches(query: string, dependencies: ClaimBranchDependencies = {}): Promise<ClaimBranch[]> {
  const terms = normalizeSearch(query).split(" ").filter((term) => term.length > 0)
  if (!terms.length || normalizeSearch(query).length < 3) {
    throw new AndreaniError("VALIDATION_ERROR", "Escribí al menos 3 letras de la localidad, dirección o sucursal.")
  }
  const catalog = await claimBranchCatalog(dependencies)
  return catalog
    .filter((branch) => {
      const haystack = normalizeSearch([
        branch.descripcion, branch.direccion.calle, branch.direccion.numero, branch.direccion.localidad,
        branch.direccion.provincia, branch.direccion.codigoPostal, ...(branch.codigosPostalesAtendidos ?? []),
      ].filter(Boolean).join(" "))
      return terms.every((term) => haystack.includes(term))
    })
    .slice(0, 30)
    .map(toClaimBranch)
}

/**
 * Validación server-side de la sucursal elegida: tiene que existir hoy en el
 * catálogo real de Andreani (atención al cliente, B2C). Nombre y dirección
 * salen del catálogo, nunca del navegador.
 */
export async function resolveClaimBranch(branchId: string, dependencies: ClaimBranchDependencies = {}): Promise<ClaimBranch> {
  const id = text(branchId)
  if (!/^\d{1,12}$/.test(id)) throw new AndreaniError("VALIDATION_ERROR", "Elegí una sucursal Andreani del buscador.")
  const catalog = await claimBranchCatalog(dependencies)
  const branch = catalog.find((item) => String(item.id) === id)
  if (!branch) {
    throw new AndreaniError("VALIDATION_ERROR", "Esa sucursal ya no figura como disponible en Andreani. Elegí otra.")
  }
  return toClaimBranch(branch)
}

/**
 * Sucursal por defecto de una operación nueva (la base nunca la infiere):
 * la del tramo anterior del reclamo (reenvío -> la del retiro; reintento ->
 * la del cambio) o, en la primera, la que el cliente eligió en su compra. En
 * todos los casos se vuelve a validar contra el catálogo actual.
 */
export async function resolveDefaultClaimBranch(
  admin: AdminClient,
  claimId: number,
  direction: ClaimShipmentDirection,
  dependencies: ClaimBranchDependencies = {},
): Promise<ClaimBranch | null> {
  const [{ data: claim }, { data: legs }] = await Promise.all([
    admin.from("order_claims").select("order_id").eq("id", claimId).maybeSingle(),
    admin.from("order_claim_shipments").select("id, direction, status, branch_id").eq("claim_id", claimId).neq("status", "cancelada"),
  ])
  const previous = ((legs ?? []) as Array<{ id: number; direction: ClaimShipmentDirection; branch_id: string | null }>)
    .filter((leg) => text(leg.branch_id))
    .sort((left, right) => {
      const target = direction === "reemplazo" ? "devolucion" : direction
      return Number(right.direction === target) - Number(left.direction === target) || right.id - left.id
    })[0]
  let candidate = previous ? text(previous.branch_id) : ""
  if (!candidate && claim) {
    const { data: order } = await admin.from("ordenes").select("shipping_type, andreani_sucursal_id")
      .eq("id", Number((claim as { order_id: number }).order_id)).maybeSingle()
    const purchase = order as { shipping_type: string | null; andreani_sucursal_id: string | null } | null
    if (purchase?.shipping_type === "sucursal") candidate = text(purchase.andreani_sucursal_id)
  }
  if (!candidate) return null
  return resolveClaimBranch(candidate, dependencies)
}

// ── Conciliación manual ──────────────────────────────────────────────────────

export interface ClaimShipmentReconciliation {
  shipmentId: number
  actorId: string
  resolution: "created" | "not_created"
  envioId?: string
  notes: string
}

/**
 * Tras un resultado incierto: "created" se verifica primero contra Andreani
 * (sólo lectura, en el ambiente del tramo) y la base rechaza una orden ya
 * usada por otro tramo o pedido; "not_created" libera el tramo con la
 * confirmación documentada del admin. Nunca reintenta el POST.
 */
export async function reconcileClaimShipment(
  admin: AdminClient,
  input: ClaimShipmentReconciliation,
  dependencies: { getEstadoOrden?: typeof getEstadoOrden } = {},
) {
  const current = await loadClaimShipment(admin, input.shipmentId)
  if (!current) throw new AndreaniError("VALIDATION_ERROR", RPC_MESSAGES.CLAIM_SHIPMENT_NOT_FOUND)
  let tracking: string | null = null
  if (input.resolution === "created") {
    const envioId = text(input.envioId)
    if (!envioId || !current.environment) {
      throw new AndreaniError("VALIDATION_ERROR", "Ingresá el número de orden Andreani real.")
    }
    const status = await (dependencies.getEstadoOrden ?? getEstadoOrden)(envioId, {
      env: { ...process.env, ANDREANI_ENV: current.environment },
      productionAccess: current.environment === "PROD" ? "shipment-read" : undefined,
    })
    if (status.estado === "Rechazado") {
      throw new AndreaniError("VALIDATION_ERROR", "Andreani informa esa orden como rechazada: no se puede vincular.")
    }
    tracking = status.bultos[0]?.numeroDeEnvio ?? null
  }
  const updated = await rpcShipment(admin, "resolve_order_claim_shipment_reconciliation", {
    p_shipment_id: input.shipmentId, p_actor_id: input.actorId,
    p_resolution: input.resolution, p_envio_id: input.resolution === "created" ? text(input.envioId) : null,
    p_tracking: tracking, p_notes: input.notes,
  })
  if (!updated) throw new AndreaniError("REQUEST_FAILED", "No se pudo conciliar la operación del reclamo.")
  return updated
}

// ── Etiqueta ─────────────────────────────────────────────────────────────────

/** Etiqueta PDF de un tramo ya creado, en el ambiente donde se creó. Nunca pública. */
export async function getClaimShipmentLabel(
  shipment: Pick<ClaimShipmentRow, "andreani_envio_id" | "environment" | "creation_status" | "status">,
  dependencies: { getEtiquetas?: typeof getEtiquetas } = {},
): Promise<AndreaniLabelResponse> {
  const envioId = text(shipment.andreani_envio_id)
  if (shipment.creation_status !== "created" || !envioId || !shipment.environment || shipment.status === "cancelada") {
    throw new AndreaniError("VALIDATION_ERROR", "Todavía no hay una orden Andreani para esta operación.")
  }
  return (dependencies.getEtiquetas ?? getEtiquetas)(envioId, "pdf", {
    env: { ...process.env, ANDREANI_ENV: shipment.environment },
    productionAccess: shipment.environment === "PROD" ? "shipment-read" : undefined,
  })
}

// ── Tracking ─────────────────────────────────────────────────────────────────

export type ClaimShipmentTrackingPhase = "sin_cambio" | "en_transito" | "en_sucursal" | "entregada"

export interface ClaimShipmentTrackingResolution {
  phase: ClaimShipmentTrackingPhase
  incident: boolean
  custodySince: string | null
  /** Evento que no podemos clasificar con seguridad: pide revisión y congela el avance. */
  reviewEvent: string | null
}

const BRANCH_CUSTODY_EVENTS = new Set(["ComienzoCustodiaEnSucursal", "RecepcionEnSucursalDestino"])
/**
 * Eventos del maestro cuyo efecto físico en un reclamo NO se puede deducir
 * (¿volvió?, ¿se perdió?, ¿cambió de destino?): nunca se traducen a un
 * estado; quedan para revisión manual del Admin.
 */
const CLAIM_REVIEW_EVENTS = new Set([
  "EnvioAnulado", "OrdenDeEnvioRechazada", "Siniestro", "RoturaTotal", "RoturaParcial", "FaltanBultos",
  "Rescate", "SolicitudDeRescate", "Reenvio", "CambioDeDestino", "Destruccion", "PedidoDeDestruccion",
])
/** Respuesta de seguimiento fuera del maestro documentado: se registra y se revisa. */
export const CLAIM_UNREADABLE_TRACKING_EVENT = "Seguimiento no interpretable (evento fuera del maestro de Andreani)"

/**
 * Avance MÁXIMO observado en todos los eventos estables (repetidos o
 * desordenados nunca hacen retroceder) + si la novedad más reciente es una
 * incidencia. Eventos cuyo efecto no se puede clasificar no inventan
 * transición: se devuelven como reviewEvent (el más reciente).
 */
export function resolveClaimShipmentTracking(
  eventos: readonly Pick<AndreaniTrackingEvent, "Evento" | "Fecha">[],
  rejectedAfterCreation: boolean,
): ClaimShipmentTrackingResolution {
  const phases: ClaimShipmentTrackingPhase[] = ["sin_cambio", "en_transito", "en_sucursal", "entregada"]
  let reached = 0
  let custodySince: string | null = null
  for (const event of eventos) {
    const logistic = mapAndreaniEventToLogisticsPhase(event.Evento)
    if (logistic === "entregado") reached = Math.max(reached, 3)
    else if (BRANCH_CUSTODY_EVENTS.has(event.Evento)) {
      reached = Math.max(reached, 2)
      const at = parseAndreaniTimestamp(event.Fecha)
      if (!custodySince || Date.parse(at) < Date.parse(custodySince)) custodySince = at
    } else if (logistic === "en_camino" || logistic === "en_distribucion") reached = Math.max(reached, 1)
  }
  const phase = phases[reached]
  const latest = [...eventos]
    .filter((event) => !["orden_creada", "interno"].includes(mapAndreaniEventToLogisticsPhase(event.Evento)))
    .sort((left, right) => Date.parse(parseAndreaniTimestamp(right.Fecha)) - Date.parse(parseAndreaniTimestamp(left.Fecha)))[0]
  const latestPhase = latest ? mapAndreaniEventToLogisticsPhase(latest.Evento) : null
  const incident = phase !== "entregada" &&
    (rejectedAfterCreation || latestPhase === "incidencia" || latestPhase === "no_entregado" || latestPhase === "anulado")
  const review = [...eventos]
    .filter((event) => CLAIM_REVIEW_EVENTS.has(event.Evento))
    .sort((left, right) => Date.parse(parseAndreaniTimestamp(right.Fecha)) - Date.parse(parseAndreaniTimestamp(left.Fecha)))[0]
  const reviewEvent = review?.Evento ?? (rejectedAfterCreation ? "OrdenDeEnvioRechazada" : null)
  return { phase, incident, custodySince, reviewEvent }
}

export interface ClaimShipmentTrackingDependencies {
  fetchSnapshot?: typeof fetchAndreaniOrderTrackingSnapshot
}

/** Consulta Andreani (sólo GET) y avanza el tramo. Idempotente; cron y Admin llegan al mismo estado. */
export async function syncClaimShipmentTracking(
  admin: AdminClient,
  shipment: Pick<ClaimShipmentRow, "id" | "andreani_envio_id" | "andreani_tracking" | "environment" | "creation_status" | "status">,
  dependencies: ClaimShipmentTrackingDependencies = {},
): Promise<{ shipment: ClaimShipmentRow; tracking: ClaimShipmentTrackingResolution; snapshot: AndreaniOrderTrackingSnapshot }> {
  if (shipment.creation_status !== "created" || !text(shipment.andreani_envio_id) || shipment.status === "cancelada") {
    throw new AndreaniError("VALIDATION_ERROR", "La operación todavía no tiene una orden Andreani.")
  }
  let snapshot: AndreaniOrderTrackingSnapshot
  try {
    snapshot = await (dependencies.fetchSnapshot ?? fetchAndreaniOrderTrackingSnapshot)({
      andreani_envio_id: shipment.andreani_envio_id,
      andreani_tracking: shipment.andreani_tracking,
      // Tracking contra el ambiente donde se creó, nunca el configurado hoy.
      andreani_creation_environment: shipment.environment,
    })
  } catch (error) {
    // Evento fuera del maestro / formato no interpretable: se registra y
    // queda para revisión del Admin (sin avanzar, sin stock, sin cerrar).
    if (error instanceof AndreaniError && error.code === "INVALID_RESPONSE") {
      await rpcShipment(admin, "flag_order_claim_shipment_review", {
        p_shipment_id: shipment.id, p_event: CLAIM_UNREADABLE_TRACKING_EVENT,
      }).catch(() => null)
    }
    throw error
  }
  const tracking = resolveClaimShipmentTracking(snapshot.eventos, snapshot.rejectedAfterCreation)
  const updated = await rpcShipment(admin, "apply_order_claim_shipment_tracking", {
    p_shipment_id: shipment.id,
    p_phase: tracking.phase,
    p_incident: tracking.incident,
    p_estado: snapshot.logisticsEstado,
    p_tracking: snapshot.resolvedTracking,
    p_last_event: snapshot.latestEvent?.Evento ?? null,
    p_last_event_at: snapshot.latestEvent ? parseAndreaniTimestamp(snapshot.latestEvent.Fecha) : null,
    p_custody_since: tracking.custodySince,
    p_review_event: tracking.reviewEvent,
  })
  if (!updated) throw new AndreaniError("REQUEST_FAILED", "No se pudo actualizar el seguimiento.")
  return { shipment: updated, tracking, snapshot }
}

/**
 * Cron: sólo tramos creados y abiertos (nunca genera operaciones), los menos
 * consultados primero, en lotes y de a uno. Un fallo no frena a los demás.
 */
export async function runClaimShipmentTrackingBatch(
  admin: AdminClient,
  { limit = 20, ...dependencies }: ClaimShipmentTrackingDependencies & { limit?: number } = {},
) {
  const { data, error } = await admin
    .from("order_claim_shipments")
    .select(CLAIM_SHIPMENT_SELECT)
    .eq("creation_status", "created")
    .is("closed_at", null)
    .neq("status", "cancelada")
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .limit(limit)
  if (error) throw new AndreaniError("REQUEST_FAILED", "No se pudieron leer las operaciones de reclamos a seguir.")
  let updated = 0
  let delivered = 0
  let failed = 0
  let review = 0
  for (const row of (data ?? []) as ClaimShipmentRow[]) {
    const previousStatus = row.status
    try {
      const result = await syncClaimShipmentTracking(admin, row, dependencies)
      updated += 1
      if (result.shipment.status === "entregada" && previousStatus !== "entregada") delivered += 1
      if (result.shipment.review_required) review += 1
    } catch (syncError) {
      if (syncError instanceof AndreaniError && syncError.code === "INVALID_RESPONSE") review += 1
      else failed += 1
      console.error("ANDREANI_CLAIM_SHIPMENT_TRACKING_ERROR", {
        shipmentId: row.id,
        claimId: row.claim_id,
        direction: row.direction,
        ...normalizeAndreaniError(syncError),
      })
    }
  }
  return { checked: (data ?? []).length, updated, delivered, failed, review }
}
