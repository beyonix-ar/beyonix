/**
 * BLOQUEANTE 2 (auditoría Andreani Parte 2/4): fuente ÚNICA de las
 * restricciones reales que exige POST /v2/ordenes-de-envio (ver
 * buildAndreaniShipmentParties/buildAndreaniHomeDeliveryEnvio en
 * order-shipment.ts, que ahora importa estos mismos valores en vez de
 * repetirlos). Antes, estos límites vivían como números mágicos duplicados
 * (y desalineados) entre Registro/Mi Cuenta (lib/validation/account-fields.ts),
 * checkout (lib/orders/checkout-order-creation.ts) y la creación real del
 * envío -- un pedido podía completarse en checkout con datos que la creación
 * Andreani rechazaba recién al clickear "Generar envío" (nombre/email >40,
 * altura de 7+ dígitos, localidad >40, etc.). Cualquier cambio real de
 * límite de Andreani se hace ACÁ, una sola vez.
 */

export const ANDREANI_RECIPIENT_NAME_MAX_LENGTH = 40
export const ANDREANI_EMAIL_MAX_LENGTH = 40
export const ANDREANI_PHONE_MIN_DIGITS = 8
export const ANDREANI_PHONE_MAX_DIGITS = 15
export const ANDREANI_DNI_PATTERN = /^\d{7,8}$/
export const ANDREANI_POSTAL_CODE_PATTERN = /^\d{4}$/
export const ANDREANI_STREET_MAX_LENGTH = 40
export const ANDREANI_STREET_NUMBER_MAX_DIGITS = 6
export const ANDREANI_FLOOR_MAX_LENGTH = 40
export const ANDREANI_APARTMENT_MAX_LENGTH = 40
export const ANDREANI_LOCALITY_MAX_LENGTH = 40

/**
 * BLOQUEANTE 3 (auditoría Andreani Parte 2/4): límite real y duro que
 * aplica POST /v2/ordenes-de-envio para un bulto B2C (ver validación en
 * AndreaniClient.crearEnvio, lib/andreani/client.ts). BEYONIX modela cada
 * pedido como UN ÚNICO bulto consolidado (ver aggregateAndreaniPackage en
 * checkout-quote.ts y el array de un solo item en
 * createAndreaniShipmentForOrder, order-shipment.ts) -- por eso la
 * cotización debe rechazar acá, con el mismo número, cualquier carrito cuyo
 * peso consolidado supere este límite: la tarifa (`/v1/tarifas`) por sí sola
 * tolera hasta 1000 kg y nunca avisaría que la creación real (B2C, 50 kg)
 * la va a rechazar después.
 */
export const ANDREANI_B2C_MAX_PACKAGE_WEIGHT_KG = 50
