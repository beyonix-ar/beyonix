import { requireInternalUser } from "@/lib/auth/admin-api"
import { LABEL_ROLES } from "@/lib/labels/api-roles"
import { MAX_BATCH_NAME_LENGTH, batchLabelCount, cleanName, parseBatchItems, parseBatchOutput } from "@/lib/labels/history"
import { LabelStorageUnavailableError, saveLabelBatch } from "@/lib/labels/label-store-server"

const headers = { "Cache-Control": "no-store" }

// Historial de tandas (para repetirlas). Guarda sólo artículo, código y
// copias: al repetir, la cola se revalida contra el catálogo actual.
export async function POST(request: Request) {
  const auth = await requireInternalUser(request, [...LABEL_ROLES])
  if ("error" in auth) return auth.error
  const body = (await request.json().catch(() => null)) as { name?: unknown; items?: unknown; output?: unknown } | null
  const items = parseBatchItems(body?.items)
  const output = parseBatchOutput(body?.output)
  if (!items || !output) return Response.json({ error: "La tanda no es válida." }, { status: 400, headers })
  const labelCount = batchLabelCount(items)
  const name = cleanName(body?.name, MAX_BATCH_NAME_LENGTH) || `Tanda de ${labelCount} etiquetas`
  try {
    return Response.json({ batch: await saveLabelBatch(auth.admin, auth.user.id, { name, items, labelCount, output }) }, { headers })
  } catch (error) {
    if (error instanceof LabelStorageUnavailableError) return Response.json({ error: "Falta aplicar la migración de etiquetas." }, { status: 503, headers })
    return Response.json({ error: "No se pudo guardar la tanda en el historial." }, { status: 500, headers })
  }
}
