/**
 * Normalización de la dirección que forma parte del binding firmado del token
 * de cotización (`canonicalizeQuoteBinding` en `checkout-shipping.ts`).
 * Deliberadamente NO es `server-only`: el caché cliente
 * (`lib/andreani/checkout-quote-client.ts`) usa exactamente esta misma regla
 * para no reutilizar nunca un token emitido para una dirección que el
 * servidor considera distinta. Cambiarla cambia qué tokens valida el pedido.
 *
 * Ignora mayúsculas, espacios sobrantes y el sufijo ". Referencias: …" que
 * agrega el checkout al crear la orden, pero conserva tildes y ñ: "Colón" y
 * "Colon" son direcciones distintas para la firma.
 */
export function normalizeCheckoutQuoteBindingAddress(direccion: string | null | undefined) {
  return (direccion ?? "").split(/\.\s*Referencias:/i)[0]
    .normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase()
}
