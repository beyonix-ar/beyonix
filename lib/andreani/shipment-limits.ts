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
 * Peso máximo POR BULTO B2C. La planilla oficial (api-orden-envio-3) no lo
 * documenta: es la política que BEYONIX aplica (AndreaniClient.crearEnvio) y
 * que el estimador respeta al dividir un carrito en bultos. La tarifa
 * (`/v1/tarifas`) tolera hasta 1000 kg por bulto.
 */
export const ANDREANI_B2C_MAX_PACKAGE_WEIGHT_KG = 50

/**
 * Bultos por orden de envío: la planilla oficial documenta `bultos` como
 * array con "Capacidad máxima 300 bultos" y una etiqueta por bulto.
 */
export const ANDREANI_MAX_SHIPMENT_PACKAGES = 300

/** Bultos por consulta de tarifa (control propio: una sola llamada por cotización). */
export const ANDREANI_MAX_TARIFF_PACKAGES = 50

/**
 * Bultos estimados que se ofrecen en checkout: por encima de este número el
 * carrito no se cotiza por Andreani (pedido mayorista, se coordina aparte).
 */
export const ANDREANI_MAX_CHECKOUT_PACKAGES = 10

/**
 * Lado máximo que acepta nuestra integración de `/v1/tarifas` (ver
 * assertPositiveNumber de alto/ancho/largo en requestTariff, client.ts).
 */
export const ANDREANI_MAX_PACKAGE_SIDE_CM = 500

export const ANDREANI_PACKAGE_LIMITS = {
  maxWeightKg: ANDREANI_B2C_MAX_PACKAGE_WEIGHT_KG,
  maxSideCm: ANDREANI_MAX_PACKAGE_SIDE_CM,
} as const
