import { requireOperator } from "@/app/api/admin/clientes/_auth"
import { ORDER_CLAIM_BUCKET } from "@/lib/order-claims"
import { expireOverdueTransferOrders } from "@/lib/orders/transfer-expiration"
import type {
  SupabasePedido,
  SupabasePedidoItem,
  SupabaseOrderAuditEvent,
  SupabaseOrderRefundProof,
  SupabaseProducto,
  SupabaseProductoVariante,
} from "@/lib/supabase/types"

function stripClaimBucket(path: string) {
  return path.startsWith(`${ORDER_CLAIM_BUCKET}/`)
    ? path.slice(ORDER_CLAIM_BUCKET.length + 1)
    : path
}

export async function GET(request: Request) {
  const auth = await requireOperator(request)
  if ("error" in auth) return auth.error

  await expireOverdueTransferOrders(auth.admin)

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
  const [
    productsResult,
    variantsResult,
    profilesResult,
    claimsResult,
    refundProofsResult,
    auditEventsResult,
  ] = await Promise.all([
    productIds.length
      ? auth.admin.from("productos").select("*").in("id", productIds)
      : Promise.resolve({ data: [], error: null }),
    variantIds.length
      ? auth.admin.from("producto_variantes").select("*").in("id", variantIds)
      : Promise.resolve({ data: [], error: null }),
    userIds.length
      ? auth.admin.from("profiles").select("id, username, nombre, email").in("id", userIds)
      : Promise.resolve({ data: [], error: null }),
    auth.admin
      .from("order_claims")
      .select("*, order_claim_files(*), order_claim_messages(*)")
      .in(
        "order_id",
        pedidos.map((pedido) => pedido.id)
      )
      .order("created_at", { ascending: false }),
    auth.admin
      .from("order_refund_proofs")
      .select("*")
      .in(
        "order_id",
        pedidos.map((pedido) => pedido.id)
      )
      .order("created_at", { ascending: false }),
    auth.admin
      .from("order_audit_events")
      .select("*")
      .in(
        "order_id",
        pedidos.map((pedido) => pedido.id)
      )
      .order("created_at", { ascending: true }),
  ])

  if (
    productsResult.error ||
    variantsResult.error ||
    profilesResult.error ||
    claimsResult.error ||
    refundProofsResult.error ||
    auditEventsResult.error
  ) {
    return Response.json(
      {
        error:
          productsResult.error?.message ||
          variantsResult.error?.message ||
          claimsResult.error?.message ||
          refundProofsResult.error?.message ||
          auditEventsResult.error?.message ||
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
  const profilesById = new Map(
    ((profilesResult.data ?? []) as Array<{
      id: string
      username: string | null
      nombre: string | null
      email: string | null
    }>).map((profile) => [profile.id, profile])
  )
  const itemsByOrder = new Map<number, SupabasePedidoItem[]>()
  const claimsByOrder = new Map<number, any[]>()
  const refundProofsByOrder = new Map<number, SupabaseOrderRefundProof[]>()
  const auditEventsByOrder = new Map<number, SupabaseOrderAuditEvent[]>()

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

  for (const claim of claimsResult.data ?? []) {
    const signedFiles = await Promise.all(
      (claim.order_claim_files ?? []).map(async (file: any) => {
        const { data } = await auth.admin.storage
          .from(ORDER_CLAIM_BUCKET)
          .createSignedUrl(stripClaimBucket(file.file_path), 300)

        return {
          ...file,
          signedUrl: data?.signedUrl ?? null,
        }
      })
    )
    const currentClaims = claimsByOrder.get(claim.order_id) ?? []
    currentClaims.push({
      ...claim,
      order_claim_files: signedFiles,
    })
    claimsByOrder.set(claim.order_id, currentClaims)
  }

  for (const proof of (refundProofsResult.data ?? []) as SupabaseOrderRefundProof[]) {
    const currentProofs = refundProofsByOrder.get(proof.order_id) ?? []
    currentProofs.push(proof)
    refundProofsByOrder.set(proof.order_id, currentProofs)
  }

  for (const event of (auditEventsResult.data ?? []) as SupabaseOrderAuditEvent[]) {
    const currentEvents = auditEventsByOrder.get(event.order_id) ?? []
    currentEvents.push(event)
    auditEventsByOrder.set(event.order_id, currentEvents)
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
        ? profilesById.get(pedido.usuario_id)?.username ?? null
        : null,
      cliente_nombre_completo: (() => {
        const profile = pedido.usuario_id
          ? profilesById.get(pedido.usuario_id)
          : null
        const profileName = profile?.nombre?.trim()

        return (
          profileName ||
          pedido.cliente_nombre?.trim() ||
          profile?.username?.trim() ||
          pedido.cliente_email?.trim() ||
          null
        )
      })(),
      orden_items: (itemsByOrder.get(pedido.id) ?? []).map((item) => ({
        ...item,
        precio: auth.profile.rol === "operador" ? 0 : item.precio,
      })),
      order_claims: claimsByOrder.get(pedido.id) ?? [],
      order_refund_proofs: refundProofsByOrder.get(pedido.id) ?? [],
      order_audit_events: auditEventsByOrder.get(pedido.id) ?? [],
    })),
  })
}
