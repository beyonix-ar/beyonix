export const BEYONIX_EMAIL = "beyonix.ar@gmail.com"
export const BEYONIX_INSTAGRAM_URL = "https://instagram.com/beyonix.ar"
export const BEYONIX_SUPPORT_HOURS = "Lunes a viernes, de 8:00 a 20:00 h"
export const BEYONIX_SUPPORT_HOURS_DETAIL = `${BEYONIX_SUPPORT_HOURS}, excepto feriados nacionales.`
export const BEYONIX_WITHDRAWAL_PAGE_URL = "/arrepentimiento"
export const BEYONIX_CUSTOMER_SERVICE_AREA = "Atención al cliente BEYONIX"
// Acceso oficial a la Ventanilla Federal Única de Reclamos (Disposición 890/2025).
export const CONSUMER_COMPLAINTS_URL = "https://www.argentina.gob.ar/servicio/iniciar-un-reclamo-ante-defensa-del-consumidor"
// Texto informativo obligatorio de la Resolución AAIP 14/2018 (art. 3).
export const AAIP_PERSONAL_DATA_NOTICE = "LA AGENCIA DE ACCESO A LA INFORMACIÓN PÚBLICA, en su carácter de Órgano de Control de la Ley N° 25.326, tiene la atribución de atender las denuncias y reclamos que interpongan quienes resulten afectados en sus derechos por incumplimiento de las normas vigentes en materia de protección de datos personales."

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
export const BEYONIX_WITHDRAWAL_GMAIL_URL = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(BEYONIX_EMAIL)}&su=${encodeURIComponent(withdrawalSubject)}&body=${encodeURIComponent(withdrawalBody)}`
