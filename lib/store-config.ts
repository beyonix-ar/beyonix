// ENVIO GRATIS A PARTIR DE:
export const FREE_SHIPPING_MIN = 90000

// COSTO DE ENVIO AL CLIENTE
export const SHIPPING_COST = 14000

// DESCUENTO DE TRANSFERENCIA: 5%
export const TRANSFER_DISCOUNT = 0.05

// TEXTO AUTOMATICO DEL DESCUENTO (se actualiza solo)
export const TRANSFER_DISCOUNT_LABEL = `${TRANSFER_DISCOUNT * 100}%`

// ================================
// CAMPAÑAS FUTURAS
// SOLO UNA DEBE ESTAR ACTIVA = 1
// ================================
export const ACTIVE_SALE_EVENT: string = "hotsale" // "hotsale" | "cyber" | "blackfriday" | "navidad" | "padre" | "madre" | "evento" | "none = desactiva campañas"

// DESCUENTOS POR EVENTO Y PRODUCTO
export const SALE_EVENTS: Record<string, Record<number, number>> = {
  hotsale: {
    1: 0.10,
    2: 0.15,
    7: 0.20,
  },
  cyber: {
    1: 0.20,
    4: 0.25,
  },
  blackfriday: {
    2: 0.30,
    5: 0.15,
  },
  navidad: {
    3: 0.10,
    8: 0.20,
  },
  padre: {
    3: 0.10,
    8: 0.20,
  },
  madre: {
    3: 0.10,
    8: 0.20,
  },
  evento: {
    3: 0.10,
    8: 0.20,
  },
}

// FUNCION CENTRAL PARA OBTENER DESCUENTO
export function getProductDiscount(productId: number): number {
  if (ACTIVE_SALE_EVENT === "none") return 0

  return SALE_EVENTS[ACTIVE_SALE_EVENT]?.[productId] || 0
}