// Medios que se informan en "Mercado Pago al contado → Ver medios".
//
// Sólo MARCAS de tarjeta y medios propios de Mercado Pago que Checkout Pro
// acepta en Argentina con la preferencia que arma BEYONIX
// (create-preference: sin excluded_payment_types/methods, installments = 1).
// Nunca bancos emisores: que Mercado Pago acepte una tarjeta emitida por un
// banco no implica un convenio de BEYONIX con ese banco.
//
// Mercado Crédito no se lista: su disponibilidad depende de la evaluación de
// cada usuario y no está confirmada para un pago al contado en 1 cuota.
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
