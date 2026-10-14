import { requireInternalUser } from "@/lib/auth/admin-api"
import {
  describeMercadoLibreImportError,
  isMissingImportMigration,
} from "@/lib/mercadolibre/import-validation"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Revierte una importación: borra sólo las ventas que ese lote creó y que
 * nadie modificó después. El conteo esperado evita borrar algo distinto a lo
 * que el usuario confirmó.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error

  const { id } = await params
  if (!UUID_PATTERN.test(id)) return Response.json({ error: "Importación inválida." }, { status: 400 })

  let body: { expectedCount?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return Response.json({ error: "Falta confirmar cuántas ventas se van a revertir." }, { status: 400 })
  }
  const expectedCount = body.expectedCount
  if (typeof expectedCount !== "number" || !Number.isInteger(expectedCount) || expectedCount < 0) {
    return Response.json({ error: "Falta confirmar cuántas ventas se van a revertir." }, { status: 400 })
  }

  const { data, error } = await auth.admin.rpc("revert_mercadolibre_import_batch", {
    p_batch_id: id,
    p_expected_count: expectedCount,
    p_reverted_by: auth.user.id,
  })
  if (error) {
    console.error("ML_IMPORT_REVERT_ERROR", error.message)
    return Response.json(
      { error: describeMercadoLibreImportError(error.message, "No se pudo revertir la importación. No se borró ninguna venta.") },
      { status: isMissingImportMigration(error.message) ? 503 : 409 },
    )
  }

  return Response.json({ result: data })
}
