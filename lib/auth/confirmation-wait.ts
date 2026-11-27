/**
 * Pantalla "confirmá tu email" de /login.
 *
 * El inicio de sesión automático depende del handoff que devuelve el registro
 * y que vive sólo en la memoria de la pestaña. Si la pestaña se recarga (los
 * navegadores integrados de Instagram/Facebook suelen recargarla al volver de
 * la app de correo), la pantalla se reconstruye desde `?verificar-email=` sin
 * handoff: ya no puede consultar la confirmación y no debe prometerlo.
 */
export type ConfirmationWaitMode = "automatic" | "manual"

export function getConfirmationWaitMode(confirmationHandoff: string): ConfirmationWaitMode {
  return confirmationHandoff.trim() ? "automatic" : "manual"
}

/**
 * Con sesión, /login vuelve al destino. Durante la espera automática lo
 * resuelve la consulta de confirmación (que inicia la sesión y navega); en la
 * espera manual nadie más lo haría y la pantalla quedaría en "Ingreso
 * confirmado" para siempre (p. ej. el enlace se abrió en otra pestaña del
 * mismo navegador, que comparte la sesión).
 */
export function shouldLeaveLoginWithSession({
  isLoading,
  hasUser,
  confirmationEmail,
  confirmationHandoff,
}: {
  isLoading: boolean
  hasUser: boolean
  confirmationEmail: string
  confirmationHandoff: string
}) {
  if (isLoading || !hasUser) return false
  if (!confirmationEmail) return true
  return getConfirmationWaitMode(confirmationHandoff) === "manual"
}

/** Adónde lleva /login después de confirmar, dicho como lo lee el cliente. */
export function getConfirmationDestinationLabel(redirect: string) {
  return redirect === "/" ? "al inicio" : "de vuelta a tu compra"
}
