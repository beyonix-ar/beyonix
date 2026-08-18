import { requireOperator } from "@/app/api/admin/clientes/_auth"
import { ORDER_CLAIM_BUCKET } from "@/lib/order-claims"
import { expireOverdueTransferOrders } from "@/lib/orders/transfer-expiration"
import type {
  SupabasePedido,
  SupabasePedidoItem,
  SupabaseOrderCreditNote,
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

  const notificationView =
    new URL(request.url).searchParams.get("view") === "notifications"
  const url = new URL(request.url)
  const requestedLimit = Number(url.searchParams.get("limit") ?? 50)
  const requestedOffset = Number(url.searchParams.get("offset") ?? 0)
  const orderId = Number(url.searchParams.get("id"))
  const limit = Math.min(100, Math.max(10, Math.floor(requestedLimit)))
  const offset = Math.max(0, Math.floor(requestedOffset))
  const notificationColumns = [
    "id",
    "created_at",
    "admin_visible_at",
    "estado",
    "financial_status",
    "payment_method_id",
    "payment_id",
    "payment_status",
    "paid_at",
    "payment_confirmed_at",
    "payment_confirmed_amount",
    "total",
    "payment_proof_url",
    "payment_proof_uploaded_at",
    "invoice_status",
    "invoice_cae",
    "invoice_created_at",
    "cancelled_at",
    "cancellation_requested_at",
    "refund_pending_at",
  ].join(", ")

  if (!notificationView) {
    await expireOverdueTransferOrders(auth.admin)
  }

  let ordersQuery = auth.admin
    .from("ordenes")
    .select(notificationView ? notificationColumns : "*", {
      count: notificationView ? undefined : "exact",
    })

  if (notificationView) {
    ordersQuery = ordersQuery
      .not("admin_visible_at", "is", null)
      .order("admin_visible_at", { ascending: false })
      .limit(500)
  } else if (Number.isInteger(orderId) && orderId > 0) {
    ordersQuery = ordersQuery.eq("id", orderId)
  } else {
    ordersQuery = ordersQuery
      .not("admin_visible_at", "is", null)
      .order("admin_visible_at", { ascending: false })
      .range(offset, offset + limit - 1)
  }

  const { data: orderRows, error: ordersError, count } = await ordersQuery

  if (ordersError) {
    return Response.json({ error: ordersError.message }, { status: 500 })
  }

  const pedidos = (orderRows ?? []) as unknown as SupabasePedido[]
  if (!pedidos.length) {
    return Response.json({ pedidos, total: notificationView ? 0 : count ?? 0 })
  }

  if (notificationView) {
    const { data: claims, error: claimsError } = await auth.admin
      .from("order_claims")
      .select("*, order_claim_messages(*)")
      .in(
        "order_id",
        pedidos.map((pedido) => pedido.id),
      )
      .order("created_at", { ascending: false })

    if (claimsError) {
      return Response.json({ error: claimsError.message }, { status: 500 })
    }

    const claimsByOrder = new Map<number, typeof claims>()
    for (const claim of claims ?? []) {
      const current = claimsByOrder.get(claim.order_id) ?? []
      current.push(claim)
      claimsByOrder.set(claim.order_id, current)
    }

    return Response.json({
      pedidos: pedidos.map((pedido) => ({
        ...pedido,
        total: auth.profile.rol === "operador" ? 0 : pedido.total,
        order_claims: claimsByOrder.get(pedido.id) ?? [],
        orden_items: [],
        order_refund_proofs: [],
        order_audit_events: [],
      })),
      total: pedidos.length,
    })
  }

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
    creditNotesResult,
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
    auth.admin
      .from("order_credit_notes")
      .select("*, order_credit_note_items(*)")
      .in(
        "order_id",
        pedidos.map((pedido) => pedido.id),
      )
      .order("created_at", { ascending: false }),
  ])

  if (
    productsResult.error ||
    variantsResult.error ||
    profilesResult.error ||
    claimsResult.error ||
    refundProofsResult.error ||
    auditEventsResult.error
    || creditNotesResult.error
  ) {
    return Response.json(
      {
        error:
          productsResult.error?.message ||
          variantsResult.error?.message ||
          claimsResult.error?.message ||
          refundProofsResult.error?.message ||
          auditEventsResult.error?.message ||
          creditNotesResult.error?.message ||
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
  const creditNotesByOrder = new Map<number, SupabaseOrderCreditNote[]>()

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

  const claimRows = claimsResult.data ?? []
  // Antes: una llamada a createSignedUrl por archivo (N+1 contra Supabase
  // Storage en cada carga/recarga del listado). createSignedUrls firma todos
  // los archivos de todos los reclamos de la página en una sola llamada.
  const claimFileEntries = claimRows.flatMap((claim) =>
    (claim.order_claim_files ?? []).map((file: any) => ({
      claimId: claim.id,
      file,
      path: stripClaimBucket(file.file_path),
    })),
  )
  const signedUrlByPath = new Map<string, string | null>()
  if (claimFileEntries.length) {
    const { data: signedUrls } = await auth.admin.storage
      .from(ORDER_CLAIM_BUCKET)
      .createSignedUrls(
        claimFileEntries.map((entry) => entry.path),
        300,
      )
    for (const signed of signedUrls ?? []) {
      if (signed.path) signedUrlByPath.set(signed.path, signed.signedUrl ?? null)
    }
  }

  const signedFilesByClaimId = new Map<number, any[]>()
  for (const entry of claimFileEntries) {
    const current = signedFilesByClaimId.get(entry.claimId) ?? []
    current.push({
      ...entry.file,
      signedUrl: signedUrlByPath.get(entry.path) ?? null,
    })
    signedFilesByClaimId.set(entry.claimId, current)
  }

  for (const claim of claimRows) {
    const currentClaims = claimsByOrder.get(claim.order_id) ?? []
    currentClaims.push({
      ...claim,
      order_claim_files: signedFilesByClaimId.get(claim.id) ?? [],
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

  for (const note of (creditNotesResult.data ?? []) as SupabaseOrderCreditNote[]) {
    const currentNotes = creditNotesByOrder.get(note.order_id) ?? []
    currentNotes.push(note)
    creditNotesByOrder.set(note.order_id, currentNotes)
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
      order_credit_notes: creditNotesByOrder.get(pedido.id) ?? [],
    })),
    total: count ?? pedidos.length,
  })
}
