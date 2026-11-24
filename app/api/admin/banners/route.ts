import { revalidatePath } from "next/cache"

import { requireInternalUser } from "@/lib/auth/admin-api"
import { databaseErrorResponse } from "@/lib/admin/database-error-response"
import {
  BANNER_MAX_FILE_BYTES,
  BANNER_STORAGE_BUCKET,
  CAMPAIGN_NAME_MAX,
  DEFAULT_ALT_TEXT,
  BANNER_FORMATS_LABEL,
  detectBannerImageMime,
  isBannerMimeAllowed,
  isBannerPlacement,
  parseBannerSortOrder,
  parseBannerVersion,
  validateBannerDestination,
  validateBannerImageUrl,
  type BannerPlacement,
} from "@/lib/banners/site-banners"

const MANAGE_ROLES = ["admin", "super_admin"] as const
const LEGACY_BANNER_KEY = "products_hero"
const BANNER_COLUMNS =
  "id, placement, campaign_name, image_url, mobile_image_url, alt_text, active, sort_order, starts_at, ends_at, destination_url, created_at, updated_at"
const SAVE_ERROR = "No se pudieron guardar o cargar los banners. Intentá de nuevo."

type Auth = Exclude<Awaited<ReturnType<typeof requireInternalUser>>, { error: Response }>

type BannerRow = {
  id: string
  placement: BannerPlacement
  campaign_name: string | null
  image_url: string
  mobile_image_url: string | null
  alt_text: string | null
  active: boolean
  sort_order: number
  starts_at: string | null
  ends_at: string | null
  destination_url: string | null
  created_at: string | null
  updated_at: string | null
}

type BannerBody = Partial<Record<
  | "id" | "placement" | "campaign_name" | "image_url" | "mobile_image_url" | "alt_text" | "active" | "sort_order" | "starts_at" | "ends_at"
  | "destination_url" | "expected_updated_at",
  unknown
>>

const CONFLICT_MESSAGE =
  "Este banner cambió desde que lo abriste (otro administrador lo modificó). Recargá los datos y revisalos antes de volver a guardar."
const DELETE_CONFLICT_MESSAGE =
  "No se eliminó: este banner cambió desde que lo abriste (otro administrador lo modificó). Recargá los datos y revisalo antes de eliminarlo."

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function normalizePlacement(value: unknown): BannerPlacement | "" {
  const placement = normalizeText(value)
  if (placement === LEGACY_BANNER_KEY) return "products"
  return isBannerPlacement(placement) ? placement : ""
}

const badRequest = (error: string) => Response.json({ error }, { status: 400 })

/** Instante ISO válido o null (vacío = sin límite). `undefined` si es inválido. */
function normalizeInstant(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === "") return null
  if (typeof value !== "string") return undefined
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined
}

/**
 * Tipo real del archivo subido al bucket de banners (firma, no extensión) y
 * tamaño máximo. Las URLs externas de Productos no se descargan.
 */
async function verifyStoredImage(auth: Auth, storagePath: string, placement: BannerPlacement) {
  const { data, error } = await auth.admin.storage.from(BANNER_STORAGE_BUCKET).download(storagePath)
  if (error || !data) return "No encontramos la imagen subida. Volvé a subirla."
  if (data.size > BANNER_MAX_FILE_BYTES) return "La imagen supera los 5 MB."
  const head = new Uint8Array(await data.slice(0, 64).arrayBuffer())
  return isBannerMimeAllowed(detectBannerImageMime(head), placement) ? null : `El archivo no es una imagen admitida (${BANNER_FORMATS_LABEL[placement]}).`
}

type Prepared = { ok: true; values: Omit<BannerRow, "id" | "created_at" | "updated_at"> } | { ok: false; response: Response }

/**
 * Valida y normaliza un banner completo. En PATCH, los campos que no llegan
 * conservan el valor actual (un cambio de estado desde la lista no borra las
 * fechas, el destino ni la imagen para celular).
 */
async function prepareBanner(auth: Auth, body: BannerBody, before: BannerRow | null): Promise<Prepared> {
  const has = (key: keyof BannerBody) => Object.hasOwn(body, key) && body[key] !== undefined
  const placement = has("placement") ? normalizePlacement(body.placement) : before?.placement ?? ""
  if (!placement) return { ok: false, response: badRequest("Ubicación de banner inválida.") }
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL

  const image = validateBannerImageUrl(has("image_url") ? body.image_url : before?.image_url, placement, supabaseUrl)
  if (!image.ok) return { ok: false, response: badRequest(image.error) }

  let mobileImageUrl: string | null = null
  let mobileStoragePath: string | null = null
  if (placement === "home") {
    const rawMobile = has("mobile_image_url") ? normalizeText(body.mobile_image_url) : before?.mobile_image_url ?? ""
    if (rawMobile) {
      const mobile = validateBannerImageUrl(rawMobile, "home", supabaseUrl)
      if (!mobile.ok) return { ok: false, response: badRequest(`Imagen para celular: ${mobile.error}`) }
      mobileImageUrl = mobile.value
      mobileStoragePath = mobile.storagePath
    }
  }

  const campaignName = (has("campaign_name") ? normalizeText(body.campaign_name) : before?.campaign_name ?? "") || null
  if (placement === "home" && !campaignName) return { ok: false, response: badRequest("Ingresá el nombre de la campaña.") }
  if (campaignName && campaignName.length > CAMPAIGN_NAME_MAX) {
    return { ok: false, response: badRequest(`El nombre de la campaña admite hasta ${CAMPAIGN_NAME_MAX} caracteres.`) }
  }

  const startsAt = has("starts_at") ? normalizeInstant(body.starts_at) : before?.starts_at ?? null
  const endsAt = has("ends_at") ? normalizeInstant(body.ends_at) : before?.ends_at ?? null
  if (startsAt === undefined || endsAt === undefined) return { ok: false, response: badRequest("La fecha u hora no es válida.") }
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) {
    return { ok: false, response: badRequest("La fecha de finalización tiene que ser posterior a la de inicio.") }
  }

  // Prioridad: obligatoria al crear; al editar, si llega, tiene que ser válida (nunca se convierte en 0).
  let sortOrder = before?.sort_order ?? 0
  if (has("sort_order") || !before) {
    const parsed = parseBannerSortOrder(body.sort_order)
    if (!parsed.ok) return { ok: false, response: badRequest(parsed.error) }
    sortOrder = parsed.value
  }

  const destination = validateBannerDestination(has("destination_url") ? body.destination_url : before?.destination_url ?? "")
  if (!destination.ok) return { ok: false, response: badRequest(destination.error) }

  // Sólo se descargan imágenes nuevas o cambiadas (un cambio de estado no vuelve a leerlas).
  for (const [path, url, previous] of [
    [image.storagePath, image.value, before?.image_url],
    [mobileStoragePath, mobileImageUrl, before?.mobile_image_url],
  ] as const) {
    if (!path || url === previous) continue
    const problem = await verifyStoredImage(auth, path, placement)
    if (problem) return { ok: false, response: badRequest(problem) }
  }

  return {
    ok: true,
    values: {
      placement,
      campaign_name: campaignName,
      image_url: image.value,
      mobile_image_url: mobileImageUrl,
      alt_text: (has("alt_text") ? normalizeText(body.alt_text) : before?.alt_text ?? "") || DEFAULT_ALT_TEXT[placement],
      active: has("active") ? body.active === true : before?.active ?? true,
      sort_order: sortOrder,
      starts_at: startsAt,
      ends_at: endsAt,
      destination_url: destination.value,
    },
  }
}

/** Invalida cualquier caché del HOME: un cambio de Admin se ve en la próxima visita (la vigencia se resuelve sola). */
function refreshHome(placements: Array<string | null | undefined>) {
  if (!placements.includes("home")) return
  try {
    revalidatePath("/")
  } catch (error) {
    console.warn("HOME_BANNER_REVALIDATE_FAILED", error instanceof Error ? error.message : error)
  }
}

async function audit(auth: Auth, action: "INSERT" | "UPDATE" | "DELETE", recordId: string, before: unknown, after: unknown) {
  await auth.admin.from("audit_logs").insert({
    table_name: "site_banner_items",
    action,
    record_id: recordId,
    actor_user_id: auth.user.id,
    actor_email: auth.user.email ?? auth.profile.email,
    before_data: before,
    after_data: after,
  })
}

async function getLegacyBanner(auth: Auth) {
  const { data } = await auth.admin
    .from("site_banners")
    .select("key, image_url, alt_text, active, updated_at")
    .eq("key", LEGACY_BANNER_KEY)
    .maybeSingle()

  if (!data?.image_url) return null

  return {
    id: data.key,
    placement: "products",
    image_url: data.image_url,
    alt_text: data.alt_text,
    active: data.active,
    sort_order: 0,
    updated_at: data.updated_at,
    legacy: true,
  }
}

async function loadBanner(auth: Auth, id: string) {
  const { data, error } = await auth.admin.from("site_banner_items").select(BANNER_COLUMNS).eq("id", id).maybeSingle()
  return error || !data ? null : (data as BannerRow)
}

export async function GET(request: Request) {
  const auth = await requireInternalUser(request, [...MANAGE_ROLES])
  if ("error" in auth) return auth.error

  const { searchParams } = new URL(request.url)
  const placement = normalizePlacement(
    searchParams.get("placement") ?? searchParams.get("key")
  )

  if (!placement) {
    return Response.json({ error: "Ubicación de banner inválida." }, { status: 400 })
  }

  const { data, error } = await auth.admin
    .from("site_banner_items")
    .select(BANNER_COLUMNS)
    .eq("placement", placement)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })

  if (error) {
    return databaseErrorResponse(error, SAVE_ERROR)
  }

  // El respaldo heredado (site_banners) sólo existe para Productos.
  const legacyBanner = placement === "products" && !data?.length ? await getLegacyBanner(auth) : null
  const banners = legacyBanner ? [legacyBanner] : data ?? []

  // Hora del servidor: el estado (Programada/Activa/Finalizada) no depende del reloj del navegador.
  return Response.json({ banners, server_now: new Date().toISOString() }, { headers: { "Cache-Control": "no-store" } })
}

export async function POST(request: Request) {
  const auth = await requireInternalUser(request, [...MANAGE_ROLES])
  if ("error" in auth) return auth.error

  const body = (await request.json().catch(() => null)) as BannerBody | null
  if (!body) return badRequest("Completá la ubicación y la imagen del banner.")
  const prepared = await prepareBanner(auth, body, null)
  if (!prepared.ok) return prepared.response

  const { data, error } = await auth.admin
    .from("site_banner_items")
    .insert({
      ...prepared.values,
      created_by: auth.user.id,
      updated_by: auth.user.id,
      updated_at: new Date().toISOString(),
    })
    .select(BANNER_COLUMNS)
    .single()

  if (error) {
    return databaseErrorResponse(error, SAVE_ERROR)
  }

  await audit(auth, "INSERT", data.id, null, data)
  refreshHome([data.placement])

  return Response.json({ banner: data })
}

export async function PATCH(request: Request) {
  const auth = await requireInternalUser(request, [...MANAGE_ROLES])
  if ("error" in auth) return auth.error

  const body = (await request.json().catch(() => null)) as BannerBody | null
  const id = normalizeText(body?.id)

  if (!body || !id) {
    return Response.json(
      { error: "Faltan datos para actualizar el banner." },
      { status: 400 }
    )
  }

  // Control optimista: el formulario (o la lista) manda la versión que vio.
  // Si otro administrador guardó después, no se pisa nada (409).
  const expected = parseBannerVersion(body.expected_updated_at)
  if (!expected) {
    return Response.json({ error: "Recargá los banners antes de guardar: falta la versión que estás editando o no es válida." }, { status: 400 })
  }

  const before = await loadBanner(auth, id)
  if (!before) {
    return Response.json({ error: "Banner no encontrado." }, { status: 404 })
  }
  const conflict = () => Response.json({ error: CONFLICT_MESSAGE, conflict: true }, { status: 409 })
  if (Date.parse(before.updated_at ?? "") !== Date.parse(expected)) return conflict()

  const prepared = await prepareBanner(auth, body, before)
  if (!prepared.ok) return prepared.response

  // La condición sobre updated_at va en el mismo UPDATE: si alguien guardó
  // entre la lectura y la escritura, no se actualiza ninguna fila.
  const { data: rows, error } = await auth.admin
    .from("site_banner_items")
    .update({
      ...prepared.values,
      updated_by: auth.user.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("updated_at", expected)
    .select(BANNER_COLUMNS)

  if (error) {
    return databaseErrorResponse(error, SAVE_ERROR)
  }
  const data = (rows ?? [])[0] as BannerRow | undefined
  if (!data) {
    return (await loadBanner(auth, id)) ? conflict() : Response.json({ error: "Banner no encontrado." }, { status: 404 })
  }

  await audit(auth, "UPDATE", id, before, data)
  refreshHome([before.placement, data.placement])

  return Response.json({ banner: data })
}

export async function DELETE(request: Request) {
  const auth = await requireInternalUser(request, [...MANAGE_ROLES])
  if ("error" in auth) return auth.error

  const { searchParams } = new URL(request.url)
  const id = normalizeText(searchParams.get("id"))

  if (!id) {
    return Response.json({ error: "Falta el banner a eliminar." }, { status: 400 })
  }

  // Control optimista: sólo se elimina la versión que el administrador vio.
  const expected = parseBannerVersion(searchParams.get("expected_updated_at"))
  if (!expected) {
    return Response.json({ error: "Recargá los banners antes de eliminar: falta la versión que estás viendo o no es válida." }, { status: 400 })
  }

  // Un único DELETE condicionado por id y versión: si otro administrador
  // guardó antes, no se elimina ninguna fila (sin ventana entre leer y borrar).
  const { data: rows, error } = await auth.admin
    .from("site_banner_items")
    .delete()
    .eq("id", id)
    .eq("updated_at", expected)
    .select(BANNER_COLUMNS)

  if (error) {
    return databaseErrorResponse(error, SAVE_ERROR)
  }
  const before = (rows ?? [])[0] as BannerRow | undefined
  if (!before) {
    return (await loadBanner(auth, id))
      ? Response.json({ error: DELETE_CONFLICT_MESSAGE, conflict: true }, { status: 409 })
      : Response.json({ error: "Banner no encontrado." }, { status: 404 })
  }

  await audit(auth, "DELETE", id, before, null)
  refreshHome([before.placement])

  return Response.json({ ok: true })
}
