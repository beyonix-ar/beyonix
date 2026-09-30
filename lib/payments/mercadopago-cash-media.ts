// Medios que se informan en "Mercado Pago al contado → Ver medios".
//
// Sólo MARCAS de tarjeta y medios propios de Mercado Pago que Checkout Pro
// acepta en Argentina con la preferencia al contado que arma BEYONIX
// (lib/pricing/checkout-pricing.ts: installments = 1 y excluded_payment_types
// credit_card, ticket y atm). Por eso no se listan tarjetas de crédito ni
// Rapipago/Pago Fácil: el crédito tiene su propia opción ("Mercado Pago con
// crédito", con el precio financiado).
// Nunca bancos emisores: que Mercado Pago acepte una tarjeta emitida por un
// banco no implica un convenio de BEYONIX con ese banco.
//
// Mercado Crédito no se lista: su disponibilidad depende de la evaluación de
// cada usuario y no está confirmada para un pago al contado en 1 cuota.
// La disponibilidad final la define Mercado Pago en su checkout, de ahí la
// aclaración que acompaña la lista.

export type MercadoPagoCashMediaGroup = {
  id: "debit" | "mercadopago"
  label: string
  items: readonly string[]
}

export const MERCADOPAGO_CASH_MEDIA_GROUPS: readonly MercadoPagoCashMediaGroup[] = [
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
