export const BEYONIX_EMAIL = "beyonix.ar@gmail.com"
export const BEYONIX_INSTAGRAM_URL = "https://instagram.com/beyonix.ar"
export const BEYONIX_SUPPORT_HOURS = "Lunes a viernes, de 9:00 a 17:00 h"
export const BEYONIX_SUPPORT_HOURS_DETAIL = `${BEYONIX_SUPPORT_HOURS}, excepto feriados nacionales.`

const withdrawalSubject = "Botón de arrepentimiento — BEYONIX"
const withdrawalBody = [
  "Solicito ejercer el derecho de arrepentimiento sobre una compra realizada en BEYONIX.",
  "",
  "Nombre y apellido:",
  "Número de pedido:",
  "Correo utilizado en la compra:",
  "Producto:",
].join("\n")

export const BEYONIX_WITHDRAWAL_URL = `mailto:${BEYONIX_EMAIL}?subject=${encodeURIComponent(withdrawalSubject)}&body=${encodeURIComponent(withdrawalBody)}`
