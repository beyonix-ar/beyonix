import type { ShippingBonusSettings } from "../store-config.ts"

/** Importe en pesos sin decimales, como se informa en las páginas legales. */
export function formatWholeARS(value: number) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  }).format(value)
}

export type ShippingTermsCopy = {
  enabled: boolean
  keyFactValue: string
  keyFactDetail: string
  /** Aviso "Envío bonificado vigente." de la sección de precios; null si no hay bonificación. */
  bonusNotice: string | null
}

/**
 * Texto legal de la bonificación de envío. Recibe la MISMA configuración que
 * edita el Admin (site_settings.shipping) y que usa la cotización real
 * (calculateCustomerShippingCost), así el mínimo y el tope que se informan en
 * Términos y condiciones nunca divergen del cálculo. El carrito no muestra el
 * tope; sólo se informa acá.
 */
export function getShippingTermsCopy(settings: ShippingBonusSettings): ShippingTermsCopy {
  if (settings.freeShippingMode !== "full") {
    return {
      enabled: false,
      keyFactValue: "Según promoción vigente",
      keyFactDetail: "Se informa, si corresponde, antes de pagar.",
      bonusNotice: null,
    }
  }

  const minAmount = formatWholeARS(settings.freeShippingMinAmount)
  const maxBonus = formatWholeARS(settings.shippingBonusMax)

  return {
    enabled: true,
    keyFactValue: `Desde ${minAmount}`,
    keyFactDetail: `Bonificación de hasta ${maxBonus}.`,
    bonusNotice: `Desde un subtotal de productos de ${minAmount}, BEYONIX bonifica hasta ${maxBonus} del costo logístico. Si el envío supera ese tope, la diferencia queda informada antes de pagar.`,
  }
}
