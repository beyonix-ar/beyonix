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

/** Hitos de `ordenes.estado` que el tracking Andreani puede fijar solo. */
export type AndreaniAutoOrderTransition = "enviado" | "en_camino" | "en_sucursal" | "entregado"

const AUTO_TRANSITION_RANK: Record<AndreaniAutoOrderTransition, number> = {
  enviado: 1,
  en_camino: 2,
  en_sucursal: 3,
  entregado: 4,
}

/**
 * Estados desde los que el tracking puede avanzar hitos intermedios, con su
 * rango. Nunca retrocede: sólo se avanza a un hito de rango mayor. Los
 * estados que un Admin fija a mano y no tienen rango (visita_fallida,
 * retiro_pendiente, retiro_vencido) sólo avanzan con una entrega confirmada.
 */
const ORDER_STATE_RANK: Readonly<Record<string, number>> = {
  pendiente: 0,
  pagado: 0,
  enviado: 1,
  en_camino: 2,
  en_sucursal: 3,
}

/**
 * Hito de pedido que prueba un `Evento` estable de Andreani, o null si el
 * evento no prueba avance (pre-envío, internos, incidencias, no entregado,
 * fin de custodia -- se registran en el historial pero no mueven el pedido):
 *
 * - `Admision`, `AsignacionACaja`, `EnvioConsolidado`: el paquete ya está en
 *   manos de Andreani (`enviado`).
 * - `EnvioDespachado`, hojas de ruta, `Distribucion`, `Visita`: en tránsito o
 *   en reparto (`en_camino`).
 * - Llegada/custodia en sucursal destino: `en_sucursal` sólo si el cliente
 *   eligió retiro en sucursal; para entrega a domicilio es un paso del
 *   tránsito (`en_camino`), nunca "pasá a retirarlo".
 * - `EnvioEntregado`: `entregado`.
 */
export function mapAndreaniEventToOrderMilestone(
  evento: AndreaniTrackingEventName,
  shippingType: string | null | undefined,
): AndreaniAutoOrderTransition | null {
  switch (evento) {
    case "Admision":
    case "AsignacionACaja":
    case "EnvioConsolidado":
      return "enviado"

    case "EnvioDespachado":
    case "ExpedicionHojaDeRutaCabecera":
    case "ExpedicionHojaDeRutaDeViaje":
    case "Distribucion":
    case "Visita":
      return "en_camino"

    case "RecepcionEnSucursalDestino":
    case "ComienzoCustodiaEnSucursal":
      return shippingType === "sucursal" ? "en_sucursal" : "en_camino"

    case "EnvioEntregado":
      return "entregado"

    default:
      return null
  }
}

/** Siguiente estado si `milestone` avanza al pedido en `currentEstado`; si no, null. */
export function resolveOrderMilestoneTransition(
  milestone: AndreaniAutoOrderTransition | null,
  currentEstado: string,
): AndreaniAutoOrderTransition | null {
  if (!milestone) return null
  if ((ORDER_STATES_CLOSED_TO_AUTO_SYNC as readonly string[]).includes(currentEstado)) return null
  if (milestone === "entregado") return "entregado"
  const currentRank = ORDER_STATE_RANK[currentEstado]
  if (currentRank === undefined) return null
  return AUTO_TRANSITION_RANK[milestone] > currentRank ? milestone : null
}

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
 * tracking: el hito más avanzado que informan (ver
 * `mapAndreaniEventToOrderMilestone`), sólo si supera el estado actual.
 *
 * - `entregado` sólo con `EnvioEntregado` explícito.
 * - Nunca por "existe tracking" ni por "Pendiente de ingreso"
 *   (`OrdenDeEnvioSolicitada`/`OrdenDeEnvioCreada`).
 * - Nunca retrocede, aunque los eventos lleguen repetidos o desordenados.
 * - Nunca sobre un pedido ya cerrado (entregado/cancelado/devuelto/en
 *   devolución): esos estados sólo cambian por acción explícita.
 */
export function resolveAndreaniAutoOrderTransition(
  eventos: readonly Pick<AndreaniTrackingEvent, "Evento">[],
  currentEstado: string,
  shippingType?: string | null,
): AndreaniAutoOrderTransition | null {
  let best: AndreaniAutoOrderTransition | null = null
  for (const event of eventos) {
    const milestone = mapAndreaniEventToOrderMilestone(event.Evento, shippingType)
    if (milestone && (!best || AUTO_TRANSITION_RANK[milestone] > AUTO_TRANSITION_RANK[best])) best = milestone
  }
  return resolveOrderMilestoneTransition(best, currentEstado)
}
