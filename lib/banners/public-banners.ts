import type { BannerPlacement } from "./site-banners.ts"

/** Banner visible para el público (sin nombre interno ni datos de auditoría). */
export interface PublicBanner {
  id: string
  placement: BannerPlacement
  image_url: string
  mobile_image_url: string | null
  alt_text: string | null
  destination_url: string | null
  active: boolean
  sort_order: number
  ends_at: string | null
  updated_at: string | null
}

export interface PublicBannersResult {
  banners: PublicBanner[]
  /** La ubicación tiene filas propias (aunque ninguna esté vigente). */
  hasItems: boolean
  /** Próximo instante en que cambia lo visible (fin de la vigente o inicio de una programada). */
  nextChangeAt: string | null
  serverNow: string
}

/** Campaña del HOME para renderizar (servidor) y refrescar (cliente). */
export interface HomeCampaignState {
  banner: PublicBanner | null
  nextChangeAt: string | null
  serverNow: string
}

type RpcClient = {
  rpc: (fn: "get_public_site_banners", args: { p_placement: BannerPlacement }) => PromiseLike<{ data: unknown; error: unknown }>
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null
const optionalString = (value: unknown) => (typeof value === "string" && value ? value : null)

function parseBanner(value: unknown, placement: BannerPlacement): PublicBanner | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.image_url !== "string" || !value.image_url) return null
  if (value.placement !== placement) return null
  return {
    id: value.id,
    placement,
    image_url: value.image_url,
    mobile_image_url: optionalString(value.mobile_image_url),
    alt_text: optionalString(value.alt_text),
    destination_url: optionalString(value.destination_url),
    active: value.active === true,
    sort_order: typeof value.sort_order === "number" ? value.sort_order : 0,
    ends_at: optionalString(value.ends_at),
    updated_at: optionalString(value.updated_at),
  }
}

/**
 * Lectura pública de banners vigentes (get_public_site_banners): la vigencia
 * la decide la base con su hora. Lanza si no se pudo leer: quien llama decide
 * el resultado seguro (nunca un respaldo que muestre algo incorrecto).
 */
export async function loadPublicBanners(client: RpcClient, placement: BannerPlacement): Promise<PublicBannersResult> {
  const { data, error } = await client.rpc("get_public_site_banners", { p_placement: placement })
  if (error || !isRecord(data)) throw new Error("PUBLIC_BANNERS_READ_FAILED")
  const banners = (Array.isArray(data.banners) ? data.banners : [])
    .map((banner) => parseBanner(banner, placement))
    .filter((banner): banner is PublicBanner => banner !== null)
  const serverNow = optionalString(data.serverNow)
  return {
    banners,
    hasItems: data.hasItems === true,
    nextChangeAt: optionalString(data.nextChangeAt),
    serverNow: serverNow && Number.isFinite(Date.parse(serverNow)) ? new Date(serverNow).toISOString() : new Date().toISOString(),
  }
}

/** Respuesta de /api/store/banners?placement=home validada (el navegador nunca confía en su forma). */
export function parseHomeCampaignState(value: unknown): HomeCampaignState | null {
  if (!isRecord(value)) return null
  const serverNow = optionalString(value.serverNow)
  if (!serverNow || !Number.isFinite(Date.parse(serverNow))) return null
  const nextChangeAt = optionalString(value.nextChangeAt)
  return {
    banner: value.banner === null ? null : parseBanner(value.banner, "home"),
    nextChangeAt: nextChangeAt && Number.isFinite(Date.parse(nextChangeAt)) ? nextChangeAt : null,
    serverNow,
  }
}

export function toHomeCampaignState(result: PublicBannersResult): HomeCampaignState {
  return { banner: result.banners[0] ?? null, nextChangeAt: result.nextChangeAt, serverNow: result.serverNow }
}
