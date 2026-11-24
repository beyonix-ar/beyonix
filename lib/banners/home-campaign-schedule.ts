import type { HomeCampaignState } from "./public-banners.ts"

/** Render de más de este tiempo (pestaña restaurada, caché del navegador o página cacheada): se confirma con el servidor. */
export const HOME_CAMPAIGN_STALE_MS = 60_000
/**
 * Revisión periódica con el HOME abierto y visible: una campaña desactivada,
 * editada, eliminada o reemplazada por Admin se refleja en a lo sumo este
 * tiempo, sin recargar. Con la pestaña oculta no se consulta.
 */
export const HOME_CAMPAIGN_POLL_MS = 60_000
/** Margen tras el instante de cambio, para no consultar un instante antes de que la base lo vea. */
export const HOME_CAMPAIGN_CHANGE_MARGIN_MS = 1_000

/** La página viene de un render viejo (pestaña restaurada o caché) según el reloj del dispositivo. */
export function isHomeCampaignStale(state: Pick<HomeCampaignState, "serverNow">, deviceNowMs: number) {
  const renderedAt = Date.parse(state.serverNow)
  return !Number.isFinite(renderedAt) || Math.abs(deviceNowMs - renderedAt) > HOME_CAMPAIGN_STALE_MS
}

/**
 * Cuánto esperar hasta volver a consultar: el próximo cambio programado
 * (calculado con la hora del servidor, no la del dispositivo) si llega antes
 * que la revisión periódica; si no, la revisión periódica.
 */
export function msUntilHomeCampaignRefresh(state: Pick<HomeCampaignState, "nextChangeAt" | "serverNow">) {
  const next = state.nextChangeAt ? Date.parse(state.nextChangeAt) : Number.NaN
  const now = Date.parse(state.serverNow)
  if (!Number.isFinite(next) || !Number.isFinite(now)) return HOME_CAMPAIGN_POLL_MS
  return Math.min(HOME_CAMPAIGN_POLL_MS, Math.max(0, next - now) + HOME_CAMPAIGN_CHANGE_MARGIN_MS)
}

/**
 * Cuánto le falta a la campaña visible para terminar (hora del servidor), o
 * null si no tiene fin. Si en ese momento el servidor no responde, se oculta
 * igual: nunca se sigue mostrando una campaña vencida.
 */
export function msUntilHomeCampaignEnds(state: Pick<HomeCampaignState, "banner" | "serverNow">) {
  const endsAt = state.banner?.ends_at ? Date.parse(state.banner.ends_at) : Number.NaN
  const now = Date.parse(state.serverNow)
  return Number.isFinite(endsAt) && Number.isFinite(now) ? Math.max(0, endsAt - now) : null
}
