import "server-only"

import {
  ANDREANI_TRACKING_EVENTS,
  type AndreaniTrackingEvent,
  type AndreaniTrackingEventName,
} from "./types.ts"

/**
 * Fase logística normalizada a partir del `Evento` ESTABLE que devuelve
 * `/v3/envios/{id}/trazas` -- nunca del campo `Estado` (texto libre que
 * Andreani redacta por evento, ej. "Pendiente de ingreso"). Único mapping
 * canónico del proyecto: tanto el botón "Consultar" (admin) como la
 * sincronización automática de tracking usan esta misma función -- no debe
 * haber una segunda copia de este mapping en ningún componente/endpoint.
 *
 * El switch es exhaustivo sobre `AndreaniTrackingEventName`: si Andreani
 * agrega un evento nuevo a `ANDREANI_TRACKING_EVENTS` (types.ts) sin
 * mapearlo acá, TypeScript deja de compilar (ver el `never` del default).
 */
export type AndreaniLogisticsPhase =
  | "orden_creada"
  | "en_camino"
  | "en_distribucion"
  | "entregado"
  | "no_entregado"
  | "incidencia"
  | "anulado"
  | "interno"

export function mapAndreaniEventToLogisticsPhase(
  evento: AndreaniTrackingEventName,
): AndreaniLogisticsPhase {
  switch (evento) {
    case "OrdenDeEnvioSolicitada":
    case "OrdenDeEnvioCreada":
    case "Admision":
      return "orden_creada"

    case "EnvioDespachado":
    case "ExpedicionHojaDeRutaCabecera":
    case "ExpedicionHojaDeRutaDeViaje":
    case "AsignacionACaja":
      return "en_camino"

    case "Distribucion":
    case "ComienzoCustodiaEnSucursal":
    case "RecepcionEnSucursalDestino":
    case "FinCustodiaEnSucursal":
    case "EnvioConsolidado":
    case "Visita":
      return "en_distribucion"

    case "EnvioEntregado":
      return "entregado"

    case "EnvioNoEntregado":
      return "no_entregado"

    case "EnvioAnulado":
    case "OrdenDeEnvioRechazada":
      return "anulado"

    case "RoturaParcial":
    case "RoturaTotal":
    case "Siniestro":
    case "FaltanBultos":
    case "FaltaRemito":
    case "Rescate":
    case "SolicitudDeRescate":
    case "Reenvio":
    case "CambioDeDestino":
    case "NuevaFechaDeEntregaPactada":
    case "NuevaFechaDeEntregaRepactada":
      return "incidencia"

    case "AltaAutomatica":
    case "AltaManual":
    case "AltaRemota":
    case "IncorporarMarcaDeCustodia":
    case "Impresion":
    case "RemitoDigitalizado":
    case "Destruccion":
    case "PedidoDeDestruccion":
    case "IntroduccionDeMotivo":
    case "RectificacionDeMotivo":
    case "InicioEtapaDeGestionTelefonica":
    case "GestionTelefonica":
    case "EnvioRendido":
    case "EnvioEnInformeDeRendicion":
    case "InicioCicloDeRendicion":
    case "CierreDeEntidad":
      return "interno"

    default: {
      const exhaustiveCheck: never = evento
      return exhaustiveCheck
    }
  }
}

/** Sólo para tests/auditoría: confirma que todo el maestro tiene mapping. */
export function assertAllAndreaniEventsAreMapped(): void {
  for (const evento of ANDREANI_TRACKING_EVENTS) {
    mapAndreaniEventToLogisticsPhase(evento)
  }
}

export type AndreaniAutoOrderTransition = "en_camino" | "entregado"

/**
 * Pedidos BEYONIX desde los que es seguro avanzar automáticamente a
 * `en_camino` cuando Andreani confirma despacho real. Un pedido que ya está
 * en un estado más específico (en_sucursal, retiro_pendiente, etc.) no se
 * toca -- esta automatización nunca retrocede ni pisa un estado que ya
 * refleja más información que "despachado".
 */
const ORDER_STATES_ELIGIBLE_FOR_AUTO_EN_CAMINO = new Set(["pendiente", "pagado"])

/**
 * Estados terminales o ya avanzados: la sincronización automática nunca los
 * toca, y el batch del cron tampoco vuelve a consultar Andreani para
 * pedidos en estos estados -- "no consultar pedidos cerrados" (única lista,
 * reusada tanto por la transición automática como por la selección del
 * batch en tracking-sync-batch.ts).
 */
export const ORDER_STATES_CLOSED_TO_AUTO_SYNC = [
  "entregado",
  "cancelado",
  "devuelto_beyonix",
  "en_devolucion",
] as const

/**
 * Decide si hay evidencia suficiente para avanzar automáticamente
 * `ordenes.estado`, a partir de los eventos reales (`Evento` estable) de un
 * tracking. Deliberadamente conservador -- exactamente lo pedido:
 *
 * - `entregado` sólo con `EnvioEntregado` explícito.
 * - `en_camino` sólo con `EnvioDespachado` explícito, y sólo si el pedido
 *   todavía no tiene un estado de despacho más específico.
 * - Nunca por "existe tracking" ni por "Pendiente de ingreso"
 *   (`OrdenDeEnvioSolicitada`/`OrdenDeEnvioCreada`) -- esos son
 *   `orden_creada`, no `en_camino`.
 * - Nunca sobre un pedido ya cerrado (entregado/cancelado/devuelto/en
 *   devolución): esos estados sólo cambian por acción explícita.
 */
export function resolveAndreaniAutoOrderTransition(
  eventos: readonly Pick<AndreaniTrackingEvent, "Evento">[],
  currentEstado: string,
): AndreaniAutoOrderTransition | null {
  if ((ORDER_STATES_CLOSED_TO_AUTO_SYNC as readonly string[]).includes(currentEstado)) return null

  const hasDelivered = eventos.some((event) => event.Evento === "EnvioEntregado")
  if (hasDelivered) return "entregado"

  const hasDispatched = eventos.some((event) => event.Evento === "EnvioDespachado")
  if (hasDispatched && ORDER_STATES_ELIGIBLE_FOR_AUTO_EN_CAMINO.has(currentEstado)) {
    return "en_camino"
  }

  return null
}
