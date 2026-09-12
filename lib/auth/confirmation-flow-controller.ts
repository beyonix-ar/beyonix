import {
  hasConsumableConfirmationToken,
  resolveConfirmationLink,
  type ConfirmationAuthClient,
  type ConfirmationLinkParams,
  type ConfirmationLinkResolution,
} from "./confirmation-link.ts"

export interface ConfirmationLinkController {
  /** true = hay un token de un solo uso por consumir: hay que esperar un click humano antes de tocarlo. */
  needsConfirmation: boolean
  /**
   * Dispara la resolución real (y por lo tanto verifyOtp/
   * exchangeCodeForSession si corresponde) UNA sola vez, sin importar
   * cuántas veces se llame `confirm()` -- la promesa se cachea
   * SÍNCRONAMENTE en la primera invocación (antes de cualquier `await`), así
   * que un doble click, una doble invocación por re-render, o dos llamadas
   * concurrentes devuelven exactamente la misma promesa/resultado en vez de
   * consumir el token dos veces.
   */
  confirm: () => Promise<ConfirmationLinkResolution>
}

/**
 * Orquestador puro (sin React) del flujo "botón de confirmación humana"
 * para /confirmar-email. Mismo patrón que
 * lib/auth/recovery-flow-controller.ts para /reset-password, separado de la
 * página para poder testear con un cliente de auth fake, sin navegador (ver
 * confirmation-flow-controller.test.ts).
 *
 * `needsConfirmation` se calcula al crear el controller (una vez, con los
 * params ya parseados de la URL en el mount) -- nunca cambia después.
 */
export function createConfirmationLinkController(
  auth: ConfirmationAuthClient,
  params: ConfirmationLinkParams,
): ConfirmationLinkController {
  const needsConfirmation = hasConsumableConfirmationToken(params)

  let pending: Promise<ConfirmationLinkResolution> | null = null

  const confirm = () => {
    if (!pending) {
      pending = resolveConfirmationLink(auth, params)
    }

    return pending
  }

  return { needsConfirmation, confirm }
}
