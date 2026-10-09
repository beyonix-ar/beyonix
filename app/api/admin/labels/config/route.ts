import { requireInternalUser } from "@/lib/auth/admin-api"
import { LABEL_ROLES } from "@/lib/labels/api-roles"
import { LabelStorageUnavailableError, loadLabelConfig, saveLabelPreference } from "@/lib/labels/label-store-server"
import { normalizeLabelSettings } from "@/lib/labels/settings"

const headers = { "Cache-Control": "no-store" }
const unavailable = () => Response.json(
  { presets: [], preference: null, batches: [], storageUnavailable: true },
  { headers },
)

// Presets compartidos + última configuración del usuario + tandas recientes,
// en una sola respuesta.
export async function GET(request: Request) {
  const auth = await requireInternalUser(request, [...LABEL_ROLES])
  if ("error" in auth) return auth.error
  try {
    return Response.json({ ...(await loadLabelConfig(auth.admin, auth.user.id)), storageUnavailable: false }, { headers })
  } catch (error) {
    if (error instanceof LabelStorageUnavailableError) return unavailable()
    return Response.json({ error: "No se pudo cargar la configuración de etiquetas." }, { status: 500, headers })
  }
}

// Recordar la última configuración (tamaño, salida, márgenes, contenido...).
export async function PUT(request: Request) {
  const auth = await requireInternalUser(request, [...LABEL_ROLES])
  if ("error" in auth) return auth.error
  const body = (await request.json().catch(() => null)) as { settings?: unknown } | null
  if (!body || typeof body.settings !== "object" || body.settings === null || Array.isArray(body.settings)) {
    return Response.json({ error: "La configuración no es válida." }, { status: 400, headers })
  }
  const settings = normalizeLabelSettings(body.settings)
  try {
    await saveLabelPreference(auth.admin, auth.user.id, settings)
    return Response.json({ settings }, { headers })
  } catch (error) {
    if (error instanceof LabelStorageUnavailableError) return Response.json({ error: "Falta aplicar la migración de etiquetas." }, { status: 503, headers })
    return Response.json({ error: "No se pudo guardar la configuración." }, { status: 500, headers })
  }
}
