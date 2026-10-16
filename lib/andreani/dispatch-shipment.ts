import "server-only"

import type { createAdminClient } from "../supabase/admin.ts"
import { AndreaniError, getEtiquetas } from "./client.ts"
import { createAndreaniShipmentForOrder, type AndreaniShipmentCreationResult } from "./order-shipment.ts"

type AdminClient = ReturnType<typeof createAdminClient>

export const INCOMPLETE_PREPARATION_MESSAGE = "Completá el pickeo del pedido antes de generar el envío Andreani."

type PreparationLine = { order_item_id: number; expected_quantity: number }

/**
 * Regla de Despachos para crear el envío: pickeo completo (order_packages
 * 'prepared'). Lo que se declara es lo que realmente sale: las cantidades
 * esperadas del armado vigente, que ya incluyen las diferencias registradas.
 */
async function loadShipmentPreparation(admin: AdminClient, orderId: number) {
  const { data: pkg, error } = await admin.from("order_packages").select("id,status").eq("order_id", orderId).maybeSingle()
  if (error) throw new AndreaniError("REQUEST_FAILED", "No se pudo leer la preparación del pedido.")
  if (!pkg) return { prepared: false, quantities: undefined }
  const { data: lines, error: linesError } = await admin.from("order_preparation_lines").select("order_item_id,expected_quantity").eq("package_id", pkg.id)
  if (linesError) throw new AndreaniError("REQUEST_FAILED", "No se pudo leer la preparación del pedido.")
  const quantities = new Map(((lines ?? []) as PreparationLine[])
    .filter((line) => line.expected_quantity > 0)
    .map((line) => [Number(line.order_item_id), Number(line.expected_quantity)]))
  return { prepared: pkg.status === "prepared", quantities: quantities.size ? quantities : undefined }
}

/**
 * Único camino para crear el envío Andreani de un pedido de Despachos. Un
 * envío ya creado se reutiliza siempre. `allowIncompletePreparation` es una
 * excepción de Super Admin: la decide y la audita la ruta que la invoca.
 */
export async function createDispatchAndreaniShipment(
  admin: AdminClient,
  orderId: number,
  options: { allowIncompletePreparation?: boolean } = {},
): Promise<AndreaniShipmentCreationResult> {
  const preparation = await loadShipmentPreparation(admin, orderId)
  const { data: order, error } = await admin.from("ordenes").select("andreani_envio_id").eq("id", orderId).maybeSingle()
  if (error || !order) throw new AndreaniError("VALIDATION_ERROR", "No encontramos el pedido.")
  if (!order.andreani_envio_id?.trim() && !preparation.prepared && !options.allowIncompletePreparation) {
    throw new AndreaniError("VALIDATION_ERROR", INCOMPLETE_PREPARATION_MESSAGE)
  }
  return createAndreaniShipmentForOrder(admin, orderId, { itemQuantities: preparation.quantities })
}

/** Etiqueta Andreani del envío del pedido, contra el ambiente donde se creó. */
export async function fetchAndreaniOrderLabel(admin: AdminClient, orderId: number, formato: "pdf" | "zpl") {
  const { data: order, error } = await admin.from("ordenes")
    .select("andreani_envio_id, andreani_creation_environment").eq("id", orderId).maybeSingle()
  if (error || !order) throw new AndreaniError("VALIDATION_ERROR", "No encontramos el pedido.")
  const envioId = typeof order.andreani_envio_id === "string" ? order.andreani_envio_id.trim() : ""
  if (!envioId) throw new AndreaniError("VALIDATION_ERROR", "El pedido todavía no tiene un envío Andreani generado.")
  // Nunca contra el ambiente configurado hoy: el envío vive donde se creó.
  const environment = order.andreani_creation_environment === "PROD" ? "PROD" : "QA"
  const label = await getEtiquetas(envioId, formato, {
    env: { ...process.env, ANDREANI_ENV: environment },
    productionAccess: environment === "PROD" ? "shipment-read" : undefined,
  })
  return { ...label, envioId, environment }
}
