import { requireInternalUser } from "@/lib/auth/admin-api"
import { canViewSensitiveNumbers } from "@/lib/auth/roles"
import {
  buildStandaloneCostItems,
  type StandaloneCostRow,
} from "@/lib/business/standalone-cost-items"

type CostKind = "product" | "expense"

function unauthorized() {
  return Response.json(
    { error: "No tenés permisos para administrar costos." },
    { status: 403 },
  )
}

function text(value: unknown, max = 500) {
  if (typeof value !== "string") return null
  const normalized = value.trim()
  return normalized ? normalized.slice(0, max) : null
}

function amount(value: unknown) {
  if (value === "" || value == null) return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function positiveInteger(value: unknown) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function date(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null
  }

  return Number.isNaN(new Date(`${value}T00:00:00Z`).getTime()) ? null : value
}

async function authorize(request: Request) {
  const auth = await requireInternalUser(request)
  if ("error" in auth) return auth
  if (!canViewSensitiveNumbers(auth.profile.rol)) {
    return { error: unauthorized() }
  }
  return auth
}

async function validateVariant(
  admin: Awaited<ReturnType<typeof requireInternalUser>> extends infer T
    ? T extends { admin: infer A }
      ? A
      : never
    : never,
  productId: number,
  variantId: number | null,
) {
  if (!variantId) return true

  const { data, error } = await admin
    .from("producto_variantes")
    .select("id")
    .eq("id", variantId)
    .eq("producto_id", productId)
    .maybeSingle()

  return !error && Boolean(data)
}

export async function GET(request: Request) {
  const auth = await authorize(request)
  if ("error" in auth) return auth.error

  const [catalogResult, productCostsResult, expensesResult] = await Promise.all([
    auth.admin
      .from("productos")
      .select("id, nombre, sku, activo, stock, producto_variantes(id, nombre, activo, stock)")
      .order("nombre", { ascending: true }),
    auth.admin
      .from("product_cost_entries")
      .select("*")
      .order("purchase_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1000),
    auth.admin
      .from("business_expenses")
      .select("*")
      .order("expense_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1000),
  ])

  const error = catalogResult.error || productCostsResult.error || expensesResult.error
  if (error) {
    const missingTables = /product_cost_entries|business_expenses|sku|created_from_costs|schema cache/i.test(
      error.message,
    )
    return Response.json(
      {
        error: missingTables
          ? /sku|created_from_costs/i.test(error.message)
            ? "Falta aplicar la migración 085_cost_items_shared_catalog.sql en Supabase."
            : "Falta aplicar la migración 080_business_costs.sql en Supabase."
          : "No se pudieron cargar los costos reales.",
      },
      { status: missingTables ? 503 : 500 },
    )
  }

  const costRows = (productCostsResult.data ?? []) as StandaloneCostRow[]
  const latestSkuByProduct = new Map<number, string>()
  costRows.forEach((row) => {
    if (row.product_id != null && row.sku?.trim() && !latestSkuByProduct.has(row.product_id)) {
      latestSkuByProduct.set(row.product_id, row.sku.trim())
    }
  })
  const catalog = [
    ...(catalogResult.data ?? []).map((product) => ({
      ...product,
      sku: product.sku ?? latestSkuByProduct.get(Number(product.id)) ?? null,
      standalone_key: null,
    })),
    ...buildStandaloneCostItems(costRows).map((item) => ({
      id: `cost:${item.key}`,
      nombre: item.nombre,
      activo: true,
      stock: null,
      sku: item.sku,
      standalone_key: item.key,
      producto_variantes: [],
    })),
  ].sort((a, b) => a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" }))

  return Response.json({
    catalog,
    productCosts: costRows,
    expenses: expensesResult.data ?? [],
  })
}

export async function POST(request: Request) {
  const auth = await authorize(request)
  if ("error" in auth) return auth.error

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const kind = body?.kind as CostKind | undefined

  if (kind === "product") {
    const productId = body?.productId ? positiveInteger(body.productId) : null
    const variantId = body?.variantId ? positiveInteger(body.variantId) : null
    const articleName = text(body?.articleName, 180)
    const purchaseDate = date(body?.purchaseDate)
    const quantity = positiveInteger(body?.quantity)
    const unitCost = amount(body?.unitCost)

    if ((!productId && !articleName) || !purchaseDate || !quantity || unitCost == null) {
      return Response.json(
        { error: "Artículo, fecha, cantidad y costo unitario son obligatorios." },
        { status: 400 },
      )
    }

    if (variantId && !productId) {
      return Response.json(
        { error: "No se puede asignar una variante a un artículo no catalogado." },
        { status: 400 },
      )
    }

    if (productId && !(await validateVariant(auth.admin, productId, variantId))) {
      return Response.json(
        { error: "La variante no pertenece al producto seleccionado." },
        { status: 400 },
      )
    }

    const extraAmounts = {
      freight_cost: amount(body?.freightCost),
      tax_cost: amount(body?.taxCost),
      commission_cost: amount(body?.commissionCost),
      other_cost: amount(body?.otherCost),
    }
    if (Object.values(extraAmounts).some((value) => value == null)) {
      return Response.json({ error: "Los importes no pueden ser negativos." }, { status: 400 })
    }

    const { data: inserted, error } = await auth.admin
      .from("product_cost_entries")
      .insert({
        product_id: productId,
        variant_id: variantId,
        article_name: productId ? null : articleName,
        sku: text(body?.sku, 120),
        purchase_date: purchaseDate,
        quantity,
        unit_cost: unitCost,
        ...extraAmounts,
        supplier: text(body?.supplier, 180),
        document_type: text(body?.documentType, 80),
        document_number: text(body?.documentNumber, 120),
        payment_method: text(body?.paymentMethod, 100),
        notes: text(body?.notes, 1000),
        created_by: auth.user.id,
      })
      .select("*")
      .single()

    if (error) {
      const missingSkuMigration = /sku/i.test(error.message)
      const missingMigration = /sku|article_name|product_id|null value|schema cache/i.test(
        error.message,
      )
      return Response.json(
        {
          error: missingMigration
            ? missingSkuMigration
              ? "Falta aplicar la migración 084_product_cost_sku.sql en Supabase."
              : "Falta aplicar la migración 083_uncatalogued_product_costs.sql en Supabase."
            : "No se pudo guardar la compra.",
        },
        { status: missingMigration ? 503 : 500 },
      )
    }
    return Response.json({ item: inserted }, { status: 201 })
  }

  if (kind === "expense") {
    const expenseDate = date(body?.expenseDate)
    const category = text(body?.category, 100)
    const expenseAmount = amount(body?.amount)
    const recurrence = text(body?.recurrence, 20) ?? "unico"
    const status = body?.status === "pendiente" ? "pendiente" : "pagado"

    if (!expenseDate || !category || expenseAmount == null) {
      return Response.json(
        { error: "Fecha, categoría e importe son obligatorios." },
        { status: 400 },
      )
    }

    if (!new Set(["unico", "mensual", "bimestral", "trimestral", "semestral", "anual"]).has(recurrence)) {
      return Response.json({ error: "La recurrencia no es válida." }, { status: 400 })
    }

    const { data: inserted, error } = await auth.admin
      .from("business_expenses")
      .insert({
        expense_date: expenseDate,
        category,
        description: text(body?.description, 240),
        amount: expenseAmount,
        recurrence,
        status,
        supplier: text(body?.supplier, 180),
        payment_method: text(body?.paymentMethod, 100),
        document_type: text(body?.documentType, 80),
        document_number: text(body?.documentNumber, 120),
        tax_deductible: body?.taxDeductible === true,
        notes: text(body?.notes, 1000),
        created_by: auth.user.id,
      })
      .select("*")
      .single()

    if (error) {
      return Response.json({ error: "No se pudo guardar el gasto." }, { status: 500 })
    }
    return Response.json({ item: inserted }, { status: 201 })
  }

  return Response.json({ error: "Tipo de costo no válido." }, { status: 400 })
}

export async function PATCH(request: Request) {
  const auth = await authorize(request)
  if ("error" in auth) return auth.error

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const id = text(body?.id, 100)
  const productId = body?.productId ? positiveInteger(body.productId) : null
  const variantId = body?.variantId ? positiveInteger(body.variantId) : null
  const articleName = text(body?.articleName, 180)
  const purchaseDate = date(body?.purchaseDate)
  const quantity = positiveInteger(body?.quantity)
  const unitCost = amount(body?.unitCost)

  if (!id || (!productId && !articleName) || !purchaseDate || !quantity || unitCost == null) {
    return Response.json(
      { error: "Artículo, fecha, cantidad y costo unitario son obligatorios." },
      { status: 400 },
    )
  }

  if (variantId && !productId) {
    return Response.json(
      { error: "No se puede asignar una variante a un artículo no catalogado." },
      { status: 400 },
    )
  }

  if (productId && !(await validateVariant(auth.admin, productId, variantId))) {
    return Response.json(
      { error: "La variante no pertenece al producto seleccionado." },
      { status: 400 },
    )
  }

  const extraAmounts = {
    freight_cost: amount(body?.freightCost),
    tax_cost: amount(body?.taxCost),
    commission_cost: amount(body?.commissionCost),
    other_cost: amount(body?.otherCost),
  }
  if (Object.values(extraAmounts).some((value) => value == null)) {
    return Response.json({ error: "Los importes no pueden ser negativos." }, { status: 400 })
  }

  const { data: updated, error } = await auth.admin
    .from("product_cost_entries")
    .update({
      product_id: productId,
      variant_id: variantId,
      article_name: productId ? null : articleName,
      sku: text(body?.sku, 120),
      purchase_date: purchaseDate,
      quantity,
      unit_cost: unitCost,
      ...extraAmounts,
      supplier: text(body?.supplier, 180),
      document_type: text(body?.documentType, 80),
      document_number: text(body?.documentNumber, 120),
      payment_method: text(body?.paymentMethod, 100),
      notes: text(body?.notes, 1000),
    })
    .eq("id", id)
    .select("*")
    .maybeSingle()

  if (error) {
    const missingMigration = /sku|article_name|product_id|null value|schema cache/i.test(
      error.message,
    )
    return Response.json(
      {
        error: missingMigration
          ? "Falta aplicar la migración 084_product_cost_sku.sql en Supabase."
          : "No se pudo actualizar la compra.",
      },
      { status: missingMigration ? 503 : 500 },
    )
  }
  if (!updated) {
    return Response.json({ error: "La compra que querés editar ya no existe." }, { status: 404 })
  }

  return Response.json({ item: updated })
}

export async function DELETE(request: Request) {
  const auth = await authorize(request)
  if ("error" in auth) return auth.error

  const url = new URL(request.url)
  const kind = url.searchParams.get("kind") as CostKind | null
  const id = url.searchParams.get("id")
  const table = kind === "product"
    ? "product_cost_entries"
    : kind === "expense"
      ? "business_expenses"
      : null

  if (!table || !id) {
    return Response.json({ error: "Movimiento inválido." }, { status: 400 })
  }

  const { error } = await auth.admin.from(table).delete().eq("id", id)
  if (error) {
    return Response.json({ error: "No se pudo eliminar el movimiento." }, { status: 500 })
  }

  return Response.json({ success: true })
}
