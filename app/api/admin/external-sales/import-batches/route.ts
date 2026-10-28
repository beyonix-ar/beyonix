import {
  authorizeExternalSales,
  externalSalesDatabaseError,
  profileNames,
} from "@/lib/admin/external-sales-api"

/** Historial de importaciones, con cuántas ventas de cada tanda se modificaron después. */
export async function GET(request: Request) {
  const auth = await authorizeExternalSales(request)
  if ("error" in auth) return auth.error

  const { data, error } = await auth.admin
    .from("external_sale_import_batches")
    .select("id, created_at, created_by, source, file_name, stock_mode, rows_read, rows_valid, rows_imported, status, reverted_at, reverted_by, revert_reason")
    .order("created_at", { ascending: false })
    .limit(200)
  if (error) return externalSalesDatabaseError(error.message)
  const batches = (data ?? []) as Array<Record<string, unknown>>

  const modifiedByBatch = new Map<string, number>()
  if (batches.length) {
    const { data: modified, error: modifiedError } = await auth.admin
      .from("external_sales")
      .select("import_batch_id")
      .in("import_batch_id", batches.map((batch) => String(batch.id)))
      .or("modified_after_import_at.not.is.null,status.eq.reversed")
    if (modifiedError) return externalSalesDatabaseError(modifiedError.message)
    for (const row of (modified ?? []) as Array<{ import_batch_id: string }>) {
      modifiedByBatch.set(row.import_batch_id, (modifiedByBatch.get(row.import_batch_id) ?? 0) + 1)
    }
  }
  const names = await profileNames(auth.admin, batches.flatMap((batch) => [batch.created_by, batch.reverted_by]))

  return Response.json({
    batches: batches.map((batch) => ({
      ...batch,
      created_by_name: names.get(String(batch.created_by)) ?? null,
      reverted_by_name: names.get(String(batch.reverted_by)) ?? null,
      // En una tanda deshecha todas figuran anuladas: sólo cuenta en las vigentes.
      modified_sales: batch.status === "completed" ? modifiedByBatch.get(String(batch.id)) ?? 0 : 0,
    })),
  }, { headers: { "Cache-Control": "private, no-store" } })
}
