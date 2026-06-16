import { requireOperator } from "@/app/api/admin/clientes/_auth"
import type {
  SupabasePedido,
  SupabasePedidoItem,
  SupabaseProducto,
  SupabaseProductoVariante,
} from "@/lib/supabase/types"

export async function GET(request: Request) {
  const auth = await requireOperator(request)
  if ("error" in auth) return auth.error

  const { data: orderRows, error: ordersError } = await auth.admin
    .from("ordenes")
    .select("*")
    .order("created_at", { ascending: false })

  if (ordersError) {
    return Response.json({ error: ordersError.message }, { status: 500 })
  }

  const pedidos = (orderRows ?? []) as SupabasePedido[]
  if (!pedidos.length) return Response.json({ pedidos })

  const userIds = [
    ...new Set(
      pedidos
        .map((pedido) => pedido.usuario_id)
        .filter((id): id is string => Boolean(id))
    ),
  ]
  const { data: itemRows, error: itemsError } = await auth.admin
    .from("orden_items")
    .select("*")
    .in(
      "orden_id",
      pedidos.map((pedido) => pedido.id)
    )

  if (itemsError) {
    return Response.json({ error: itemsError.message }, { status: 500 })
  }

  const items = (itemRows ?? []) as SupabasePedidoItem[]
  const productIds = [...new Set(items.map((item) => item.producto_id))]
  const variantIds = [
    ...new Set(
      items
        .map((item) => item.variante_id)
        .filter((id): id is number => typeof id === "number")
    ),
  ]
  const [productsResult, variantsResult, profilesResult] = await Promise.all([
    productIds.length
      ? auth.admin.from("productos").select("*").in("id", productIds)
      : Promise.resolve({ data: [], error: null }),
    variantIds.length
      ? auth.admin.from("producto_variantes").select("*").in("id", variantIds)
      : Promise.resolve({ data: [], error: null }),
    userIds.length
      ? auth.admin.from("profiles").select("id, username").in("id", userIds)
      : Promise.resolve({ data: [], error: null }),
  ])

  if (productsResult.error || variantsResult.error || profilesResult.error) {
    return Response.json(
      {
        error:
          productsResult.error?.message ||
          variantsResult.error?.message ||
          profilesResult.error?.message ||
          "No se pudo cargar el detalle de los productos.",
      },
      { status: 500 }
    )
  }

  const productsById = new Map(
    ((productsResult.data ?? []) as SupabaseProducto[]).map((product) => [
      product.id,
      product,
    ])
  )
  const variantsById = new Map(
    ((variantsResult.data ?? []) as SupabaseProductoVariante[]).map((variant) => [
      variant.id,
      variant,
    ])
  )
  const usernamesById = new Map(
    ((profilesResult.data ?? []) as Array<{
      id: string
      username: string | null
    }>).map((profile) => [profile.id, profile.username])
  )
  const itemsByOrder = new Map<number, SupabasePedidoItem[]>()

  for (const item of items) {
    const currentItems = itemsByOrder.get(item.orden_id) ?? []
    currentItems.push({
      ...item,
      productos: productsById.get(item.producto_id) ?? null,
      producto_variantes:
        typeof item.variante_id === "number"
          ? variantsById.get(item.variante_id) ?? null
          : null,
    })
    itemsByOrder.set(item.orden_id, currentItems)
  }

  return Response.json({
    pedidos: pedidos.map((pedido) => ({
      ...pedido,
      total: auth.profile.rol === "operador" ? 0 : pedido.total,
      shipping_cost_real:
        auth.profile.rol === "operador" ? null : pedido.shipping_cost_real,
      shipping_cost_charged:
        auth.profile.rol === "operador" ? null : pedido.shipping_cost_charged,
      transfer_discount_amount:
        auth.profile.rol === "operador"
          ? null
          : pedido.transfer_discount_amount,
      cliente_username: pedido.usuario_id
        ? usernamesById.get(pedido.usuario_id) ?? null
        : null,
      orden_items: (itemsByOrder.get(pedido.id) ?? []).map((item) => ({
        ...item,
        precio: auth.profile.rol === "operador" ? 0 : item.precio,
      })),
    })),
  })
}
