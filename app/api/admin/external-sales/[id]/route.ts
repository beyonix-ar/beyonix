import {
  EXTERNAL_SALE_COLUMNS,
  UUID_PATTERN,
  authorizeExternalSales,
  externalSalesDatabaseError,
  jsonError,
  normalizeSaleFields,
  profileNames,
  readJsonObject,
  withReportedProfit,
} from "@/lib/admin/external-sales-api"

type Context = { params: Promise<{ id: string }> }

/** Detalle: datos principales, fila original importada, vínculo de catálogo, tanda e historial. */
export async function GET(request: Request, context: Context) {
  const auth = await authorizeExternalSales(request)
  if ("error" in auth) return auth.error
  const { id } = await context.params
  if (!UUID_PATTERN.test(id)) return jsonError("La venta indicada no es válida.")

  const { data: sale, error } = await auth.admin
    .from("external_sales")
    .select(`${EXTERNAL_SALE_COLUMNS}, source_values`)
    .eq("id", id)
    .maybeSingle()
  if (error) return externalSalesDatabaseError(error.message)
  if (!sale) return jsonError("La venta ya no existe.", 404)
  const row = sale as unknown as Record<string, unknown>

  const [historyResult, batchResult, productResult, variantResult] = await Promise.all([
    auth.admin
      .from("audit_logs")
      .select("id, action, actor_user_id, before_data, after_data, created_at")
      .eq("table_name", "external_sales")
      .eq("record_id", id)
      .order("created_at", { ascending: true })
      .limit(200),
    row.import_batch_id
      ? auth.admin
        .from("external_sale_import_batches")
        .select("id, created_at, source, file_name, stock_mode, rows_imported, status")
        .eq("id", String(row.import_batch_id))
        .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    row.product_id
      ? auth.admin.from("productos").select("id, nombre, sku, activo").eq("id", Number(row.product_id)).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    row.variant_id
      ? auth.admin.from("producto_variantes").select("id, nombre, sku, activo").eq("id", Number(row.variant_id)).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ])
  if (historyResult.error) return externalSalesDatabaseError(historyResult.error.message)

  // Sólo los eventos con actor y alcance propios (las RPC); los registros
  // genéricos del trigger repiten el mismo cambio sin responsable.
  const history = ((historyResult.data ?? []) as Array<Record<string, unknown>>).filter((entry) => {
    const after = entry.after_data as Record<string, unknown> | null
    return typeof after?.scope === "string"
  })
  const names = await profileNames(auth.admin, [
    row.created_by, row.updated_by, row.reversed_by, ...history.map((entry) => entry.actor_user_id),
  ])
  const scopeLabels: Record<string, string> = {
    external_sale_create: "Venta registrada",
    external_sale_edit: "Venta editada",
    external_sale_entry_error: "Anulada por error de carga",
    external_sale_return: "Devolución registrada",
  }

  return Response.json({
    sale: {
      ...withReportedProfit(row),
      source_values: row.source_values ?? null,
      created_by_name: names.get(String(row.created_by)) ?? null,
      reversed_by_name: names.get(String(row.reversed_by)) ?? null,
    },
    batch: batchResult.data ?? null,
    catalog: {
      product: productResult.data ?? null,
      variant: variantResult.data ?? null,
    },
    history: history.map((entry) => {
      const before = (entry.before_data ?? null) as Record<string, unknown> | null
      const after = (entry.after_data ?? {}) as Record<string, unknown>
      const changes = before
        ? ["sale_date", "customer_name", "channel", "sku", "product_name", "quantity", "shipping_amount",
          "payment_method_code", "status", "gross_amount", "declared_profit", "notes"]
          .filter((field) => JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null))
          .map((field) => ({ field, before: before[field] ?? null, after: after[field] ?? null }))
        : []
      return {
        id: entry.id,
        created_at: entry.created_at,
        actor_name: names.get(String(entry.actor_user_id)) ?? null,
        label: scopeLabels[String(after.scope)] ?? "Cambio registrado",
        reason: (after.edit_reason ?? after.reversal_reason ?? null) as string | null,
        changes,
      }
    }),
  }, { headers: { "Cache-Control": "private, no-store" } })
}

/** Edición con control de versión: { version, reason?, changes: { campo: valor } }. */
export async function PATCH(request: Request, context: Context) {
  const auth = await authorizeExternalSales(request)
  if ("error" in auth) return auth.error
  const { id } = await context.params
  if (!UUID_PATTERN.test(id)) return jsonError("La venta indicada no es válida.")

  const body = await readJsonObject(request)
  const version = Number(body?.version)
  const changes = body?.changes
  if (!body || !Number.isInteger(version) || version < 1 || !changes || typeof changes !== "object" || Array.isArray(changes)) {
    return jsonError("Los cambios de la venta no son válidos.")
  }
  const patch = normalizeSaleFields(changes as Record<string, unknown>, false)
  if (typeof patch === "string") return jsonError(patch)
  if (!Object.keys(patch).length) return jsonError("No hay cambios para guardar.")
  if ("sku" in patch && !patch.sku) return jsonError("Indicá el SKU del producto vendido.")
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : null

  const { data, error } = await auth.admin.rpc("update_external_sale", {
    p_id: id,
    p_expected_version: version,
    p_patch: patch,
    p_actor_id: auth.user.id,
    p_reason: reason || null,
  })
  if (error) return externalSalesDatabaseError(error.message)
  return Response.json({ sale: withReportedProfit(data as Record<string, unknown>) })
}
