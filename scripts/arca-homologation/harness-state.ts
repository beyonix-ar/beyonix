/**
 * Estado compartido entre el arnés (run.ts) y los shims de auth/gateway que
 * reemplazan esos dos módulos SÓLO dentro del proceso del arnés.
 */

export interface HarnessActor {
  id: string
  email: string | null
  rol: "super_admin"
}

export interface HarnessState {
  actor: HarnessActor | null
  /** Descarta la PRÓXIMA respuesta de FECAESolicitar después de que ARCA autorizó. */
  loseNextCaeResponse: boolean
  /** Prohíbe pedir CAE (conciliaciones): cualquier intento aborta. */
  forbidCae: boolean
  caeRequests: number
  lostResponses: Array<{ voucherType: number | undefined; voucherNumber: number; cae: string }>
}

declare global {
  var arcaHomologationHarness: HarnessState | undefined
}

export function harnessState(): HarnessState {
  globalThis.arcaHomologationHarness ??= {
    actor: null,
    loseNextCaeResponse: false,
    forbidCae: true,
    caeRequests: 0,
    lostResponses: [],
  }
  return globalThis.arcaHomologationHarness
}
