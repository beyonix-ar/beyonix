import {
  hasConsumableRecoveryToken,
  resolveRecoveryLink,
  type RecoveryAuthClient,
  type RecoveryLinkParams,
  type RecoveryLinkResolution,
} from "./recovery-link.ts"

export interface RecoveryLinkController {
  /** true = hay un token de un solo uso por consumir: hay que esperar un click humano antes de tocarlo. */
  needsConfirmation: boolean
  /**
   * Dispara la resolución real (y por lo tanto verifyOtp/
   * exchangeCodeForSession/setSession si corresponde) UNA sola vez, sin
   * importar cuántas veces se llame `confirm()` -- la promesa se cachea
   * SÍNCRONAMENTE en la primera invocación (antes de cualquier `await`), así
   * que un doble click, una doble invocación por re-render, o dos llamadas
   * concurrentes devuelven exactamente la misma promesa/resultado en vez de
   * consumir el token dos veces.
   */
  confirm: () => Promise<RecoveryLinkResolution>
}

/**
 * Orquestador puro (sin React) del flujo "botón de confirmación humana"
 * para `/reset-password`. Separado de la página para poder testear con un
 * cliente de auth fake, sin navegador (ver recovery-flow-controller.test.ts):
 * cuántas veces se llama a verifyOtp/exchangeCodeForSession/setSession bajo
 * carga automática, un click, y un doble click.
 *
 * `needsConfirmation` se calcula al crear el controller (una vez, con los
 * params ya parseados de la URL en el mount) -- nunca cambia después.
 */
export function createRecoveryLinkController(
  auth: RecoveryAuthClient,
  params: RecoveryLinkParams,
  hasRecoveryMarker: boolean,
): RecoveryLinkController {
  const needsConfirmation =
    !params.hashError && !params.queryError && hasConsumableRecoveryToken(params)

  let pending: Promise<RecoveryLinkResolution> | null = null

  const confirm = () => {
    if (!pending) {
      pending = resolveRecoveryLink(auth, params, hasRecoveryMarker)
    }

    return pending
  }

  return { needsConfirmation, confirm }
}
