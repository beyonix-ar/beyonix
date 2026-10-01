// Medios que se informan en "Mercado Pago en 1 pago → Ver medios".
//
// Sólo MARCAS de tarjeta y medios propios de Mercado Pago que Checkout Pro
// acepta en Argentina con la preferencia de 1 pago que arma BEYONIX
// (lib/pricing/checkout-pricing.ts: installments = 1 y excluded_payment_types
// ticket y atm). 1 pago es SIEMPRE precio contado, también con tarjeta de
// crédito; las cuotas sin interés son opciones aparte. No se listan
// Rapipago/Pago Fácil (excluidos).
// Nunca bancos emisores: que Mercado Pago acepte una tarjeta emitida por un
// banco no implica un convenio de BEYONIX con ese banco.
//
// Mercado Crédito no se lista: su disponibilidad depende de la evaluación de
// cada usuario y no está confirmada para un pago en 1 cuota.
// La disponibilidad final la define Mercado Pago en su checkout, de ahí la
// aclaración que acompaña la lista.

export type MercadoPagoCashMediaGroup = {
  id: "credit" | "debit" | "mercadopago"
  label: string
  items: readonly string[]
}

export const MERCADOPAGO_CASH_MEDIA_GROUPS: readonly MercadoPagoCashMediaGroup[] = [
  {
    id: "credit",
    label: "Tarjetas de crédito (1 pago)",
    items: ["Visa", "Mastercard", "American Express", "Naranja", "Cabal"],
  },
  {
    id: "debit",
    label: "Tarjetas de débito",
    items: ["Visa Débito", "Mastercard Débito", "Maestro", "Cabal Débito"],
  },
  {
    id: "mercadopago",
    label: "Mercado Pago",
    items: ["Dinero disponible en Mercado Pago"],
  },
]

export const MERCADOPAGO_CASH_MEDIA_DISCLAIMER =
  "Los medios disponibles pueden variar según tu cuenta, tarjeta y las condiciones de Mercado Pago."
