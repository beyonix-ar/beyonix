import "server-only"

import { randomUUID } from "node:crypto"

import type { createAdminClient } from "../supabase/admin.ts"
import { isOrderPaymentConfirmed } from "../orders/order-payment-status.ts"
import type { ProductLogisticsSource } from "../shipping/product-logistics.ts"

import {
  AndreaniError,
  crearOrdenEnvio,
  normalizeAndreaniError,
  sanitizeAndreaniMessage,
  type AndreaniProductionAccess,
} from "./client.ts"
import {
  aggregateAndreaniPackage,
  resolveAndreaniCheckoutConfig,
  type AggregatedAndreaniPackage,
  type LoadedCheckoutQuoteItem,
} from "./checkout-quote.ts"
import type {
  AndreaniCreateShipmentInput,
  AndreaniCreateShipmentRequest,
  AndreaniCreateShipmentResponse,
  AndreaniEnvironment,
} from "./types.ts"

type AdminClient = ReturnType<typeof createAdminClient>

const ORDER_SELECT =
  "id, cliente_nombre, cliente_email, cliente_telefono, cliente_dni, cliente_direccion, cp_destino, localidad, provincia, shipping_type, estado, payment_status, paid_at, financial_status, andreani_envio_id, andreani_tracking, andreani_etiqueta_url, andreani_estado"
const ORDER_ITEM_SELECT =
  "producto_id, variante_id, conditioned_stock_id, cantidad, precio"
const PRODUCT_SELECT =
  "id, nombre, sku, peso_empaquetado_kg, alto_paquete_cm, ancho_paquete_cm, largo_paquete_cm"
const VARIANT_SELECT =
  "id, producto_id, nombre, sku, peso_empaquetado_kg, alto_paquete_cm, ancho_paquete_cm, largo_paquete_cm"

const CANCELLED_FINANCIAL_STATUSES = ["cancelled", "refund_pending", "refunded"]
const CREATION_IN_PROGRESS_MESSAGE =
  "La generación del envío ya está en curso o requiere conciliación manual antes de reintentar."
const SUCURSAL_BLOCKED_MESSAGE =
  "El pedido eligió retiro en sucursal y todavía no persiste la sucursal elegida. Generá el envío únicamente para pedidos con entrega a domicilio."
const MISSING_LOGISTICS_MESSAGE =
  "Al pedido le falta información logística (dirección, localidad, provincia o código postal) para generar el envío."
const PROD_SHIPMENT_CREATION_BLOCKED_MESSAGE =
  "La creación de envíos en PROD requiere ANDREANI_SHIPMENT_ENV=PROD y ANDREANI_ALLOW_PROD_SHIPMENT_CREATION=true explícitamente configurados."

export interface AndreaniOrderRow {
  id: number
  cliente_nombre: string | null
  cliente_email: string | null
  cliente_telefono: string | null
  cliente_dni: string | null
  cliente_direccion: string | null
  cp_destino: string | null
  localidad: string | null
  provincia: string | null
  shipping_type: string | null
  estado: string | null
  payment_status: string | null
  paid_at: string | null
  financial_status: string | null
  andreani_envio_id: string | null
  andreani_tracking: string | null
  andreani_etiqueta_url: string | null
  andreani_estado: string | null
}

interface OrderItemRow {
  producto_id: number
  variante_id: number | null
  conditioned_stock_id: string | null
  cantidad: number
  precio: number
}

interface ConditionedRow {
  id: string
  product_id: number
  source_variant_id: number | null
}

interface ProductRow extends ProductLogisticsSource {
  precio?: number
}

interface VariantRow extends ProductLogisticsSource {
  producto_id: number
}

export interface AndreaniShipmentCreationConfig {
  environment: AndreaniEnvironment
  cliente: string
  domicilioContrato: string
  sucursalOrigen: string
  remitenteNombre: string
  remitenteEmail?: string
  remitenteTelefono?: string
  remitenteDocumentoTipo?: string
  remitenteDocumentoNumero?: string
}

export interface AndreaniShipmentCreationResult {
  status: "reused" | "created"
  envioId: string
  tracking: string | null
  etiquetaUrl: string | null
  estado: string
}

interface AndreaniShipmentCreationDependencies {
  env?: NodeJS.ProcessEnv
  now?: () => Date
  crearOrdenEnvio?: typeof crearOrdenEnvio
}

function requiredText(value: string | undefined | null) {
  return typeof value === "string" ? value.trim() : ""
}

function optionalText(value: string | undefined | null) {
  const normalized = requiredText(value)
  return normalized || undefined
}

function normalizePhoneNumber(value: string | null) {
  const digits = requiredText(value).replace(/\D/g, "")
  return digits || undefined
}

const STREET_NUMBER_PATTERN = /^(.*\S)\s+(\d{1,6}\s*(?:bis)?)$/i
const FLOOR_PATTERN = /\bpiso\s*n?°?\s*:?\s*([0-9a-záéíóúñ]+)/i
const APARTMENT_PATTERN =
  /\b(?:depto|dpto|departamento|apto|apartamento)\s*n?°?\s*:?\s*([0-9a-záéíóúñ]+)/i

export interface ParsedStreetAddress {
  calle: string
  numero: string
  piso?: string
  departamento?: string
}

/**
 * BEYONIX persiste la dirección de checkout como texto libre en un único
 * campo. Andreani B2C exige calle/numero (y opcionalmente piso/depto) por
 * separado, así que este parser hace una extracción best-effort sin tocar
 * el checkout congelado.
 */
export function parseArgentineStreetAddress(raw: string): ParsedStreetAddress {
  const normalized = raw.trim().replace(/\s+/g, " ")
  const [mainSegment, ...extraSegments] = normalized
    .split(",")
    .map((segment) => segment.trim())
    .filter(Boolean)
  const extraText = extraSegments.join(" ")

  const floorMatch = extraText.match(FLOOR_PATTERN) ?? normalized.match(FLOOR_PATTERN)
  const apartmentMatch =
    extraText.match(APARTMENT_PATTERN) ?? normalized.match(APARTMENT_PATTERN)

  const streetSource = (mainSegment ?? normalized)
    .replace(FLOOR_PATTERN, "")
    .replace(APARTMENT_PATTERN, "")
    .trim()
  const numberMatch = streetSource.match(STREET_NUMBER_PATTERN)

  return {
    calle: (numberMatch ? numberMatch[1] : streetSource).trim(),
    numero: numberMatch?.[2]?.trim() ?? "",
    piso: floorMatch?.[1],
    departamento: apartmentMatch?.[1],
  }
}

/**
 * Ambiente de CREACIÓN de envíos: independiente de ANDREANI_ENV (login
 * genérico) y de ANDREANI_TARIFF_ENV (cotización, hoy forzada a PROD por
 * pedido de Andreani mientras QA es inestable). Si no está configurado,
 * el valor por defecto es QA (el más restrictivo) para que nunca alcance
 * PROD por omisión.
 */
export function resolveAndreaniShipmentEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): AndreaniEnvironment {
  const raw = requiredText(env.ANDREANI_SHIPMENT_ENV).toUpperCase()
  if (!raw) return "QA"

  if (raw !== "QA" && raw !== "PROD") {
    throw new AndreaniError(
      "CONFIGURATION_ERROR",
      "ANDREANI_SHIPMENT_ENV debe ser QA o PROD.",
    )
  }

  return raw
}

/**
 * Segunda barrera, independiente de ANDREANI_SHIPMENT_ENV: aunque alguien
 * configure ANDREANI_SHIPMENT_ENV=PROD por error, la creación en PROD
 * también exige esta autorización explícita. No reutiliza
 * productionAccess:"tariffs-only" -- es una autorización separada que el
 * cliente Andreani sólo otorga para POST /v2/ordenes-de-envio.
 */
export function assertAndreaniProdShipmentCreationAuthorized(
  environment: AndreaniEnvironment,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (environment !== "PROD") return

  if (requiredText(env.ANDREANI_ALLOW_PROD_SHIPMENT_CREATION).toLowerCase() !== "true") {
    throw new AndreaniError("PRODUCTION_BLOCKED", PROD_SHIPMENT_CREATION_BLOCKED_MESSAGE)
  }
}

export function resolveAndreaniShipmentCreationConfig(
  env: NodeJS.ProcessEnv = process.env,
): AndreaniShipmentCreationConfig {
  const environment = resolveAndreaniShipmentEnvironment(env)
  const checkoutConfig = resolveAndreaniCheckoutConfig({
    ...env,
    ANDREANI_ENV: environment,
    ANDREANI_TARIFF_ENV: environment,
  })

  if (checkoutConfig.environment !== environment) {
    // Defensivo: resolveAndreaniCheckoutConfig siempre debería reflejar el
    // override anterior; si no lo hace, no hay que continuar a ciegas.
    throw new AndreaniError(
      "CONFIGURATION_ERROR",
      "No se pudo resolver el ambiente de creación de Andreani.",
    )
  }

  if (!checkoutConfig.domicilioContrato) {
    throw new AndreaniError(
      "CONFIGURATION_ERROR",
      `Falta configurar el contrato de domicilio de Andreani ${environment} para crear envíos.`,
    )
  }

  const remitenteNombre = requiredText(env.ANDREANI_REMITENTE_NOMBRE) || "BEYONIX"
  const remitenteEmail = optionalText(env.ANDREANI_REMITENTE_EMAIL)
  const remitenteTelefono = normalizePhoneNumber(env.ANDREANI_REMITENTE_TELEFONO ?? null)
  const remitenteDocumentoTipo = optionalText(
    env.ANDREANI_REMITENTE_DOCUMENTO_TIPO,
  )?.toUpperCase()
  const remitenteDocumentoNumero = optionalText(
    env.ANDREANI_REMITENTE_DOCUMENTO_NUMERO,
  )

  if (
    remitenteNombre.length > 40 ||
    (remitenteEmail && remitenteEmail.length > 40) ||
    (remitenteTelefono &&
      (remitenteTelefono.length < 8 || remitenteTelefono.length > 15)) ||
    Boolean(remitenteDocumentoTipo) !== Boolean(remitenteDocumentoNumero) ||
    (remitenteDocumentoTipo &&
      !["DNI", "CUIT", "CUIL"].includes(remitenteDocumentoTipo)) ||
    (remitenteDocumentoNumero && remitenteDocumentoNumero.length > 20)
  ) {
    throw new AndreaniError(
      "CONFIGURATION_ERROR",
      "La configuración del remitente Andreani no es válida.",
    )
  }

  return {
    environment,
    cliente: checkoutConfig.cliente,
    domicilioContrato: checkoutConfig.domicilioContrato,
    sucursalOrigen: checkoutConfig.sucursalOrigen,
    remitenteNombre,
    remitenteEmail,
    remitenteTelefono,
    remitenteDocumentoTipo,
    remitenteDocumentoNumero,
  }
}

function assertShipmentEligibleOrder(order: AndreaniOrderRow) {
  if (
    order.estado === "cancelado" ||
    CANCELLED_FINANCIAL_STATUSES.includes(order.financial_status ?? "")
  ) {
    throw new AndreaniError(
      "VALIDATION_ERROR",
      "No se puede generar el envío de un pedido cancelado o con reintegro en curso.",
    )
  }

  if (!isOrderPaymentConfirmed(order)) {
    throw new AndreaniError(
      "VALIDATION_ERROR",
      "El pedido todavía no tiene el pago confirmado.",
    )
  }
}

export function buildAndreaniShipmentEnvio(
  order: AndreaniOrderRow,
  config: AndreaniShipmentCreationConfig,
): Omit<AndreaniCreateShipmentRequest, "bultos"> {
  if (order.shipping_type === "sucursal") {
    throw new AndreaniError("VALIDATION_ERROR", SUCURSAL_BLOCKED_MESSAGE)
  }

  const cpDestino = requiredText(order.cp_destino).toUpperCase()
  const localidad = requiredText(order.localidad)
  const provincia = requiredText(order.provincia)
  const direccion = requiredText(order.cliente_direccion)
  const nombreCompleto = requiredText(order.cliente_nombre)
  const email = requiredText(order.cliente_email)
  const telefono = normalizePhoneNumber(order.cliente_telefono)
  const dni = requiredText(order.cliente_dni)

  if (
    order.shipping_type !== "domicilio" ||
    !/^\d{4}$/.test(cpDestino) ||
    !localidad ||
    !provincia ||
    !direccion ||
    !nombreCompleto ||
    nombreCompleto.length > 40 ||
    !email ||
    email.length > 40 ||
    !telefono ||
    telefono.length < 8 ||
    telefono.length > 15 ||
    !/^\d{7,8}$/.test(dni)
  ) {
    throw new AndreaniError("VALIDATION_ERROR", MISSING_LOGISTICS_MESSAGE)
  }

  const address = parseArgentineStreetAddress(direccion)
  if (
    !address.calle ||
    !address.numero ||
    address.calle.length > 40 ||
    address.numero.length > 40 ||
    (address.piso && address.piso.length > 40) ||
    (address.departamento && address.departamento.length > 40) ||
    localidad.length > 40
  ) {
    throw new AndreaniError("VALIDATION_ERROR", MISSING_LOGISTICS_MESSAGE)
  }

  return {
    contrato: config.domicilioContrato,
    idPedido: String(order.id),
    origen: {
      sucursal: { id: config.sucursalOrigen },
    },
    destino: {
      postal: {
        codigoPostal: cpDestino,
        calle: address.calle,
        numero: address.numero,
        piso: address.piso,
        departamento: address.departamento,
        localidad,
        pais: "Argentina",
      },
    },
    remitente: {
      nombreCompleto: config.remitenteNombre,
      email: config.remitenteEmail,
      documentoTipo: config.remitenteDocumentoTipo,
      documentoNumero: config.remitenteDocumentoNumero,
      // Celular = 1 para remitente (Trabajo = 0, Casa = 2, Otros = 3).
      telefonos: config.remitenteTelefono
        ? [{ tipo: 1, numero: config.remitenteTelefono }]
        : undefined,
    },
    destinatario: [
      {
        nombreCompleto,
        email,
        documentoTipo: "DNI",
        documentoNumero: dni,
        // Celular = 2 para destinatario (Trabajo = 1, Casa = 3, Otros = 4).
        telefonos: [{ tipo: 2, numero: telefono }],
      },
    ],
  }
}

function buildConsolidatedProduct(
  orderId: number,
  packageData: AggregatedAndreaniPackage,
): ProductLogisticsSource {
  const hasExactDimensions =
    packageData.altoCm !== undefined &&
    packageData.anchoCm !== undefined &&
    packageData.largoCm !== undefined
  const cubicSide = hasExactDimensions
    ? 0
    : Math.cbrt(packageData.volumenCm3)

  return {
    id: 0,
    nombre: `Pedido BX-${1000 + orderId}`,
    peso_empaquetado_kg: packageData.pesoKg,
    alto_paquete_cm: hasExactDimensions ? packageData.altoCm! : cubicSide,
    ancho_paquete_cm: hasExactDimensions ? packageData.anchoCm! : cubicSide,
    largo_paquete_cm: hasExactDimensions ? packageData.largoCm! : cubicSide,
  }
}

async function loadOrderShipmentItems(
  admin: AdminClient,
  orderId: number,
): Promise<LoadedCheckoutQuoteItem[]> {
  const { data: orderItems, error: itemsError } = await admin
    .from("orden_items")
    .select(ORDER_ITEM_SELECT)
    .eq("orden_id", orderId)

  if (itemsError) {
    throw new AndreaniError(
      "REQUEST_FAILED",
      "No se pudieron obtener los productos del pedido.",
    )
  }

  const items = (orderItems ?? []) as unknown as OrderItemRow[]
  if (!items.length) {
    throw new AndreaniError(
      "VALIDATION_ERROR",
      "El pedido no tiene productos para generar el envío.",
    )
  }

  const productIds = [...new Set(items.map((item) => item.producto_id))]
  const conditionedIds = items
    .map((item) => item.conditioned_stock_id)
    .filter((id): id is string => Boolean(id))

  const [productsResult, conditionedResult] = await Promise.all([
    admin.from("productos").select(PRODUCT_SELECT).in("id", productIds),
    conditionedIds.length
      ? admin
          .from("conditioned_inventory_offers")
          .select("id, product_id, source_variant_id")
          .in("id", conditionedIds)
      : Promise.resolve({ data: [], error: null }),
  ])

  if (productsResult.error || conditionedResult.error) {
    throw new AndreaniError(
      "REQUEST_FAILED",
      "No se pudieron obtener los datos logísticos del pedido.",
    )
  }

  const conditionedRows = (conditionedResult.data ?? []) as unknown as ConditionedRow[]
  const variantIds = [
    ...new Set([
      ...items.map((item) => item.variante_id).filter((id): id is number => id !== null),
      ...conditionedRows
        .map((row) => row.source_variant_id)
        .filter((id): id is number => id !== null),
    ]),
  ]
  const variantsResult = variantIds.length
    ? await admin.from("producto_variantes").select(VARIANT_SELECT).in("id", variantIds)
    : { data: [], error: null }

  if (variantsResult.error) {
    throw new AndreaniError(
      "REQUEST_FAILED",
      "No se pudieron obtener las variantes del pedido.",
    )
  }

  const productMap = new Map(
    ((productsResult.data ?? []) as unknown as ProductRow[]).map((row) => [
      Number(row.id),
      { ...row, id: Number(row.id) },
    ]),
  )
  const variantMap = new Map(
    ((variantsResult.data ?? []) as unknown as VariantRow[]).map((row) => [
      Number(row.id),
      { ...row, id: Number(row.id), producto_id: Number(row.producto_id) },
    ]),
  )
  const conditionedMap = new Map(conditionedRows.map((row) => [String(row.id), row]))

  return items.map((item) => {
    const product = productMap.get(item.producto_id)
    if (!product) {
      throw new AndreaniError(
        "VALIDATION_ERROR",
        "Uno de los productos del pedido ya no existe en el catálogo.",
      )
    }

    const conditioned = item.conditioned_stock_id
      ? conditionedMap.get(item.conditioned_stock_id)
      : undefined
    const effectiveVariantId = conditioned?.source_variant_id ?? item.variante_id ?? null
    const variant = effectiveVariantId ? variantMap.get(effectiveVariantId) ?? null : null

    if (
      !Number.isSafeInteger(item.cantidad) ||
      item.cantidad <= 0 ||
      !Number.isFinite(Number(item.precio)) ||
      Number(item.precio) <= 0 ||
      (item.conditioned_stock_id &&
        (!conditioned || Number(conditioned.product_id) !== Number(product.id))) ||
      (effectiveVariantId &&
        (!variant || Number(variant.producto_id) !== Number(product.id)))
    ) {
      throw new AndreaniError(
        "VALIDATION_ERROR",
        "Los productos persistidos del pedido no son válidos para generar el envío.",
      )
    }

    return {
      product: { ...product, precio: Number(item.precio) },
      variant,
      quantity: item.cantidad,
      discountPercent: 0,
    }
  })
}

interface CrearOrdenEnvioOptions {
  env: NodeJS.ProcessEnv
  productionAccess?: AndreaniProductionAccess
}

async function crearOrdenEnvioConReintentoDeAutenticacion(
  crear: typeof crearOrdenEnvio,
  input: AndreaniCreateShipmentInput,
  options: CrearOrdenEnvioOptions,
): Promise<AndreaniCreateShipmentResponse> {
  try {
    return await crear(input, options)
  } catch (error) {
    // El token cacheado ya se invalidó dentro del cliente al recibir
    // 401/403; un único reintento es seguro porque la solicitud nunca
    // llegó a procesarse del lado de Andreani.
    if (error instanceof AndreaniError && error.code === "AUTHENTICATION_FAILED") {
      return await crear(input, options)
    }
    throw error
  }
}

function formatAndreaniErrorForPersistence(
  message: string,
  status: number | null,
) {
  const trimmed = message.trim()
  return status !== null ? `HTTP ${status} · ${trimmed}` : trimmed
}

export async function createAndreaniShipmentForOrder(
  admin: AdminClient,
  orderId: number,
  dependencies: AndreaniShipmentCreationDependencies = {},
): Promise<AndreaniShipmentCreationResult> {
  const env = dependencies.env ?? process.env
  const { data: orderData, error: orderError } = await admin
    .from("ordenes")
    .select(ORDER_SELECT)
    .eq("id", orderId)
    .maybeSingle()

  if (orderError || !orderData) {
    throw new AndreaniError("VALIDATION_ERROR", "No encontramos el pedido.")
  }

  const order = orderData as unknown as AndreaniOrderRow

  if (requiredText(order.andreani_envio_id)) {
    return {
      status: "reused",
      envioId: order.andreani_envio_id as string,
      tracking: order.andreani_tracking,
      etiquetaUrl: order.andreani_etiqueta_url,
      estado: order.andreani_estado ?? "",
    }
  }

  assertShipmentEligibleOrder(order)

  const config = resolveAndreaniShipmentCreationConfig(env)
  // Segunda barrera explícita para PROD, separada de la resolución de
  // ambiente: ni ANDREANI_SHIPMENT_ENV=PROD por sí solo alcanza.
  assertAndreaniProdShipmentCreationAuthorized(config.environment, env)

  const envio = buildAndreaniShipmentEnvio(order, config)
  const items = await loadOrderShipmentItems(admin, orderId)
  const packageData = aggregateAndreaniPackage(items)

  const claimToken = randomUUID()
  const { data: attempts, error: claimError } = await admin.rpc(
    "claim_andreani_shipment_creation",
    { p_order_id: orderId, p_claim_token: claimToken, p_environment: config.environment },
  )

  if (claimError) {
    throw new AndreaniError(
      "REQUEST_FAILED",
      "No se pudo iniciar la generación del envío.",
    )
  }

  if (!attempts) {
    const { data: refreshed } = await admin
      .from("ordenes")
      .select("andreani_envio_id, andreani_tracking, andreani_etiqueta_url, andreani_estado")
      .eq("id", orderId)
      .maybeSingle()

    if (refreshed && requiredText(refreshed.andreani_envio_id)) {
      return {
        status: "reused",
        envioId: refreshed.andreani_envio_id as string,
        tracking: refreshed.andreani_tracking,
        etiquetaUrl: refreshed.andreani_etiqueta_url,
        estado: refreshed.andreani_estado ?? "",
      }
    }

    throw new AndreaniError("REQUEST_FAILED", CREATION_IN_PROGRESS_MESSAGE)
  }

  const creationEnv = {
    ...env,
    ANDREANI_ENV: config.environment,
    ANDREANI_TARIFF_ENV: config.environment,
  }
  const crear = dependencies.crearOrdenEnvio ?? crearOrdenEnvio

  try {
    const response = await crearOrdenEnvioConReintentoDeAutenticacion(
      crear,
      {
        envio,
        items: [
          {
            producto: buildConsolidatedProduct(orderId, packageData),
            bulto: {
              volumenCm: packageData.volumenCm3,
              valorDeclaradoConImpuestos: packageData.valorDeclarado,
              // El contrato B2C documentado asocia el bulto a un identificador
              // de cliente mediante el meta "idCliente".
              referencias: [{ meta: "idCliente", contenido: String(orderId) }],
              descripcion: `Pedido BX-${1000 + orderId}`,
            },
          },
        ],
      },
      {
        env: creationEnv,
        productionAccess:
          config.environment === "PROD" ? "shipment-creation" : undefined,
      },
    )

    if (response.estado === "Rechazado") {
      throw new AndreaniError(
        "REQUEST_FAILED",
        response.motivo || "Andreani rechazó la orden de envío.",
        { status: 422 },
      )
    }

    const bulto = response.bultos[0]
    const etiquetaUrl =
      response.etiquetasPorAgrupador ??
      bulto?.linking?.find((link) => link.meta.toLowerCase().includes("etiqueta"))
        ?.contenido ??
      null
    const envioId = response.agrupadorDeBultos || bulto?.numeroDeEnvio || null

    if (!envioId) {
      throw new AndreaniError(
        "INVALID_RESPONSE",
        "Andreani no devolvió un identificador de envío válido.",
      )
    }

    const nowIso = (dependencies.now?.() ?? new Date()).toISOString()
    const persistedUpdate = {
      andreani_envio_id: envioId,
      andreani_tracking: bulto?.numeroDeEnvio ?? null,
      andreani_etiqueta_url: etiquetaUrl,
      andreani_estado: response.estado,
      andreani_contrato: envio.contrato,
      andreani_creation_environment: config.environment,
      andreani_created_at: nowIso,
      andreani_creation_status: "created",
      andreani_creation_claim_token: null,
      andreani_error: null,
    }

    const { data: persisted, error: persistenceError } = await admin
      .from("ordenes")
      .update(persistedUpdate as never)
      .eq("id", orderId)
      .eq("andreani_creation_claim_token", claimToken)
      .select("id")
      .maybeSingle()

    if (persistenceError || !persisted) {
      const { data: existingPersistence } = await admin
        .from("ordenes")
        .select("andreani_envio_id")
        .eq("id", orderId)
        .maybeSingle()

      if (requiredText(existingPersistence?.andreani_envio_id) !== envioId) {
        throw new AndreaniError(
          "REQUEST_FAILED",
          "Andreani creó el envío, pero no se pudo persistir su referencia. Requiere conciliación manual.",
        )
      }
    }

    return {
      status: "created",
      envioId,
      tracking: bulto?.numeroDeEnvio ?? null,
      etiquetaUrl,
      estado: response.estado,
    }
  } catch (error) {
    const safeError = normalizeAndreaniError(error, env)
    const status = safeError.status
    const reconciliationRequired =
      safeError.code === "TIMEOUT" ||
      safeError.code === "INVALID_RESPONSE" ||
      (safeError.code === "SERVICE_UNAVAILABLE" && (status === null || status >= 500)) ||
      (safeError.code === "REQUEST_FAILED" && (status === null || status === 409))
    const rejected =
      safeError.code === "REQUEST_FAILED" &&
      status !== null &&
      (status === 400 || status === 422)

    await admin
      .from("ordenes")
      .update({
        andreani_creation_status: reconciliationRequired
          ? "reconciliation_required"
          : rejected
            ? "rejected"
            : "failed",
        andreani_creation_claim_token: null,
        andreani_creation_environment: config.environment,
        ...(rejected && safeError.message
          ? { andreani_estado: "Rechazado", andreani_contrato: envio.contrato }
          : {}),
        andreani_error: formatAndreaniErrorForPersistence(
          sanitizeAndreaniMessage(safeError.message, env),
          status,
        ),
      } as never)
      .eq("id", orderId)
      .eq("andreani_creation_claim_token", claimToken)

    throw error
  }
}
