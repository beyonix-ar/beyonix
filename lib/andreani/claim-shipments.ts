import "server-only"

import { randomUUID } from "node:crypto"

import type { createAdminClient } from "../supabase/admin.ts"
import {
  DEFAULT_ANDREANI_COMMERCIAL_SETTINGS,
  getAndreaniCommercialSettings,
  type AndreaniCommercialSettings,
} from "../site-settings.ts"

import {
  AndreaniError,
  crearOrdenEnvio,
  getEstadoOrden,
  getEtiquetas,
  normalizeAndreaniError,
} from "./client.ts"
import { aggregateAndreaniPackage } from "./checkout-quote.ts"
import {
  ANDREANI_ORDER_SELECT,
  assertAndreaniProdShipmentCreationAuthorized,
  buildAndreaniShipmentEnvio,
  buildConsolidatedProduct,
  crearOrdenEnvioConReintentoDeAutenticacion,
  formatAndreaniErrorForPersistence,
  loadOrderShipmentItems,
  parseArgentineStreetAddress,
  resolveAndreaniShipmentCreationConfig,
  type AndreaniOrderRow,
  type AndreaniShipmentCreationConfig,
} from "./order-shipment.ts"
import {
  fetchAndreaniOrderTrackingSnapshot,
  type AndreaniOrderTrackingSnapshot,
} from "./order-tracking-sync.ts"
import {
  ANDREANI_APARTMENT_MAX_LENGTH,
  ANDREANI_DNI_PATTERN,
  ANDREANI_EMAIL_MAX_LENGTH,
  ANDREANI_FLOOR_MAX_LENGTH,
  ANDREANI_LOCALITY_MAX_LENGTH,
  ANDREANI_PHONE_MAX_DIGITS,
  ANDREANI_PHONE_MIN_DIGITS,
  ANDREANI_POSTAL_CODE_PATTERN,
  ANDREANI_RECIPIENT_NAME_MAX_LENGTH,
  ANDREANI_STREET_MAX_LENGTH,
} from "./shipment-limits.ts"
import { parseAndreaniTimestamp } from "./tracking-timestamps.ts"
import { mapAndreaniEventToLogisticsPhase } from "./tracking-status-mapping.ts"
import type {
  AndreaniCreateShipmentRequest,
  AndreaniEnvironment,
  AndreaniLabelResponse,
  AndreaniTrackingEvent,
} from "./types.ts"
import { ANDREANI_PROVIDER_DISABLED_MESSAGE } from "./types.ts"

/**
 * Envíos Andreani de un reclamo con cambio de producto (order_claim_shipments):
 *
 *   devolucion: cliente -> BEYONIX. Contrato de DEVOLUCIONES ("Retiro y cambio
 *     de envío"), propio y distinto de los de venta:
 *       ANDREANI_{ENV}_RETURN_PICKUP_CONTRACT  -> Andreani retira en el domicilio
 *       ANDREANI_{ENV}_RETURN_DROPOFF_CONTRACT -> el cliente despacha en sucursal
 *     Sin ninguno no se llama a Andreani: queda "pendiente" con el motivo.
 *     Origen: el domicilio de entrega del pedido o la sucursal que el cliente
 *     eligió; destino: la sucursal Andreani de BEYONIX.
 *
 *   reemplazo: BEYONIX -> cliente. Reutiliza el envío de VENTA
 *     (buildAndreaniShipmentEnvio): contrato de domicilio o de sucursal según
 *     lo que el cliente eligió al comprar, origen BEYONIX, y el producto/
 *     variante realmente reemplazado (order_replacements). Nunca el contrato
 *     de devoluciones.
 *
 * Ambos: POST /v2/ordenes-de-envio con las barreras existentes
 * (ANDREANI_SHIPMENT_ENV y autorización explícita de PROD), candado en la
 * base antes de llamar a Andreani, resultado incierto -> revisión manual y
 * conciliación por un admin; nunca un segundo POST automático. No tocan stock.
 */

type AdminClient = ReturnType<typeof createAdminClient>

export type ClaimShipmentDirection = "devolucion" | "reemplazo"
export type ClaimShipmentModality = "retiro_domicilio" | "despacho_sucursal" | "entrega_domicilio" | "entrega_sucursal"
export type ClaimShipmentStatus = "pendiente" | "generada" | "en_transito" | "entregada" | "incidencia"
export type ClaimShipmentCreationStatus = "not_started" | "processing" | "created" | "failed" | "manual_review"

export interface ClaimShipmentRow {
  id: number
  claim_id: number
  order_id: number
  direction: ClaimShipmentDirection
  status: ClaimShipmentStatus
  modality: ClaimShipmentModality | null
  environment: AndreaniEnvironment | null
  contract: string | null
  andreani_envio_id: string | null
  andreani_tracking: string | null
  andreani_estado: string | null
  andreani_last_event: string | null
  andreani_last_event_at: string | null
  cost_amount: number | string | null
  creation_status: ClaimShipmentCreationStatus
  creation_error: string | null
  delivered_at: string | null
  last_checked_at: string | null
}

export interface AndreaniReturnConfig {
  shipment: AndreaniShipmentCreationConfig
  pickupContract?: string
  dropoffContract?: string
}

interface ClaimRow {
  id: number
  order_id: number
  status: string
  resolution: string | null
  affected_items: Array<{ order_item_id: number; quantity: number }> | null
}

interface ReplacementRow {
  original_order_item_id: number
  replacement_variant_id: number | null
  quantity: number
}

export const CLAIM_SHIPMENT_SELECT =
  "id, claim_id, order_id, direction, status, modality, environment, contract, andreani_envio_id, andreani_tracking, andreani_estado, andreani_last_event, andreani_last_event_at, cost_amount, creation_status, creation_error, delivered_at, last_checked_at"
const ACCEPTED_CHANGE_STATUSES = ["aprobado", "cambio_pendiente"]
const IN_PROGRESS_MESSAGE =
  "El envío Andreani ya se está generando o requiere conciliación manual antes de reintentar."
const MISSING_CUSTOMER_DATA_MESSAGE =
  "Faltan datos del cliente (nombre, email, teléfono o DNI) para generar la devolución Andreani."

function text(value: string | null | undefined) {
  return typeof value === "string" ? value.trim() : ""
}

// ── Devolución: configuración, modalidad y orden ─────────────────────────────

export function resolveAndreaniReturnConfig(env: NodeJS.ProcessEnv = process.env): AndreaniReturnConfig {
  const shipment = resolveAndreaniShipmentCreationConfig(env)
  const pickupContract = text(env[`ANDREANI_${shipment.environment}_RETURN_PICKUP_CONTRACT`]) || undefined
  const dropoffContract = text(env[`ANDREANI_${shipment.environment}_RETURN_DROPOFF_CONTRACT`]) || undefined
  if (!pickupContract && !dropoffContract) {
    throw new AndreaniError(
      "CONFIGURATION_ERROR",
      `Falta configurar el contrato de devoluciones Andreani ${shipment.environment} (retiro en domicilio o despacho en sucursal). La devolución queda pendiente.`,
    )
  }
  return { shipment, pickupContract, dropoffContract }
}

type ReturnOrder = Pick<
  AndreaniOrderRow,
  "id" | "cliente_nombre" | "cliente_email" | "cliente_telefono" | "cliente_dni" | "cliente_direccion" | "cp_destino" | "localidad" | "shipping_type" | "andreani_sucursal_id"
>

function customerPostalAddress(order: ReturnOrder) {
  const codigoPostal = text(order.cp_destino).toUpperCase()
  const localidad = text(order.localidad)
  const address = parseArgentineStreetAddress(text(order.cliente_direccion))
  if (
    !ANDREANI_POSTAL_CODE_PATTERN.test(codigoPostal) ||
    !localidad ||
    localidad.length > ANDREANI_LOCALITY_MAX_LENGTH ||
    !address.calle ||
    !address.numero ||
    address.calle.length > ANDREANI_STREET_MAX_LENGTH ||
    address.numero.length > ANDREANI_STREET_MAX_LENGTH ||
    (address.piso && address.piso.length > ANDREANI_FLOOR_MAX_LENGTH) ||
    (address.departamento && address.departamento.length > ANDREANI_APARTMENT_MAX_LENGTH)
  ) {
    return null
  }
  return {
    codigoPostal,
    calle: address.calle,
    numero: address.numero,
    piso: address.piso,
    departamento: address.departamento,
    localidad,
    pais: "Argentina",
  }
}

/**
 * Retiro en domicilio sólo si el pedido se entregó en un domicilio (dirección
 * validada del cliente) y hay contrato de retiro. Si no, despacho en
 * sucursal: la que el cliente eligió para recibir, o cualquiera desde su
 * domicilio. Nunca una sucursal elegida por BEYONIX.
 */
export function chooseClaimReturnModality(
  config: Pick<AndreaniReturnConfig, "pickupContract" | "dropoffContract">,
  order: ReturnOrder,
): { modality: "retiro_domicilio" | "despacho_sucursal"; contract: string } {
  const homeOrder = order.shipping_type === "domicilio" && customerPostalAddress(order) !== null
  if (config.pickupContract && homeOrder) {
    return { modality: "retiro_domicilio", contract: config.pickupContract }
  }
  const hasDropoffOrigin = Boolean(text(order.andreani_sucursal_id)) || homeOrder
  if (config.dropoffContract && hasDropoffOrigin) {
    return { modality: "despacho_sucursal", contract: config.dropoffContract }
  }
  throw new AndreaniError(
    "VALIDATION_ERROR",
    config.pickupContract && !config.dropoffContract
      ? "El retiro en domicilio requiere que el pedido tenga un domicilio de entrega completo."
      : "No hay un origen válido del cliente (domicilio de entrega o sucursal elegida) para la devolución.",
  )
}

export function buildClaimReturnEnvio(
  order: ReturnOrder,
  claimId: number,
  config: AndreaniReturnConfig,
  choice: { modality: "retiro_domicilio" | "despacho_sucursal"; contract: string },
): Omit<AndreaniCreateShipmentRequest, "bultos"> {
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

  // Despacho: desde la sucursal que el cliente eligió para recibir el pedido;
  // si lo recibió en su domicilio, desde ahí (lo lleva a una sucursal).
  const branchId = text(order.andreani_sucursal_id)
  let origen: AndreaniCreateShipmentRequest["origen"]
  if (choice.modality === "despacho_sucursal" && branchId) {
    origen = { sucursal: { id: branchId } }
  } else {
    const postal = customerPostalAddress(order)
    if (!postal) {
      throw new AndreaniError("VALIDATION_ERROR", "El domicilio del cliente está incompleto para la devolución.")
    }
    origen = { postal }
  }

  const { shipment } = config
  return {
    contrato: choice.contract,
    idPedido: `${order.id}-R${claimId}`,
    origen,
    destino: { sucursal: { id: shipment.sucursalOrigenId } },
    // En la devolución el cliente envía y BEYONIX recibe.
    remitente: {
      nombreCompleto,
      email,
      documentoTipo: "DNI",
      documentoNumero: dni,
      // Celular = 1 para remitente.
      telefonos: [{ tipo: 1, numero: telefono }],
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

// ── Reemplazo: contrato de venta según lo elegido al comprar ──────────────────

export function chooseReplacementShipment(
  config: AndreaniShipmentCreationConfig,
  order: Pick<AndreaniOrderRow, "shipping_type">,
): { modality: "entrega_domicilio" | "entrega_sucursal"; contract: string } {
  if (order.shipping_type === "sucursal") {
    if (!config.sucursalContrato) {
      throw new AndreaniError("CONFIGURATION_ERROR", "Falta configurar el contrato de entrega en sucursal de Andreani.")
    }
    return { modality: "entrega_sucursal", contract: config.sucursalContrato }
  }
  if (order.shipping_type === "domicilio") {
    return { modality: "entrega_domicilio", contract: config.domicilioContrato }
  }
  throw new AndreaniError("VALIDATION_ERROR", "El pedido no tiene una entrega Andreani (domicilio o sucursal) para enviar el reemplazo.")
}

// ── Creación idempotente (ambos tramos) ──────────────────────────────────────

export interface ClaimShipmentCreationDependencies {
  env?: NodeJS.ProcessEnv
  crearOrdenEnvio?: typeof crearOrdenEnvio
  getAndreaniCommercialSettings?: () => Promise<AndreaniCommercialSettings>
}

export interface ClaimShipmentCreationResult {
  status: "created" | "reused"
  shipment: ClaimShipmentRow
}

interface PreparedClaimShipment {
  environment: AndreaniEnvironment
  modality: ClaimShipmentModality
  contract: string
  envio: Omit<AndreaniCreateShipmentRequest, "bultos">
  packageData: ReturnType<typeof aggregateAndreaniPackage>
  reference: string
  description: string
}

async function rpcShipment(admin: AdminClient, name: string, args: Record<string, unknown>): Promise<ClaimShipmentRow | null> {
  const { data, error } = await admin.rpc(name, args)
  if (error) {
    throw new AndreaniError("REQUEST_FAILED", /NOT_READY/.test(error.message)
      ? "El reemplazo todavía no está registrado para todas las unidades reclamadas."
      : "No se pudo registrar el envío Andreani del reclamo.")
  }
  const row = Array.isArray(data) ? data[0] : data
  return (row && typeof row === "object" && "claim_id" in row && row.claim_id !== null ? row : null) as ClaimShipmentRow | null
}

async function loadShipment(admin: AdminClient, claimId: number, direction: ClaimShipmentDirection) {
  const { data, error } = await admin
    .from("order_claim_shipments")
    .select(CLAIM_SHIPMENT_SELECT)
    .eq("claim_id", claimId)
    .eq("direction", direction)
    .maybeSingle()
  if (error) throw new AndreaniError("REQUEST_FAILED", "No se pudo leer el envío del reclamo.")
  return (data ?? null) as ClaimShipmentRow | null
}

/** Rechazo explícito de Andreani (la operación NO se creó) vs resultado desconocido. */
function isDefinitiveCreationFailure(error: unknown) {
  if (!(error instanceof AndreaniError)) return false
  if (error.code === "VALIDATION_ERROR" || error.code === "CONFIGURATION_ERROR") return true
  return error.code === "REQUEST_FAILED" && error.status !== null && error.status >= 400 && error.status < 500
}

async function prepareReturn(
  admin: AdminClient,
  claim: ClaimRow,
  env: NodeJS.ProcessEnv,
): Promise<PreparedClaimShipment> {
  const config = resolveAndreaniReturnConfig(env)
  assertAndreaniProdShipmentCreationAuthorized(config.shipment.environment, env)
  const { data, error } = await admin.from("ordenes").select(ANDREANI_ORDER_SELECT).eq("id", claim.order_id).maybeSingle()
  if (error || !data) throw new AndreaniError("VALIDATION_ERROR", "No encontramos el pedido del reclamo.")
  const order = data as unknown as AndreaniOrderRow
  const quantities = new Map<number, number>()
  for (const item of claim.affected_items ?? []) {
    quantities.set(Number(item.order_item_id), (quantities.get(Number(item.order_item_id)) ?? 0) + Number(item.quantity))
  }
  if (!quantities.size) throw new AndreaniError("VALIDATION_ERROR", "El reclamo no tiene productos a devolver.")
  const choice = chooseClaimReturnModality(config, order)
  return {
    environment: config.shipment.environment,
    modality: choice.modality,
    contract: choice.contract,
    envio: buildClaimReturnEnvio(order, claim.id, config, choice),
    packageData: aggregateAndreaniPackage(await loadOrderShipmentItems(admin, order.id, quantities)),
    reference: `${order.id}-R${claim.id}`,
    description: `Devolución reclamo ${claim.id} · Pedido BX-${1000 + order.id}`,
  }
}

async function prepareReplacement(
  admin: AdminClient,
  claim: ClaimRow,
  env: NodeJS.ProcessEnv,
): Promise<PreparedClaimShipment> {
  const config = resolveAndreaniShipmentCreationConfig(env)
  assertAndreaniProdShipmentCreationAuthorized(config.environment, env)
  const [{ data: orderData, error: orderError }, { data: replacementData, error: replacementError }] = await Promise.all([
    admin.from("ordenes").select(ANDREANI_ORDER_SELECT).eq("id", claim.order_id).maybeSingle(),
    admin.from("order_replacements").select("original_order_item_id, replacement_variant_id, quantity").eq("claim_id", claim.id),
  ])
  if (orderError || !orderData) throw new AndreaniError("VALIDATION_ERROR", "No encontramos el pedido del reclamo.")
  if (replacementError) throw new AndreaniError("REQUEST_FAILED", "No se pudieron leer los reemplazos del reclamo.")
  const order = orderData as unknown as AndreaniOrderRow
  const replacements = (replacementData ?? []) as ReplacementRow[]
  const claimedUnits = (claim.affected_items ?? []).reduce((sum, item) => sum + Number(item.quantity), 0)
  const replacedUnits = replacements.reduce((sum, row) => sum + Number(row.quantity), 0)
  if (!replacements.length || replacedUnits < claimedUnits) {
    throw new AndreaniError("VALIDATION_ERROR", "El reemplazo todavía no está registrado para todas las unidades reclamadas.")
  }
  // Producto/variante realmente despachado (con salida de stock ya registrada).
  const quantities = new Map<number, number>()
  const variants = new Map<number, number>()
  for (const row of replacements) {
    const itemId = Number(row.original_order_item_id)
    quantities.set(itemId, (quantities.get(itemId) ?? 0) + Number(row.quantity))
    if (row.replacement_variant_id != null) {
      const previous = variants.get(itemId)
      if (previous !== undefined && previous !== Number(row.replacement_variant_id)) {
        throw new AndreaniError("VALIDATION_ERROR", "El reemplazo usa varias variantes para un mismo producto: generá el envío manualmente.")
      }
      variants.set(itemId, Number(row.replacement_variant_id))
    }
  }
  const choice = chooseReplacementShipment(config, order)
  // Mismo armado que el envío de venta (origen BEYONIX, destino elegido al
  // comprar, remitente/destinatario), con su propio identificador de pedido.
  const envio = { ...buildAndreaniShipmentEnvio(order, config), contrato: choice.contract, idPedido: `${order.id}-C${claim.id}` }
  return {
    environment: config.environment,
    modality: choice.modality,
    contract: choice.contract,
    envio,
    packageData: aggregateAndreaniPackage(await loadOrderShipmentItems(admin, order.id, quantities, variants)),
    reference: `${order.id}-C${claim.id}`,
    description: `Reemplazo reclamo ${claim.id} · Pedido BX-${1000 + order.id}`,
  }
}

async function createClaimShipment(
  admin: AdminClient,
  claimId: number,
  direction: ClaimShipmentDirection,
  dependencies: ClaimShipmentCreationDependencies,
): Promise<ClaimShipmentCreationResult> {
  const env = dependencies.env ?? process.env
  const [{ data: claimData, error: claimError }, current] = await Promise.all([
    admin.from("order_claims").select("id, order_id, status, resolution, affected_items").eq("id", claimId).maybeSingle(),
    loadShipment(admin, claimId, direction),
  ])
  if (claimError) throw new AndreaniError("REQUEST_FAILED", "No se pudo leer el reclamo.")
  const claim = claimData as ClaimRow | null
  if (!claim) throw new AndreaniError("VALIDATION_ERROR", "No encontramos el reclamo.")
  if (current?.creation_status === "created") return { status: "reused", shipment: current }
  if (current?.creation_status === "processing" || current?.creation_status === "manual_review") {
    throw new AndreaniError("REQUEST_FAILED", IN_PROGRESS_MESSAGE)
  }
  if (claim.resolution !== "cambio_producto" || !ACCEPTED_CHANGE_STATUSES.includes(claim.status)) {
    throw new AndreaniError("VALIDATION_ERROR", "El reclamo ya no tiene un cambio aceptado.")
  }
  if (direction === "devolucion" && !current) {
    throw new AndreaniError("VALIDATION_ERROR", "La devolución se genera cuando BEYONIX acepta el cambio del producto.")
  }

  // Todo lo que puede fallar ANTES de hablar con Andreani queda visible como
  // motivo del envío pendiente, sin tomar el candado.
  let prepared: PreparedClaimShipment
  try {
    const settings = await (dependencies.getAndreaniCommercialSettings ?? getAndreaniCommercialSettings)()
      .catch(() => DEFAULT_ANDREANI_COMMERCIAL_SETTINGS)
    if (!settings.enabled) throw new AndreaniError("PROVIDER_DISABLED", ANDREANI_PROVIDER_DISABLED_MESSAGE)
    prepared = direction === "devolucion"
      ? await prepareReturn(admin, claim, env)
      : await prepareReplacement(admin, claim, env)
  } catch (error) {
    await rpcShipment(admin, "fail_order_claim_shipment_creation", {
      p_claim_id: claimId, p_direction: direction, p_token: null,
      p_error: normalizeAndreaniError(error, env).message, p_outcome: "blocked",
    }).catch(() => null)
    throw error
  }

  const token = randomUUID()
  const claimed = await rpcShipment(admin, "claim_order_claim_shipment_creation", {
    p_claim_id: claimId, p_direction: direction, p_token: token,
    p_environment: prepared.environment, p_modality: prepared.modality, p_contract: prepared.contract,
  })
  if (!claimed) throw new AndreaniError("REQUEST_FAILED", IN_PROGRESS_MESSAGE)
  if (claimed.creation_status === "created") return { status: "reused", shipment: claimed }

  let envioId: string
  let tracking: string | null
  let estado: string
  try {
    const response = await crearOrdenEnvioConReintentoDeAutenticacion(
      dependencies.crearOrdenEnvio ?? crearOrdenEnvio,
      {
        envio: prepared.envio,
        items: [{
          producto: buildConsolidatedProduct(claim.order_id, prepared.packageData),
          bulto: {
            volumenCm: prepared.packageData.volumenCm3,
            valorDeclaradoConImpuestos: prepared.packageData.valorDeclarado,
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
      p_claim_id: claimId, p_direction: direction, p_token: token,
      p_error: formatAndreaniErrorForPersistence(normalizeAndreaniError(error, env)),
      p_outcome: isDefinitiveCreationFailure(error) ? "failed" : "manual_review",
    }).catch(() => null)
    throw error
  }

  try {
    const completed = await rpcShipment(admin, "complete_order_claim_shipment_creation", {
      p_claim_id: claimId, p_direction: direction, p_token: token,
      p_envio_id: envioId, p_tracking: tracking, p_estado: estado,
      // POST /v2/ordenes-de-envio no informa costo: no se inventa uno.
      p_cost_amount: null,
    })
    if (!completed) throw new Error("sin fila")
    return { status: "created", shipment: completed }
  } catch {
    // Andreani SÍ creó la operación: nunca se marca como reintentable.
    await rpcShipment(admin, "fail_order_claim_shipment_creation", {
      p_claim_id: claimId, p_direction: direction, p_token: token,
      p_error: `Andreani creó la orden ${envioId} pero no se pudo guardar. Conciliar con ese número; no reintentar.`,
      p_outcome: "manual_review",
    }).catch(() => null)
    throw new AndreaniError("REQUEST_FAILED", `Andreani creó la orden ${envioId}, pero no se pudo guardar. Requiere conciliación.`)
  }
}

/** Devolución (cliente -> BEYONIX). Doble click / reintento: una sola operación. */
export function createAndreaniReturnForClaim(
  admin: AdminClient,
  claimId: number,
  dependencies: ClaimShipmentCreationDependencies = {},
) {
  return createClaimShipment(admin, claimId, "devolucion", dependencies)
}

/** Reemplazo (BEYONIX -> cliente). No toca stock: ya salió con create_order_replacement. */
export function createAndreaniReplacementShipmentForClaim(
  admin: AdminClient,
  claimId: number,
  dependencies: ClaimShipmentCreationDependencies = {},
) {
  return createClaimShipment(admin, claimId, "reemplazo", dependencies)
}

// ── Conciliación manual ──────────────────────────────────────────────────────

export interface ClaimShipmentReconciliation {
  claimId: number
  direction: ClaimShipmentDirection
  actorId: string
  resolution: "created" | "not_created"
  envioId?: string
  notes: string
}

/**
 * Tras un resultado incierto: "created" se verifica primero contra Andreani
 * (sólo lectura, en el ambiente del tramo); "not_created" libera el tramo
 * para volver a generarlo. Nunca reintenta el POST.
 */
export async function reconcileClaimShipment(
  admin: AdminClient,
  input: ClaimShipmentReconciliation,
  dependencies: { getEstadoOrden?: typeof getEstadoOrden } = {},
) {
  const current = await loadShipment(admin, input.claimId, input.direction)
  if (!current) throw new AndreaniError("VALIDATION_ERROR", "El reclamo no tiene ese envío.")
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
    p_claim_id: input.claimId, p_direction: input.direction, p_actor_id: input.actorId,
    p_resolution: input.resolution, p_envio_id: input.resolution === "created" ? text(input.envioId) : null,
    p_tracking: tracking, p_notes: input.notes,
  })
  if (!updated) throw new AndreaniError("REQUEST_FAILED", "No se pudo conciliar el envío del reclamo.")
  return updated
}

// ── Etiqueta ─────────────────────────────────────────────────────────────────

/** Etiqueta PDF de un tramo ya creado, en el ambiente donde se creó. Nunca pública. */
export async function getClaimShipmentLabel(
  shipment: Pick<ClaimShipmentRow, "andreani_envio_id" | "environment" | "creation_status">,
  dependencies: { getEtiquetas?: typeof getEtiquetas } = {},
): Promise<AndreaniLabelResponse> {
  const envioId = text(shipment.andreani_envio_id)
  if (shipment.creation_status !== "created" || !envioId || !shipment.environment) {
    throw new AndreaniError("VALIDATION_ERROR", "Todavía no hay una orden Andreani para este envío.")
  }
  return (dependencies.getEtiquetas ?? getEtiquetas)(envioId, "pdf", {
    env: { ...process.env, ANDREANI_ENV: shipment.environment },
    productionAccess: shipment.environment === "PROD" ? "shipment-read" : undefined,
  })
}

// ── Tracking ─────────────────────────────────────────────────────────────────

export type ClaimShipmentTrackingPhase = "sin_cambio" | "en_transito" | "entregada" | "incidencia"

/**
 * Fase del tramo a partir de los eventos ESTABLES de Andreani (mismo mapping
 * canónico que el envío del pedido). "Entregado" = en BEYONIX (devolución) o
 * al cliente (reemplazo).
 */
export function resolveClaimShipmentPhase(
  eventos: readonly Pick<AndreaniTrackingEvent, "Evento" | "Fecha">[],
  rejectedAfterCreation: boolean,
): ClaimShipmentTrackingPhase {
  if (eventos.some((event) => event.Evento === "EnvioEntregado")) return "entregada"
  if (rejectedAfterCreation) return "incidencia"
  const meaningful = [...eventos]
    .map((event) => ({ event, phase: mapAndreaniEventToLogisticsPhase(event.Evento) }))
    .filter(({ phase }) => phase !== "orden_creada" && phase !== "interno")
    .sort((left, right) =>
      Date.parse(parseAndreaniTimestamp(right.event.Fecha)) - Date.parse(parseAndreaniTimestamp(left.event.Fecha)))
  const latest = meaningful[0]?.phase
  if (!latest) return "sin_cambio"
  return latest === "en_camino" || latest === "en_distribucion" ? "en_transito" : "incidencia"
}

export interface ClaimShipmentTrackingDependencies {
  fetchSnapshot?: typeof fetchAndreaniOrderTrackingSnapshot
}

/** Consulta Andreani (sólo GET) y avanza el tramo. Idempotente. */
export async function syncClaimShipmentTracking(
  admin: AdminClient,
  shipment: Pick<ClaimShipmentRow, "claim_id" | "direction" | "andreani_envio_id" | "andreani_tracking" | "environment" | "creation_status">,
  dependencies: ClaimShipmentTrackingDependencies = {},
): Promise<{ shipment: ClaimShipmentRow; phase: ClaimShipmentTrackingPhase; snapshot: AndreaniOrderTrackingSnapshot }> {
  if (shipment.creation_status !== "created" || !text(shipment.andreani_envio_id)) {
    throw new AndreaniError("VALIDATION_ERROR", "El envío todavía no tiene una orden Andreani.")
  }
  const snapshot = await (dependencies.fetchSnapshot ?? fetchAndreaniOrderTrackingSnapshot)({
    andreani_envio_id: shipment.andreani_envio_id,
    andreani_tracking: shipment.andreani_tracking,
    // Tracking contra el ambiente donde se creó, nunca el configurado hoy.
    andreani_creation_environment: shipment.environment,
  })
  const phase = resolveClaimShipmentPhase(snapshot.eventos, snapshot.rejectedAfterCreation)
  const updated = await rpcShipment(admin, "apply_order_claim_shipment_tracking", {
    p_claim_id: shipment.claim_id,
    p_direction: shipment.direction,
    p_phase: phase,
    p_estado: snapshot.logisticsEstado,
    p_tracking: snapshot.resolvedTracking,
    p_last_event: snapshot.latestEvent?.Evento ?? null,
    p_last_event_at: snapshot.latestEvent ? parseAndreaniTimestamp(snapshot.latestEvent.Fecha) : null,
  })
  if (!updated) throw new AndreaniError("REQUEST_FAILED", "No se pudo actualizar el seguimiento.")
  return { shipment: updated, phase, snapshot }
}

/** Cron: tramos abiertos (ida y vuelta), los menos consultados primero. */
export async function runClaimShipmentTrackingBatch(
  admin: AdminClient,
  { limit = 20, ...dependencies }: ClaimShipmentTrackingDependencies & { limit?: number } = {},
) {
  const { data, error } = await admin
    .from("order_claim_shipments")
    .select(CLAIM_SHIPMENT_SELECT)
    .eq("creation_status", "created")
    .in("status", ["generada", "en_transito", "incidencia"])
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .limit(limit)
  if (error) throw new AndreaniError("REQUEST_FAILED", "No se pudieron leer los envíos de reclamos a seguir.")
  let updated = 0
  let delivered = 0
  let failed = 0
  for (const row of (data ?? []) as ClaimShipmentRow[]) {
    const previousStatus = row.status
    try {
      const result = await syncClaimShipmentTracking(admin, row, dependencies)
      updated += 1
      if (result.shipment.status === "entregada" && previousStatus !== "entregada") delivered += 1
    } catch (syncError) {
      failed += 1
      console.error("ANDREANI_CLAIM_SHIPMENT_TRACKING_ERROR", {
        claimId: row.claim_id,
        direction: row.direction,
        ...normalizeAndreaniError(syncError),
      })
    }
  }
  return { checked: (data ?? []).length, updated, delivered, failed }
}
