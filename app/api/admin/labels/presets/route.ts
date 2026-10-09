import { requireInternalUser } from "@/lib/auth/admin-api"
import { LABEL_ROLES } from "@/lib/labels/api-roles"
import { parsePresetPayload } from "@/lib/labels/history"
import {
  LabelPresetConflictError,
  LabelStorageUnavailableError,
  deleteLabelPreset,
  saveLabelPreset,
} from "@/lib/labels/label-store-server"

const headers = { "Cache-Control": "no-store" }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function storageError(error: unknown, fallback: string) {
  if (error instanceof LabelPresetConflictError) return Response.json({ error: error.message, code: "PRESET_EXISTS" }, { status: 409, headers })
  if (error instanceof LabelStorageUnavailableError) return Response.json({ error: "Falta aplicar la migración de etiquetas." }, { status: 503, headers })
  return Response.json({ error: fallback }, { status: 500, headers })
}

export async function POST(request: Request) {
  const auth = await requireInternalUser(request, [...LABEL_ROLES])
  if ("error" in auth) return auth.error
  const payload = parsePresetPayload(await request.json().catch(() => null))
  if (!payload) return Response.json({ error: "Ingresá un nombre para el preset." }, { status: 400, headers })
  try {
    return Response.json({ preset: await saveLabelPreset(auth.admin, auth.user.id, payload) }, { headers })
  } catch (error) {
    return storageError(error, "No se pudo guardar el preset.")
  }
}

export async function DELETE(request: Request) {
  const auth = await requireInternalUser(request, [...LABEL_ROLES])
  if ("error" in auth) return auth.error
  const id = new URL(request.url).searchParams.get("id") ?? ""
  if (!UUID.test(id)) return Response.json({ error: "El preset indicado no es válido." }, { status: 400, headers })
  try {
    await deleteLabelPreset(auth.admin, id)
    return Response.json({ deleted: true }, { headers })
  } catch (error) {
    return storageError(error, "No se pudo eliminar el preset.")
  }
}
