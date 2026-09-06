"use client"

import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type ReactNode, type RefObject } from "react"
import {
  CheckCircle2,
  ChevronDown,
  CreditCard,
  Download,
  Eye,
  FileText,
  MessageSquare,
  Package,
  PackageCheck,
  Pencil,
  Play,
  Send,
  ShieldCheck,
  Upload,
  XCircle,
  X,
} from "lucide-react"

import {
  AdminButton,
  AdminModal,
  AdminSecondaryButton,
  AdminSelect,
  adminControlClassName,
} from "@/app/admin/components/admin-controls"
import { formatPrice } from "@/app/admin/sections/productos/helpers"
import { useAuth } from "@/context/auth-context"
import { ADMIN_SENSITIVE_DANGER } from "@/lib/admin/admin-sensitive-visuals"
import { notifyOrderNotificationsChanged } from "@/lib/admin/order-notifications"
import { getCuentaItemImage } from "@/lib/account/account-utils"
import { getOrderClaimResolutionLabel, getPendingRefundNotes } from "@/lib/order-claims"
import {
  isClaimVisibleForMode,
  shouldShowReturnInventoryPanel,
} from "@/lib/orders/claim-visibility"
import { shouldPollSingleClaim } from "@/lib/orders/claim-polling"
import { supabase } from "@/lib/supabase/client"
import type {
  OrderClaimResolution,
  OrderClaimStatus,
  SupabaseOrderClaimFile,
  SupabaseOrderClaimMessage,
  SupabaseOrderClaim,
  SupabasePedido,
  SupabasePedidoItem,
} from "@/lib/supabase/types"

export const PROBLEM_LABELS: Record<string, string> = {
  danado: "Producto dañado",
  incorrecto: "Producto incorrecto",
  falla: "Producto con falla",
  faltante: "Faltó un producto",
  cantidad_menor: "Menos cantidad recibida",
  cancelar_compra: "Cancelar compra",
  devolucion: "Solicitud anterior",
  no_llego: "Solicitud anterior",
  cambio_producto: "Solicitud anterior",
  cambio_color: "Solicitud anterior",
  cambio_cantidad: "Solicitud anterior",
  modificar_envio: "Solicitud anterior",
  otro_pre_despacho: "Solicitud anterior",
  consulta_pedido: "Mensaje de ayuda",
  otro: "Otro problema",
}

const STATUS_OPTIONS: Array<{ value: OrderClaimStatus; label: string }> = [
  { value: "recibido", label: "Reclamo recibido" },
  { value: "en_revision", label: "En revisión por BEYONIX" },
  { value: "falta_informacion", label: "Esperando respuesta del cliente" },
  { value: "aprobado", label: "Solución en proceso" },
  { value: "reintegro_pendiente", label: "Reintegro pendiente" },
  { value: "cambio_pendiente", label: "Solución en proceso" },
  { value: "cupon_pendiente", label: "Cupón pendiente" },
  { value: "reemplazo_enviado", label: "Solución en proceso" },
  { value: "rechazado", label: "Rechazado" },
  { value: "cerrado", label: "Reclamo finalizado" },
]

const RESOLUTION_OPTIONS: Array<{
  value: Exclude<OrderClaimResolution, "rechazado">
  label: string
}> = [
  {
    value: "cambio_producto",
    label: "Cambio del producto",
  },
  {
    value: "envio_unidad_faltante",
    label: "Enviar unidad faltante",
  },
  {
    value: "cupon_descuento",
    label: "Nota de crédito por diferencia",
  },
  {
    value: "reintegro_total",
    label: "Reembolso",
  },
]

const REJECTION_REASONS = [
  "Evidencia insuficiente",
  "Daño por uso indebido",
  "Reclamo fuera del plazo aplicable",
  "El inconveniente no corresponde a una falla de origen",
  "Producto alterado o intervenido",
  "Otro",
]

type ClaimAction = "approve" | "reject" | "close" | "approve_cancellation" | "reject_cancellation"

function formatDate(value?: string | null) {
  if (!value) return "Sin fecha"

  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date(value))
}

function formatConversationClosedDate(value = new Date()) {
  return new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(value)
}

function formatFileSize(bytes?: number | null) {
  if (!bytes || bytes <= 0) return "Sin tamaño"
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// Versión local y mínima del mismo mapeo que ya existe en
// admin-pedidos.tsx (getCompactPaymentMethodLabel) -- no se importa desde
// ahí porque ese archivo importa este componente (AdminClaimManager),
// y hacerlo al revés generaría un import circular entre ambos módulos.
function getClaimSummaryPaymentLabel(pedido: SupabasePedido) {
  if (pedido.payment_method_id === "transferencia") return "Transferencia"
  if (pedido.payment_method_id === "mercadopago" || pedido.payment_id) return "Mercado Pago"
  if (pedido.payment_method_id === "customer_credit") return "Saldo a favor"
  return "Medio de pago sin datos"
}

function sortUniqueMessages(messages: SupabaseOrderClaim["order_claim_messages"] = []) {
  const seen = new Set<number>()

  return [...messages]
    .sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at))
    .filter((message) => {
      if (seen.has(message.id)) return false
      seen.add(message.id)
      return true
    })
}

function getClaimMessageText(message: string) {
  const match = message.match(/^Producto afectado:\s*.+?(?:\r?\n){2}([\s\S]*)$/)
  return match?.[1]?.trim() || message
}

function getCustomerMentionName(pedido: SupabasePedido) {
  const candidates = [
    pedido.cliente_nombre_completo,
    pedido.cliente_nombre,
    pedido.cliente_username,
    pedido.cliente_email,
  ]

  return candidates.find((value) => value?.trim())?.trim() ?? ""
}

function getConversationStatusLabel(claim: SupabaseOrderClaim, messages: SupabaseOrderClaimMessage[]) {
  if (claim.status === "cerrado") return "Finalizado"
  if (claim.status === "rechazado") return "Rechazado"
  if (claim.status === "falta_informacion") return "Esperando cliente"
  if (messages[messages.length - 1]?.author_role !== "cliente") return "Respondido por BEYONIX"
  return "Abierto"
}

function getFileTypeLabel(mimeType: string) {
  if (mimeType.startsWith("image/")) return "Imagen"
  if (mimeType.startsWith("video/")) return "Video"
  if (mimeType === "application/pdf") return "PDF"
  return "Archivo"
}

function getStatusTone(status: OrderClaimStatus, cancellation = false) {
  if (cancellation && status === "cerrado") return "bg-slate-700 text-slate-100 border-slate-400/45"
  if (status === "recibido") return "bg-amber-900/80 text-amber-100 border-amber-300/50"
  if (status === "en_revision") return "bg-[#112A43] text-blue-100 border-blue-300/55"
  if (status === "falta_informacion") return "bg-indigo-900/80 text-indigo-100 border-indigo-300/55"
  if (["aprobado", "reintegro_pendiente", "cambio_pendiente", "cupon_pendiente", "reemplazo_enviado"].includes(status)) {
    return "bg-emerald-900/80 text-emerald-100 border-emerald-300/50"
  }
  if (status === "rechazado") return "bg-red-950/85 text-red-100 border-red-300/50"
  if (status === "cerrado") return "admin-claim-status-finalized"
  return "bg-slate-800 text-slate-100 border-slate-400/45"
}

function isOrderDelivered(order: SupabasePedido) {
  const estado = (order.estado ?? "").toLowerCase()
  const andreaniStatus = (order.andreani_estado ?? "").toLowerCase()
  return estado === "entregado" || Boolean(order.delivered_at) || andreaniStatus.includes("entregado")
}

function isOrderDispatched(order: SupabasePedido) {
  const estado = (order.estado ?? "").toLowerCase()
  const andreaniStatus = (order.andreani_estado ?? "").toLowerCase()
  const dispatchedStatuses = [
    "enviado",
    "en_camino",
    "visita_fallida",
    "en_sucursal",
    "retiro_pendiente",
    "retiro_vencido",
    "en_devolucion",
    "devuelto_beyonix",
    "entregado",
  ]

  return (
    dispatchedStatuses.includes(estado) ||
    Boolean(order.tracking_number || order.andreani_tracking || order.andreani_envio_id) ||
    ["camino", "tránsito", "transito", "distribución", "distribucion", "reparto", "visita", "entregado"].some(
      (status) => andreaniStatus.includes(status),
    )
  )
}

function isOrderInvoiced(order: SupabasePedido) {
  return (
    order.invoice_status === "authorized" ||
    order.invoice_status === "processing" ||
    Boolean(order.invoice_cae) ||
    Boolean(order.invoice_number && order.invoice_point)
  )
}

function getStatusLabel(claim: SupabaseOrderClaim) {
  if (claim.failure_type === "cancelar_compra") {
    if (claim.status === "rechazado") return "Cancelación rechazada"
    if (claim.status === "cerrado") return "Cancelación aprobada"
    if (claim.status === "falta_informacion") return "Esperando cliente"
    return "Cancelación solicitada"
  }

  if (claim.failure_type === "consulta_pedido") {
    if (claim.status === "rechazado") return "Consulta finalizada"
    if (claim.status === "cerrado") return "Consulta finalizada"
    if (claim.status === "falta_informacion") return "Esperando cliente"
    return "Mensaje de ayuda"
  }

  if (["cambio_pendiente", "cupon_pendiente"].includes(claim.status)) {
    return "Solución en proceso"
  }

  if (["reemplazo_enviado"].includes(claim.status)) {
    return "Solución en proceso"
  }

  return STATUS_OPTIONS.find((option) => option.value === claim.status)?.label ?? claim.status
}

function getResolutionNextStep(claim: SupabaseOrderClaim) {
  const resolution = claim.resolution ?? claim.customer_selected_resolution

  if (resolution === "envio_unidad_faltante") {
    if (claim.status === "reemplazo_enviado") {
      return "Unidad faltante despachada. El cliente puede consultar el seguimiento desde el chat."
    }

    if (claim.status === "cerrado") {
      return "Reposición de la unidad faltante registrada. El reclamo quedó finalizado en el historial."
    }

    return "Prepará y despachá la unidad faltante. Luego registrá la acción cuando corresponda."
  }

  if (resolution === "cambio_producto") {
    if (claim.status === "reemplazo_enviado") {
      return "Reemplazo despachado. El cliente puede consultar el seguimiento desde el chat."
    }

    if (claim.status === "cerrado") {
      return "Cambio registrado. El reclamo quedó finalizado en el historial."
    }

    return "Coordiná por el chat dónde debe enviar o entregar el producto original. Luego prepará el reemplazo y marcá la acción cuando corresponda."
  }

  if (resolution === "cupon_descuento") {
    if (claim.status === "cerrado") {
      return "Nota de crédito registrada para el cliente. El reclamo quedó finalizado."
    }

    return "Generá la nota de crédito y confirmá la acción cuando quede emitida."
  }

  if (resolution === "reintegro_total" || resolution === "reintegro_parcial") {
    if (claim.status === "reintegro_pendiente") {
      return claim.refund_details_submitted_at
        ? "Datos del cliente recibidos. Cargá el comprobante y marcá el reintegro realizado."
        : "Esperando que el cliente complete los datos para el reintegro."
    }

    return claim.status === "cerrado" ? "Reintegro registrado para el cliente. El reclamo quedó finalizado." : "Registrá la devolución desde la gestión de reintegros del pedido."
  }

  if (resolution === "rechazado") return "El cliente ve el motivo del rechazo."

  return "Todavía no hay una decisión operativa cargada."
}

function getDefaultDecisionResolution(claim?: SupabaseOrderClaim | null): Exclude<OrderClaimResolution, "rechazado"> {
  if (claim?.resolution === "saldo_a_favor") return "cupon_descuento"
  if (claim?.resolution && claim.resolution !== "rechazado") return claim.resolution
  if (claim?.customer_selected_resolution && claim.customer_selected_resolution !== "rechazado") {
    if (claim.customer_selected_resolution === "saldo_a_favor") return "cupon_descuento"
    return claim.customer_selected_resolution
  }
  if (claim?.failure_type === "faltante" || claim?.failure_type === "cantidad_menor") {
    return "envio_unidad_faltante"
  }

  return "cambio_producto"
}

type ReturnInventoryDraft = {
  received: string
  goodCondition: string
  note: string
}

function getReturnInventoryDraft(item: SupabasePedidoItem): ReturnInventoryDraft {
  const restocked = Number(item.return_restocked_quantity ?? 0)
  const writtenOff = Number(item.return_written_off_quantity ?? 0)

  return {
    received: String(restocked + writtenOff),
    goodCondition: String(restocked),
    note: item.return_inventory_note ?? "",
  }
}

type AffectedItemSelection = {
  order_item_id: number
  quantity: number
}

function getClaimAffectedItems(
  claim: SupabaseOrderClaim,
  orderItems: SupabasePedidoItem[],
): AffectedItemSelection[] {
  const orderItemsById = new Map(orderItems.map((item) => [Number(item.id), item]))
  const persistedItems = Array.isArray(claim.affected_items)
    ? claim.affected_items
        .map((item) => ({
          order_item_id: Number(item.order_item_id),
          quantity: Number(item.quantity),
        }))
        .filter((item) => {
          const orderItem = orderItemsById.get(item.order_item_id)
          return (
            Boolean(orderItem) &&
            Number.isInteger(item.quantity) &&
            item.quantity > 0 &&
            item.quantity <= Number(orderItem?.cantidad ?? 0)
          )
        })
    : []

  if (persistedItems.length > 0) return persistedItems

  // Compatibilidad con reclamos creados antes de guardar la selección estructurada.
  const affectedLine = (claim.description ?? "").split(/\r?\n/, 1)[0].toLocaleLowerCase("es")
  if (affectedLine.includes("todo el pedido")) {
    return orderItems.map((item) => ({
      order_item_id: Number(item.id),
      quantity: Number(item.cantidad ?? 0),
    }))
  }

  return orderItems
    .filter((item) => {
      const productName = item.productos?.nombre?.trim().toLocaleLowerCase("es")
      const variantName = (
        item.conditioned_name ||
        item.producto_variantes?.nombre
      )?.trim().toLocaleLowerCase("es")
      return Boolean(
        productName &&
          affectedLine.includes(productName) &&
          (!variantName || affectedLine.includes(variantName)),
      )
    })
    .map((item) => ({
      order_item_id: Number(item.id),
      quantity: Number(item.cantidad ?? 0),
    }))
}

function ReturnInventoryPanel({
  pedido,
  claim,
  canManage,
  onUpdated,
}: {
  pedido: SupabasePedido
  claim: SupabaseOrderClaim
  canManage: boolean
  onUpdated?: () => void | Promise<void>
}) {
  const orderItems = pedido.orden_items ?? []
  const [affectedItems, setAffectedItems] = useState<AffectedItemSelection[]>(() =>
    getClaimAffectedItems(claim, orderItems),
  )
  const [editingAffectedItems, setEditingAffectedItems] = useState(false)
  const affectedVersionRef = useRef(claim.updated_at)
  const [savingAffectedItems, setSavingAffectedItems] = useState(false)
  const [affectedDrafts, setAffectedDrafts] = useState<Record<number, string>>(() =>
    Object.fromEntries(
      getClaimAffectedItems(claim, orderItems).map((item) => [
        item.order_item_id,
        String(item.quantity),
      ]),
    ),
  )
  const affectedQuantityById = new Map(
    affectedItems.map((item) => [item.order_item_id, item.quantity]),
  )
  const items = orderItems.filter((item) => affectedQuantityById.has(Number(item.id)))
  const [drafts, setDrafts] = useState<Record<number, ReturnInventoryDraft>>(() =>
    Object.fromEntries(items.map((item) => [item.id, getReturnInventoryDraft(item)])),
  )
  const [savingItemId, setSavingItemId] = useState<number | null>(null)
  const [confirmationItemId, setConfirmationItemId] = useState<number | null>(null)
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null)

  useEffect(() => {
    const nextAffectedItems = getClaimAffectedItems(claim, orderItems)
    setAffectedItems(nextAffectedItems)
    setAffectedDrafts(
      Object.fromEntries(
        nextAffectedItems.map((item) => [item.order_item_id, String(item.quantity)]),
      ),
    )
    setEditingAffectedItems(false)
    setDrafts(
      Object.fromEntries(
        orderItems
          .filter((item) =>
            nextAffectedItems.some(
              (affectedItem) => affectedItem.order_item_id === Number(item.id),
            ),
          )
          .map((item) => [item.id, getReturnInventoryDraft(item)]),
      ),
    )
    setSavingItemId(null)
    setConfirmationItemId(null)
    setNotice(null)
  }, [claim.id, claim.affected_items, claim.affected_items_updated_at, pedido.id, pedido.orden_items])

  const toggleAffectedItem = (item: SupabasePedidoItem) => {
    if (item.return_inventory_processed_at) return

    setAffectedDrafts((current) => {
      const next = { ...current }
      if (Object.prototype.hasOwnProperty.call(next, item.id)) {
        delete next[item.id]
      } else {
        next[item.id] = String(Math.max(Number(item.cantidad ?? 0), 1))
      }
      return next
    })
  }

  const selectWholeOrder = () => {
    setAffectedDrafts(
      Object.fromEntries(
        orderItems.map((item) => [
          item.id,
          String(
            item.return_inventory_processed_at
              ? affectedQuantityById.get(Number(item.id)) ?? Number(item.cantidad ?? 0)
              : Number(item.cantidad ?? 0),
          ),
        ]),
      ),
    )
  }

  const saveAffectedItems = async () => {
    const normalizedItems = Object.entries(affectedDrafts)
      .map(([orderItemId, quantity]) => ({
        orderItemId: Number(orderItemId),
        quantity: Number(quantity),
      }))
      .filter((item) => item.quantity > 0)

    if (normalizedItems.length === 0) {
      setNotice({ ok: false, message: "Seleccioná al menos un producto reclamado." })
      return
    }

    for (const selectedItem of normalizedItems) {
      const orderItem = orderItems.find((item) => Number(item.id) === selectedItem.orderItemId)
      if (
        !orderItem ||
        !Number.isInteger(selectedItem.quantity) ||
        selectedItem.quantity < 1 ||
        selectedItem.quantity > Number(orderItem.cantidad ?? 0)
      ) {
        setNotice({
          ok: false,
          message: "Revisá las cantidades: no pueden superar las unidades compradas.",
        })
        return
      }
    }

    setSavingAffectedItems(true)
    setNotice(null)
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      if (!session?.access_token) {
        setNotice({ ok: false, message: "La sesión administrativa venció." })
        return
      }

      const response = await fetch(`/api/admin/order-claims/${claim.id}/affected-items`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ items: normalizedItems, expectedUpdatedAt: affectedVersionRef.current }),
      })
      const data = (await response.json()) as {
        error?: string
        claim?: SupabaseOrderClaim
      }

      if (!response.ok || !data.claim) {
        setNotice({
          ok: false,
          message: data.error || "No se pudo corregir la selección del reclamo.",
        })
        return
      }

      const nextAffectedItems = getClaimAffectedItems(data.claim, orderItems)
      setAffectedItems(nextAffectedItems)
      setAffectedDrafts(
        Object.fromEntries(
          nextAffectedItems.map((item) => [item.order_item_id, String(item.quantity)]),
        ),
      )
      setEditingAffectedItems(false)
      setNotice({
        ok: true,
        message: "Productos reclamados actualizados correctamente.",
      })
      notifyOrderNotificationsChanged()
      await onUpdated?.()
    } catch {
      setNotice({
        ok: false,
        message: "No se pudo corregir la selección del reclamo.",
      })
    } finally {
      setSavingAffectedItems(false)
    }
  }

  const updateDraft = (
    item: SupabasePedidoItem,
    field: keyof ReturnInventoryDraft,
    value: string,
  ) => {
    setDrafts((current) => ({
      ...current,
      [item.id]: {
        ...(current[item.id] ?? getReturnInventoryDraft(item)),
        [field]: value,
      },
    }))
  }

  const selectSingleUnitCondition = (item: SupabasePedidoItem, arrivedWell: boolean) => {
    setDrafts((current) => ({
      ...current,
      [item.id]: {
        ...(current[item.id] ?? getReturnInventoryDraft(item)),
        received: "1",
        goodCondition: arrivedWell ? "1" : "0",
      },
    }))
  }

  const saveItem = async (item: SupabasePedidoItem, confirmed = false) => {
    const draft = drafts[item.id] ?? getReturnInventoryDraft(item)
    const received = Number(draft.received || 0)
    const restocked = Number(draft.goodCondition || 0)
    const writtenOff = received - restocked
    const claimedQuantity = affectedQuantityById.get(Number(item.id)) ?? 0
    const previouslyProcessed = Boolean(item.return_inventory_processed_at)

    if (previouslyProcessed) {
      setNotice({
        ok: false,
        message: "Esta recepción ya fue registrada. Corregí el stock desde Productos.",
      })
      return
    }

    if (
      !Number.isInteger(received) ||
      received < 0 ||
      !Number.isInteger(restocked) ||
      restocked < 0
    ) {
      setNotice({ ok: false, message: "Ingresá cantidades enteras iguales o mayores que cero." })
      return
    }

    if (received > claimedQuantity) {
      setNotice({
        ok: false,
        message: "Las unidades recibidas no pueden superar las unidades reclamadas.",
      })
      return
    }

    if (restocked > received) {
      setNotice({
        ok: false,
        message: "Las unidades en buenas condiciones no pueden superar las recibidas.",
      })
      return
    }

    if (!previouslyProcessed && received === 0) {
      setNotice({
        ok: false,
        message: "Indicá al menos una unidad recibida para registrar la devolución.",
      })
      return
    }

    if (writtenOff > 0 && draft.note.trim().length < 3) {
      setNotice({
        ok: false,
        message: "Indicá en la observación el motivo de la baja o pérdida.",
      })
      return
    }

    if (!confirmed) {
      setConfirmationItemId(item.id)
      return
    }

    setConfirmationItemId(null)
    setSavingItemId(item.id)
    setNotice(null)

    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        setNotice({ ok: false, message: "La sesión administrativa venció." })
        return
      }

      const response = await fetch(
        `/api/admin/pedidos/${pedido.id}/return-inventory/${item.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            claimId: claim.id,
            restockedQuantity: restocked,
            writtenOffQuantity: writtenOff,
            note: draft.note.trim(),
          }),
        },
      )
      const data = (await response.json()) as { error?: string }

      if (!response.ok) {
        setNotice({
          ok: false,
          message: data.error || "No se pudo registrar el destino del producto devuelto.",
        })
        return
      }

      setNotice({
        ok: true,
        message: "Recepción guardada y stock actualizado correctamente.",
      })
      notifyOrderNotificationsChanged()
      await onUpdated?.()
    } catch {
      setNotice({
        ok: false,
        message: "No se pudo registrar el destino del producto devuelto.",
      })
    } finally {
      setSavingItemId(null)
    }
  }

  const confirmationItem = items.find((item) => item.id === confirmationItemId) ?? null
  const confirmationDraft = confirmationItem
    ? drafts[confirmationItem.id] ?? getReturnInventoryDraft(confirmationItem)
    : null
  const confirmationReceived = Number(confirmationDraft?.received || 0)
  const confirmationRestocked = Number(confirmationDraft?.goodCondition || 0)
  const confirmationWrittenOff = confirmationReceived - confirmationRestocked
  const confirmationCurrentRestocked = Number(
    confirmationItem?.return_restocked_quantity ?? 0,
  )
  const confirmationStockDelta = confirmationRestocked - confirmationCurrentRestocked
  const confirmationProductStock = Number(confirmationItem?.productos?.stock ?? 0)
  const confirmationVariantStock = Number(
    confirmationItem?.producto_variantes?.stock ?? 0,
  )
  const confirmationVariantName =
    confirmationItem?.conditioned_name?.trim() ||
    confirmationItem?.producto_variantes?.nombre?.trim() ||
    "Variante seleccionada"
  const hasPendingInventory = items.some((item) => !item.return_inventory_processed_at)

  return (
    <>
      <section className="admin-claim-card mx-3 mb-3 rounded-xl border p-3 sm:mx-4 sm:mb-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-10px font-black uppercase tracking-widest text-blue-200/75">
            Recepción e inventario
          </p>
          <h4 className="mt-1 text-sm font-black text-white">
            Productos incluidos en el reclamo
          </h4>
          <p className="mt-1 text-xs font-semibold text-blue-100/75">
            {claim.affected_items_updated_at
              ? "Selección corregida por administración."
              : "Selección declarada por el cliente."}
          </p>
          {hasPendingInventory && (
            <p className="mt-1 max-w-3xl text-xs font-semibold leading-5 text-white/62">
              Registrá el destino cuando el producto vuelva físicamente a BEYONIX. Lo revendible suma stock; lo dañado queda asentado como baja o pérdida y no vuelve al stock disponible.
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {!canManage && hasPendingInventory && (
            <span className="w-fit rounded-full border border-white/10 bg-black/20 px-2.5 py-1 text-10px font-black uppercase text-white/55">
              Solo lectura
            </span>
          )}
          {canManage && (
            <button
              type="button"
              aria-expanded={editingAffectedItems}
              onClick={() => {
                affectedVersionRef.current = claim.updated_at
                setEditingAffectedItems((current) => !current)
              }}
              className="admin-ds-button inline-flex h-9 min-w-max items-center justify-center gap-2 whitespace-nowrap px-3 text-10px font-black"
            >
              <Pencil className="size-3.5 shrink-0" />
              <span>Corregir productos</span>
              <ChevronDown
                className={`size-3.5 shrink-0 transition-transform ${
                  editingAffectedItems ? "rotate-180" : ""
                }`}
              />
            </button>
          )}
        </div>
      </div>

      {editingAffectedItems && canManage && (
        <div className="mt-3 rounded-xl border border-blue-300/20 bg-[#08131E] p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-xs font-black text-white">Corregir productos reclamados</p>
              <p className="mt-1 text-11px font-semibold leading-4 text-white/55">
                Seleccioná únicamente lo que el cliente devolverá. Los cambios quedan registrados.
              </p>
            </div>
            <button
              type="button"
              onClick={selectWholeOrder}
              className="admin-ds-button h-8 px-3 text-10px font-black"
            >
              Seleccionar todo el pedido
            </button>
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {orderItems.map((item) => {
              const selected = Object.prototype.hasOwnProperty.call(affectedDrafts, item.id)
              const purchasedQuantity = Number(item.cantidad ?? 0)
              const locked = Boolean(item.return_inventory_processed_at)
              const productName = item.productos?.nombre ?? `Producto #${item.producto_id}`
              const variantName =
                item.conditioned_name?.trim() ||
                item.producto_variantes?.nombre?.trim()

              return (
                <div
                  key={`affected-editor-${item.id}`}
                  className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${
                    selected
                      ? "border-blue-300/45 bg-[#112A43]"
                      : "border-white/10 bg-black/20"
                  }`}
                >
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={locked}
                      onChange={() => toggleAffectedItem(item)}
                      className="size-4 accent-blue-400"
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-black text-white">
                        {productName}
                      </span>
                      <span className="mt-0.5 block truncate text-10px font-semibold text-white/52">
                        {variantName || "Sin variante"} · Compradas: {purchasedQuantity}
                        {locked ? " · Recepción cerrada" : ""}
                      </span>
                    </span>
                  </label>
                  {selected && (
                    <label className="shrink-0">
                      <span className="sr-only">Cantidad reclamada de {productName}</span>
                      <input
                        type="number"
                        min={1}
                        max={purchasedQuantity}
                        step={1}
                        value={affectedDrafts[item.id] ?? ""}
                        disabled={locked}
                        onChange={(event) =>
                          setAffectedDrafts((current) => ({
                            ...current,
                            [item.id]: event.target.value,
                          }))
                        }
                        className={`${adminControlClassName} h-8 min-h-8 w-16 px-2 text-center text-xs`}
                      />
                    </label>
                  )}
                </div>
              )
            })}
          </div>

          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              disabled={savingAffectedItems}
              onClick={() => {
                setAffectedDrafts(
                  Object.fromEntries(
                    affectedItems.map((item) => [
                      item.order_item_id,
                      String(item.quantity),
                    ]),
                  ),
                )
                setEditingAffectedItems(false)
              }}
              className="admin-ds-button h-9 px-3 text-10px font-black"
            >
              Cancelar
            </button>
            <button
              type="button"
              disabled={savingAffectedItems}
              onClick={() => void saveAffectedItems()}
              className="admin-ds-button admin-ds-button-primary h-9 px-3 text-10px font-black disabled:opacity-45"
            >
              {savingAffectedItems ? "Guardando..." : "Guardar corrección"}
            </button>
          </div>
        </div>
      )}

      {notice && (
        <p
          role="status"
          className={`mt-3 rounded-lg border px-3 py-2 text-xs font-bold ${
            notice.ok
              ? "border-emerald-300/20 bg-emerald-400/8 text-emerald-100"
              : "border-red-300/20 bg-red-500/8 text-red-100"
          }`}
        >
          {notice.message}
        </p>
      )}

      <div className="mt-3 space-y-2">
        {items.length > 0 ? (
          items.map((item) => {
            const draft = drafts[item.id] ?? getReturnInventoryDraft(item)
            const productName = item.productos?.nombre ?? `Producto #${item.producto_id}`
            const claimedQuantity = affectedQuantityById.get(Number(item.id)) ?? 0
            const receivedQuantity =
              Number(item.return_restocked_quantity ?? 0) +
              Number(item.return_written_off_quantity ?? 0)
            const productStock = Number(item.productos?.stock ?? 0)
            const variantStock = Number(item.producto_variantes?.stock ?? 0)
            const variantName =
              item.conditioned_name?.trim() ||
              item.producto_variantes?.nombre?.trim() ||
              "Variante seleccionada"
            const saving = savingItemId === item.id
            const inventoryLocked = Boolean(item.return_inventory_processed_at)
            const draftReceived = Number(draft.received || 0)
            const draftGoodCondition = Number(draft.goodCondition || 0)
            const draftWrittenOff = Math.max(draftReceived - draftGoodCondition, 0)
            const currentRestocked = Number(item.return_restocked_quantity ?? 0)
            const pendingStockDelta = draftGoodCondition - currentRestocked
            const nextProductStock = productStock + pendingStockDelta
            const nextVariantStock = variantStock + pendingStockDelta
            const singleUnitCondition =
              claimedQuantity === 1 && draftReceived === 1
                ? draftGoodCondition === 1
                  ? "yes"
                  : "no"
                : null

            if (inventoryLocked) {
              const restockedQuantity = Number(item.return_restocked_quantity ?? 0)
              const writtenOffQuantity = Number(item.return_written_off_quantity ?? 0)
              const onlyRestocked = restockedQuantity > 0 && writtenOffQuantity === 0
              const onlyWrittenOff = writtenOffQuantity > 0 && restockedQuantity === 0
              const resultLabel = onlyRestocked
                ? claimedQuantity === 1
                  ? "Sí, volvió al stock"
                  : `${restockedQuantity} unidades volvieron al stock`
                : onlyWrittenOff
                  ? claimedQuantity === 1
                    ? "No, se dio de baja"
                    : `${writtenOffQuantity} unidades se dieron de baja`
                  : `${restockedQuantity} al stock · ${writtenOffQuantity} de baja`
              const impactParts = [
                restockedQuantity > 0
                  ? `+${restockedQuantity} ${restockedQuantity === 1 ? "unidad" : "unidades"} al stock disponible`
                  : null,
                writtenOffQuantity > 0
                  ? `${writtenOffQuantity} ${writtenOffQuantity === 1 ? "unidad registrada" : "unidades registradas"} como baja o pérdida`
                  : null,
              ].filter((part): part is string => Boolean(part))
              const resultTone = onlyRestocked
                ? "border-emerald-300/24 bg-emerald-400/8 text-emerald-100"
                : onlyWrittenOff
                  ? "border-red-300/24 bg-red-400/8 text-red-100"
                  : "border-blue-300/24 bg-blue-400/8 text-blue-100"

              return (
                <article
                  key={`return-inventory-${item.id}`}
                  className="rounded-lg border border-white/9 bg-black/20 p-3"
                >
                  <p className="text-sm font-black text-white">
                    {productName}
                    {item.variante_id && (
                      <span className="font-semibold text-white/55"> · {variantName}</span>
                    )}
                  </p>
                  <div className={`mt-2 flex items-start gap-2 rounded-lg border px-3 py-2.5 ${resultTone}`}>
                    {onlyRestocked ? (
                      <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
                    ) : onlyWrittenOff ? (
                      <XCircle className="mt-0.5 size-4 shrink-0" />
                    ) : (
                      <PackageCheck className="mt-0.5 size-4 shrink-0" />
                    )}
                    <div>
                      <p className="text-10px font-black uppercase tracking-wide opacity-75">
                        Opción elegida
                      </p>
                      <p className="mt-0.5 text-sm font-black text-white">{resultLabel}</p>
                      <p className="mt-1 text-11px font-semibold leading-4 text-white/64">
                        Impacto: {impactParts.join(" · ")}.
                      </p>
                    </div>
                  </div>
                </article>
              )
            }

            return (
              <article key={`return-inventory-${item.id}`} className="rounded-lg border border-white/9 bg-black/20 p-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-black text-white">{productName}</p>
                    <p className="mt-1 text-11px font-semibold text-white/55">
                      {item.conditioned_name?.trim() ||
                        item.producto_variantes?.nombre?.trim() ||
                        "Sin variante"}{" "}
                      · Reclamadas: {claimedQuantity}
                    </p>
                    <p className="mt-1 text-11px font-semibold text-blue-100/72">
                      {item.variante_id
                        ? `Stock general: ${productStock} · ${variantName}: ${variantStock}`
                        : `Stock actual: ${productStock}`}
                    </p>
                  </div>
                  {item.return_inventory_processed_at && (
                    <div className="shrink-0 rounded-lg border border-emerald-300/18 bg-emerald-400/8 px-2.5 py-1.5 text-right">
                      <p className="text-10px font-black uppercase text-emerald-100">Recepción registrada</p>
                      <p className="mt-0.5 text-10px font-semibold text-white/58">
                        {formatDate(item.return_inventory_processed_at)} · {receivedQuantity}/{claimedQuantity} unidades
                      </p>
                    </div>
                  )}
                </div>

                {claimedQuantity === 1 ? (
                  <div className="mt-3">
                    <p className="text-xs font-black text-white">
                      ¿El producto llegó en buenas condiciones y se puede revender?
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={!canManage || saving || inventoryLocked}
                        aria-pressed={singleUnitCondition === "yes"}
                        onClick={() => selectSingleUnitCondition(item, true)}
                        className={`inline-flex h-9 items-center gap-2 rounded-lg border px-4 text-xs font-black transition disabled:cursor-not-allowed disabled:opacity-45 ${
                          singleUnitCondition === "yes"
                            ? "!border-emerald-300/80 !bg-emerald-500/25 !text-emerald-50 ring-2 ring-emerald-300/25"
                            : "border-white/12 bg-[#101820] text-white/70 hover:border-emerald-300/45"
                        }`}
                      >
                        <CheckCircle2 className="size-4" />
                        Sí, vuelve al stock
                      </button>
                      <button
                        type="button"
                        disabled={!canManage || saving || inventoryLocked}
                        aria-pressed={singleUnitCondition === "no"}
                        onClick={() => selectSingleUnitCondition(item, false)}
                        className={`inline-flex h-9 items-center gap-2 rounded-lg border px-4 text-xs font-black transition disabled:cursor-not-allowed disabled:opacity-45 ${
                          singleUnitCondition === "no"
                            ? "!border-red-300/80 !bg-red-500/22 !text-red-50 ring-2 ring-red-300/25"
                            : "border-white/12 bg-[#101820] text-white/70 hover:border-red-300/45"
                        }`}
                      >
                        <XCircle className="size-4" />
                        No, dar de baja
                      </button>
                    </div>
                    {singleUnitCondition && (
                      <div
                        className={`mt-2 flex items-start gap-2 rounded-lg border px-3 py-2 ${
                          singleUnitCondition === "yes"
                            ? "border-emerald-300/24 bg-emerald-400/8"
                            : "border-red-300/24 bg-red-400/8"
                        }`}
                      >
                        {singleUnitCondition === "yes" ? (
                          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-200" />
                        ) : (
                          <XCircle className="mt-0.5 size-4 shrink-0 text-red-200" />
                        )}
                        <div>
                          <p className="text-xs font-black text-white">Opción seleccionada</p>
                          <p className="mt-0.5 text-11px font-semibold leading-4 text-white/64">
                            {singleUnitCondition === "yes"
                              ? item.variante_id
                                ? `Al guardar, el stock general pasará de ${productStock} a ${nextProductStock} y la variante ${variantName} de ${variantStock} a ${nextVariantStock}.`
                                : `Al guardar, el stock pasará de ${productStock} a ${nextProductStock}.`
                              : item.variante_id
                                ? `Al guardar, la unidad quedará dada de baja. El stock general pasará de ${productStock} a ${nextProductStock} y la variante ${variantName} de ${variantStock} a ${nextVariantStock}. Completá la observación con el motivo.`
                                : `Al guardar, la unidad quedará dada de baja y el stock pasará de ${productStock} a ${nextProductStock}. Completá la observación con el motivo.`}
                          </p>
                          <p className="mt-1 text-10px font-black uppercase tracking-wide text-white/45">
                            El cambio se aplica al presionar Guardar recepción.
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="mt-3">
                    <p className="text-xs font-black text-white">
                      ¿Cuántas unidades de este producto recibió BEYONIX y cuántas llegaron bien?
                    </p>
                    <div className="mt-2 flex flex-wrap items-end gap-x-8 gap-y-2">
                      <label className="block w-fit">
                        <span className="text-10px font-black uppercase tracking-wide text-blue-200">
                          Unidades recibidas
                        </span>
                        <div className="mt-1.5 w-20">
                          <input
                            type="number"
                            min={0}
                            max={claimedQuantity}
                            step={1}
                            inputMode="numeric"
                            value={draft.received}
                            disabled={!canManage || saving || inventoryLocked}
                            onChange={(event) => updateDraft(item, "received", event.target.value)}
                            className={`${adminControlClassName} h-9 min-h-9 px-2 text-center text-xs`}
                          />
                        </div>
                      </label>
                      <label className="block w-fit">
                        <span className="text-10px font-black uppercase tracking-wide text-emerald-200">
                          Llegaron bien — suben stock
                        </span>
                        <div className="mt-1.5 w-20">
                          <input
                            type="number"
                            min={0}
                            max={draftReceived}
                            step={1}
                            inputMode="numeric"
                            value={draft.goodCondition}
                            disabled={!canManage || saving || inventoryLocked}
                            onChange={(event) => updateDraft(item, "goodCondition", event.target.value)}
                            className={`${adminControlClassName} h-9 min-h-9 px-2 text-center text-xs`}
                          />
                        </div>
                      </label>
                      <div className="rounded-lg border border-red-300/18 bg-red-500/7 px-3 py-2">
                        <p className="text-10px font-black uppercase tracking-wide text-red-200">
                          Baja o pérdida
                        </p>
                        <p className="mt-1 text-sm font-black text-white">{draftWrittenOff}</p>
                      </div>
                    </div>
                  </div>
                )}

                <label className="mt-2 block">
                  <span className="text-10px font-black uppercase tracking-wide text-white/48">
                    Observación interna
                  </span>
                  <textarea
                    value={draft.note}
                    disabled={!canManage || saving || inventoryLocked}
                    maxLength={1000}
                    rows={2}
                    onChange={(event) => updateDraft(item, "note", event.target.value)}
                    placeholder="Ej.: packaging completo y sin uso, golpeado, faltan accesorios..."
                    className="mt-1.5 w-full resize-none rounded-lg border border-white/10 bg-[#101820] px-3 py-2 text-xs font-semibold text-white outline-none placeholder:text-white/35 focus:border-blue-300/45 disabled:cursor-not-allowed disabled:opacity-55"
                  />
                </label>

                {canManage && !inventoryLocked && (
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-10px font-semibold leading-4 text-white/45">
                      Revisá los datos antes de guardar: la recepción quedará cerrada definitivamente.
                    </p>
                    <button
                      type="button"
                      disabled={savingItemId !== null}
                      onClick={() => void saveItem(item)}
                      className="admin-ds-button admin-ds-button-primary h-9 px-3 text-10px font-black disabled:cursor-wait disabled:opacity-45"
                    >
                      {saving ? "Guardando..." : "Guardar recepción"}
                    </button>
                  </div>
                )}
                {inventoryLocked && (
                  <div className="mt-2 rounded-lg border border-blue-300/15 bg-[#112A43]/22 px-3 py-2">
                    <p className="text-xs font-black text-blue-100">Recepción cerrada</p>
                    <p className="mt-1 text-11px font-semibold leading-4 text-white/58">
                      Este registro ya no se puede modificar desde el reclamo. Si necesitás corregir una cantidad, hacelo desde Productos.
                    </p>
                  </div>
                )}
              </article>
            )
          })
        ) : (
          <p className="rounded-lg border border-white/8 bg-black/20 px-3 py-2 text-xs font-semibold text-white/55">
            Este reclamo no tiene productos seleccionados. Usá “Corregir productos” para indicarlos.
          </p>
        )}
      </div>
      </section>

      {confirmationItem && (
        <div
          className="fixed inset-0 z-120 flex items-center justify-center bg-black/82 p-4 backdrop-blur-sm"
          role="presentation"
          onMouseDown={() => setConfirmationItemId(null)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="return-inventory-confirmation-title"
            className="admin-ds-surface w-full max-w-md rounded-2xl border border-blue-300/25 bg-[#0B1724] p-4 shadow-2xl shadow-black/70 sm:p-5"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-blue-300/25 bg-[#112A43] text-blue-100">
                <PackageCheck className="size-5" />
              </span>
              <div className="min-w-0">
                <p className="text-10px font-black uppercase tracking-widest text-blue-200/70">
                  Confirmar movimiento
                </p>
                <h4 id="return-inventory-confirmation-title" className="mt-1 text-lg font-black text-white">
                  Recepción de {confirmationItem.productos?.nombre ?? `Producto #${confirmationItem.producto_id}`}
                </h4>
                <p className="mt-1 text-xs font-semibold leading-5 text-white/58">
                  Revisá el destino de las unidades antes de modificar el inventario.
                </p>
              </div>
            </div>

            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              <div className="rounded-xl border border-emerald-300/20 bg-emerald-400/8 px-3 py-3">
                <p className="text-10px font-black uppercase tracking-wide text-emerald-200">
                  Vuelven al stock
                </p>
                <p className="mt-1 text-xl font-black text-white">{confirmationRestocked}</p>
              </div>
              <div className="rounded-xl border border-red-300/20 bg-red-400/8 px-3 py-3">
                <p className="text-10px font-black uppercase tracking-wide text-red-200">
                  Baja o pérdida
                </p>
                <p className="mt-1 text-xl font-black text-white">{confirmationWrittenOff}</p>
              </div>
            </div>

            <div className="mt-3 rounded-xl border border-white/9 bg-black/20 px-3 py-2.5">
              <p className="text-10px font-black uppercase tracking-wide text-white/45">
                Stock resultante
              </p>
              <div className="mt-1 space-y-0.5 text-xs font-bold leading-5 text-white/75">
                <p>
                  Stock general del producto: {confirmationProductStock} → {confirmationProductStock + confirmationStockDelta}
                </p>
                {confirmationItem.variante_id && (
                  <p>
                    Variante {confirmationVariantName}: {confirmationVariantStock} → {confirmationVariantStock + confirmationStockDelta}
                  </p>
                )}
              </div>
            </div>

            <p className="mt-3 rounded-lg border border-amber-300/20 bg-amber-400/8 px-3 py-2 text-11px font-bold leading-4 text-amber-100">
              Al confirmar, esta recepción quedará cerrada y no podrá modificarse desde el reclamo.
            </p>

            <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                disabled={savingItemId !== null}
                onClick={() => setConfirmationItemId(null)}
                className="admin-ds-button admin-ds-button-secondary h-10 px-4 text-xs font-black"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={savingItemId !== null}
                onClick={() => void saveItem(confirmationItem, true)}
                className="admin-ds-button admin-ds-button-primary inline-flex h-10 items-center justify-center gap-2 px-4 text-xs font-black"
              >
                <PackageCheck className="size-4" />
                Confirmar recepción
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  )
}

export function AdminClaimManager({
  pedido,
  mode = "all",
  onClaimChange,
  onInventoryUpdated,
  onOpenBilling,
}: {
  pedido: SupabasePedido
  mode?: "all" | "messaging" | "claims"
  onClaimChange: (claim: SupabaseOrderClaim) => void
  onInventoryUpdated?: () => void | Promise<void>
  onOpenBilling: () => void
}) {
  const { isAdmin } = useAuth()
  const allClaims = pedido.order_claims ?? []
  const claims = allClaims.filter((item) => isClaimVisibleForMode(item.failure_type, mode))
  const [claimId, setClaimId] = useState<number | null>(claims[0]?.id ?? null)
  const claim = claims.find((item) => item.id === claimId) ?? claims[0]
  const [response, setResponse] = useState("")
  const [rejectionReason, setRejectionReason] = useState("")
  const [decisionAction, setDecisionAction] = useState<ClaimAction | null>(null)
  const [decisionMessage, setDecisionMessage] = useState("")
  const [decisionReason, setDecisionReason] = useState(REJECTION_REASONS[0])
  const [decisionResolution, setDecisionResolution] = useState<Exclude<OrderClaimResolution, "rechazado">>("cambio_producto")
  const [decisionCreditNoteAmount, setDecisionCreditNoteAmount] = useState("")
  const [refundProofFile, setRefundProofFile] = useState<File | null>(null)
  const [previewFile, setPreviewFile] = useState<SupabaseOrderClaimFile | null>(null)
  const [showCloseConversationModal, setShowCloseConversationModal] = useState(false)
  const [pendingConfirmation, setPendingConfirmation] = useState<{
    title: string
    description: string
    confirmLabel: string
    run: () => void | Promise<void>
  } | null>(null)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState("")
  const decisionVersionRef = useRef<string | null>(null)
  const responseVersionRef = useRef<string | null>(null)
  const chatRef = useRef<HTMLDivElement>(null)
  const firstReviewAttemptedRef = useRef<Set<number>>(new Set())
  const loadedOrderClaimsRef = useRef<Set<number>>(new Set())
  const messageCount = claim?.order_claim_messages?.length ?? 0
  const customerMentionName = getCustomerMentionName(pedido)

  const cancellation = claim?.failure_type === "cancelar_compra"
  const invoiced = isOrderInvoiced(pedido)
  const dispatched = isOrderDispatched(pedido)
  const delivered = isOrderDelivered(pedido)
  const cancellationCanBeApproved = cancellation && !invoiced && !dispatched && !delivered

  useEffect(() => {
    if (allClaims.length > 0) return
    if (loadedOrderClaimsRef.current.has(pedido.id)) return

    let active = true
    loadedOrderClaimsRef.current.add(pedido.id)

    async function loadOrderClaims() {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (!session?.access_token) return

        const response = await fetch(`/api/admin/pedidos/${pedido.id}/claims`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
        const data = (await response.json()) as {
          claims?: SupabaseOrderClaim[]
          error?: string
        }

        if (!active) return
        if (!response.ok) {
          setNotice(data.error || "No se pudieron cargar los mensajes.")
          return
        }

        for (const loadedClaim of [...(data.claims ?? [])].reverse()) {
          onClaimChange(loadedClaim)
        }
      } catch {
        if (active) setNotice("No se pudieron cargar los mensajes.")
      }
    }

    void loadOrderClaims()

    return () => {
      active = false
    }
  }, [allClaims.length, onClaimChange, pedido.id])

  useLayoutEffect(() => {
    const chat = chatRef.current
    if (chat) chat.scrollTop = chat.scrollHeight
  }, [claim?.id, messageCount])

  useEffect(() => {
    if (!claim) return
    setRejectionReason(claim.rejection_reason ?? "")
    setDecisionAction(null)
    setDecisionMessage("")
    setDecisionReason(REJECTION_REASONS[0])
    setDecisionResolution(getDefaultDecisionResolution(claim))
    setDecisionCreditNoteAmount("")
    setRefundProofFile(null)
    setPreviewFile(null)
    setResponse("")
    setNotice("")
    decisionVersionRef.current = null
    responseVersionRef.current = null
  }, [claim?.id])

  useEffect(() => {
    if (!claim) return
    let active = true

    const refreshClaim = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return
      const response = await fetch(`/api/admin/order-claims/${claim.id}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const data = (await response.json()) as { claim?: SupabaseOrderClaim }
      if (!active || !response.ok || !data.claim) return

      const nextMessageCount = data.claim.order_claim_messages?.length ?? 0
      if (
        data.claim.updated_at !== claim.updated_at ||
        nextMessageCount !== messageCount ||
        (data.claim.order_claim_files ?? []).some((file, index) => file.signedUrl !== claim.order_claim_files?.[index]?.signedUrl)
      ) {
        onClaimChange(data.claim)
      }
    }

    // Un caso cerrado/rechazado no vuelve a moverse en el flujo actual, pero
    // seguimos escuchando el foco de la ventana como red de seguridad barata:
    // si el admin vuelve a esta pestaña, se revalida sin mantener un
    // intervalo corriendo en segundo plano para un caso ya terminado.
    const intervalId = shouldPollSingleClaim(claim.status)
      ? window.setInterval(() => void refreshClaim(), 20000)
      : (claim.order_claim_files?.length ?? 0) > 0
        ? window.setInterval(() => void refreshClaim(), 240000)
        : null
    window.addEventListener("focus", refreshClaim)
    return () => {
      active = false
      if (intervalId !== null) window.clearInterval(intervalId)
      window.removeEventListener("focus", refreshClaim)
    }
  }, [claim?.id, claim?.status, claim?.updated_at, messageCount, onClaimChange])

  const updateClaim = async (
    overrides: Record<string, unknown>,
    successMessage: string,
  ) => {
    if (!claim) return false
    setSaving(true)
    setNotice("")

    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        setNotice("La sesión administrativa venció.")
        return false
      }

      const payload = {
        expectedUpdatedAt: decisionVersionRef.current ?? responseVersionRef.current ?? claim.updated_at,
        status: claim.status,
        resolution: claim.resolution ?? null,
        offered_resolutions: [],
        admin_response: claim.admin_response ?? "",
        rejection_reason: claim.rejection_reason ?? "",
        ...overrides,
      }
      const request = await fetch(`/api/admin/order-claims/${claim.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      })
      const data = (await request.json()) as {
        claim?: SupabaseOrderClaim
        error?: string
      }

      if (!request.ok || !data.claim) {
        setNotice(data.error || "No se pudo actualizar el caso.")
        if (request.status === 409) {
          const refreshed = await fetch(`/api/admin/order-claims/${claim.id}`, {
            headers: { Authorization: `Bearer ${session.access_token}` },
          })
          if (refreshed.ok) {
            const current = await refreshed.json() as { claim?: SupabaseOrderClaim }
            if (current.claim) onClaimChange(current.claim)
            decisionVersionRef.current = null
            responseVersionRef.current = null
            setDecisionAction(null)
            setPendingConfirmation(null)
            setShowCloseConversationModal(false)
          }
        }
        return false
      }

      onClaimChange(data.claim)
      decisionVersionRef.current = null
      responseVersionRef.current = null
      setRejectionReason(data.claim.rejection_reason ?? "")
      setNotice(successMessage)
      notifyOrderNotificationsChanged()
      return true
    } catch {
      setNotice("No se pudo actualizar el caso.")
      return false
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    if (!claim || claim.status !== "recibido") return
    if (firstReviewAttemptedRef.current.has(claim.id)) return

    firstReviewAttemptedRef.current.add(claim.id)
    const helpMessage = claim.failure_type === "consulta_pedido"
    void updateClaim(
      { status: "en_revision" },
      cancellation
        ? "Solicitud abierta. Estado actualizado a En revisión."
        : helpMessage
          ? "Mensaje de ayuda abierto. Estado actualizado a En revisión."
          : "Reclamo abierto. Estado actualizado a En revisión.",
    ).then((updated) => {
      if (!updated) firstReviewAttemptedRef.current.delete(claim.id)
    })
  }, [claim?.id, claim?.status])

  const sendResponse = async () => {
    if (!claim || response.trim().length < 2) {
      setNotice("Escribí una respuesta para el cliente.")
      return
    }

    const sent = await updateClaim(
      {
        status: claim.status === "recibido" ? "en_revision" : claim.status,
        admin_response: response.trim(),
        append_message: true,
      },
      "Respuesta enviada al cliente.",
    )
    if (sent) setResponse("")
  }

  const closeDecision = () => {
    if (saving) return
    setDecisionAction(null)
    setDecisionMessage("")
    setDecisionReason(REJECTION_REASONS[0])
    setDecisionResolution(getDefaultDecisionResolution(claim))
    decisionVersionRef.current = null
  }

  const openDecision = (action: ClaimAction) => {
    decisionVersionRef.current = claim?.updated_at ?? null
    setDecisionAction(action)
  }

  const openCloseConversation = () => {
    decisionVersionRef.current = claim?.updated_at ?? null
    setShowCloseConversationModal(true)
  }

  const approveCancellation = async () => {
    const message = decisionMessage.trim() || response.trim()
    const sent = await updateClaim(
      {
        action: "approve_cancellation",
        admin_response: message,
      },
      "Cancelación aprobada y pedido marcado como cancelado.",
    )
    if (sent) setResponse("")
    return sent
  }

  const rejectCancellation = async () => {
    const explanation = decisionMessage.trim() || response.trim() || rejectionReason.trim()
    const message = decisionReason === "Otro" ? explanation : `${decisionReason}. ${explanation}`.trim()
    if (message.length < 5) {
      setNotice("Escribí el motivo del rechazo para que el cliente lo vea claro.")
      return false
    }

    const sent = await updateClaim(
      {
        action: "reject_cancellation",
        admin_response: message,
      },
      "Cancelación rechazada. El cliente verá el motivo.",
    )
    if (sent) {
      setResponse("")
      setRejectionReason("")
    }
    return sent
  }

  const approveSolution = async () => {
    if (!claim) return
    const message = decisionMessage.trim() || response.trim()
    const creditNoteAmount = Number(decisionCreditNoteAmount.replace(",", ".").trim())

    if (
      decisionResolution === "cupon_descuento" &&
      (!Number.isFinite(creditNoteAmount) || creditNoteAmount <= 0)
    ) {
      setNotice("Indicá el monto real a reconocer con nota de crédito.")
      return
    }

    const sent = await updateClaim(
      {
        status:
          decisionResolution === "reintegro_total"
            ? "reintegro_pendiente"
            : "aprobado",
        resolution: decisionResolution,
        admin_response: message || claim.admin_response || "",
        append_message: Boolean(message),
        ...(decisionResolution === "cupon_descuento"
          ? { credit_note_amount: creditNoteAmount }
          : {}),
      },
      "Solución aprobada por BEYONIX.",
    )
    if (sent) {
      setResponse("")
      setDecisionCreditNoteAmount("")
      closeDecision()
    }
  }

  const rejectClaim = async () => {
    const explanation = decisionMessage.trim() || rejectionReason.trim() || response.trim()
    const message = decisionReason === "Otro" ? explanation : `${decisionReason}. ${explanation}`.trim()
    if (message.length < 5) {
      setNotice("El motivo del rechazo es obligatorio.")
      return
    }

    const sent = await updateClaim(
      {
        status: "rechazado",
        resolution: "rechazado",
        rejection_reason: message,
        admin_response: message,
        append_message: true,
      },
      cancellation ? "Cancelación rechazada." : "Reclamo rechazado y cliente notificado.",
    )
    if (sent) {
      setResponse("")
      setRejectionReason("")
      closeDecision()
    }
  }

  const markResolved = async () => {
    if (!claim) return
    const resolution = claim.resolution === "rechazado" ? "otro" : claim.resolution ?? "otro"
    const sent = await updateClaim(
      {
        status: "cerrado",
        resolution,
        admin_response: decisionMessage.trim() || response.trim() || claim.admin_response || "",
        append_message: Boolean(decisionMessage.trim() || response.trim()),
      },
      "Reclamo finalizado.",
    )
    if (sent) {
      setResponse("")
      closeDecision()
    }
  }

  const closeConversation = async () => {
    if (!claim || closed) return

    const message = `Esta conversación fue cerrada el ${formatConversationClosedDate()} por BEYONIX. Si surge otro inconveniente previo a tu compra, comunicate por mail a: beyonix.ar@gmail.com.`
    const sent = await updateClaim(
      {
        status: "cerrado",
        resolution: claim.resolution === "rechazado" ? "otro" : claim.resolution ?? "otro",
        admin_response: message,
        append_message: true,
      },
      "Conversación cerrada.",
    )

    if (sent) {
      setResponse("")
      setShowCloseConversationModal(false)
    }
  }

  const markAcceptedSolutionDone = async () => {
    if (!claim) return
    const nextStatus = "cerrado"
    const sent = await updateClaim(
      ["cupon_descuento", "saldo_a_favor"].includes(claim.resolution ?? "")
        ? {
            action: "mark_credit_note_issued",
          }
        : {
            status: nextStatus,
            resolution: claim.resolution ?? decisionResolution,
          },
      ["cupon_descuento", "saldo_a_favor"].includes(claim.resolution ?? "")
        ? "Nota de crédito informada al cliente y reclamo finalizado."
        : "Reclamo finalizado.",
    )
    if (sent) closeDecision()
  }


  const uploadRefundProof = async () => {
    if (!claim || !refundProofFile) {
      setNotice("Seleccioná el comprobante de devolución.")
      return
    }

    setSaving(true)
    setNotice("")

    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        setNotice("La sesión administrativa venció.")
        return
      }

      const formData = new FormData()
      formData.set("file", refundProofFile)
      formData.set("expectedNoteIds", JSON.stringify(getPendingRefundNotes(pedido.order_credit_notes).map((note) => note.id)))

      const request = await fetch(`/api/admin/pedidos/${pedido.id}/refund`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
        body: formData,
      })
      const data = (await request.json()) as {
        claim?: SupabaseOrderClaim
        error?: string
      }

      if (!request.ok) {
        setNotice(data.error || "No se pudo cargar el comprobante.")
        return
      }

      setRefundProofFile(null)
      setNotice("Comprobante de reintegro cargado.")
      await onInventoryUpdated?.()
      notifyOrderNotificationsChanged()
    } catch {
      setNotice("No se pudo cargar el comprobante.")
    } finally {
      setSaving(false)
    }
  }

  const markRefundDone = async () => {
    if (!claim) return

    await updateClaim(
      {
        action: "mark_refund_done",
      },
      "Reintegro marcado como realizado.",
    )
  }

  const runDecisionAction = async () => {
    if (!decisionAction) return
    if (decisionAction === "approve") {
      await approveSolution()
      return
    }
    if (decisionAction === "reject") {
      await rejectClaim()
      return
    }
    if (decisionAction === "close") {
      await markResolved()
      return
    }
    if (decisionAction === "approve_cancellation") {
      const sent = await approveCancellation()
      if (sent) closeDecision()
      return
    }
    if (decisionAction === "reject_cancellation") {
      const sent = await rejectCancellation()
      if (sent) closeDecision()
    }
  }

  if (!claim) {
    const title =
      mode === "claims"
        ? "Centro de reclamos"
        : mode === "messaging"
          ? "Mensajería"
          : "Atención al cliente"
    const emptyDescription =
      mode === "claims"
        ? "Este pedido todavía no tiene reclamos formales cargados."
        : mode === "messaging"
          ? "Este pedido todavía no tiene mensajes previos a la entrega."
          : "Este pedido todavía no tiene mensajes ni reclamos."
    return (
      <div className="admin-claim-manager admin-ds-card mt-3 overflow-hidden">
        <section className="p-4">
          <h3 className="text-base font-black text-white">{title}</h3>
          <p className="mt-1 text-sm text-white/66">{emptyDescription}</p>
          {notice && <p className="mt-3 rounded-lg border border-red-300/20 bg-red-500/8 px-3 py-2 text-xs font-bold text-red-100">{notice}</p>}
        </section>
      </div>
    )
  }

  const messages = sortUniqueMessages(claim.order_claim_messages)
  const files = claim.order_claim_files ?? []
  const refundProof = files.find((file) => file.file_role === "comprobante_devolucion")
  const evidenceFiles = files.filter((file) => !["comprobante_devolucion", "comprobante_diferencia"].includes(file.file_role))
  const closed = ["cerrado", "rechazado"].includes(claim.status)
  const conversationLocked = closed
  const helpMessage = claim.failure_type === "consulta_pedido"
  const summaryOrderItems = pedido.orden_items ?? []
  const summaryAffectedSelections = getClaimAffectedItems(claim, summaryOrderItems)
  const summaryAffectedItems = summaryAffectedSelections
    .map((selection) => {
      const item = summaryOrderItems.find((orderItem) => Number(orderItem.id) === selection.order_item_id)
      return item ? { item, quantity: selection.quantity } : null
    })
    .filter((entry): entry is { item: SupabasePedidoItem; quantity: number } => entry !== null)
  const canReviewClaim = !closed && ["recibido", "en_revision", "falta_informacion"].includes(claim.status)
  const canCompleteAcceptedSolution = isAdmin && !closed && claim.status === "aprobado"
  const canCompleteReplacementSolution =
    canCompleteAcceptedSolution &&
    (claim.resolution === "cambio_producto" || claim.resolution === "envio_unidad_faltante")
  const canManageRefund = isAdmin && !closed && ["reintegro_pendiente", "aprobado"].includes(claim.status) && ["reintegro_total", "reintegro_parcial"].includes(claim.resolution ?? "")
  const canIssueCreditNote =
    isAdmin && !closed &&
    ["cupon_descuento", "saldo_a_favor", "reintegro_total", "reintegro_parcial"].includes(claim.resolution ?? "")
  const creditNoteIssued =
    Boolean(
      pedido.credit_note_issued &&
        pedido.credit_note_status === "authorized" &&
        pedido.credit_note_cae,
    )
  const canCloseClaim = !closed && !cancellation && !["cupon_descuento", "saldo_a_favor", "reintegro_total", "reintegro_parcial"].includes(claim.resolution ?? "") &&
    (isAdmin || !["cambio_producto", "envio_unidad_faltante"].includes(claim.resolution ?? ""))
  const canCloseConversation = helpMessage && !closed
  const helpResolved = helpMessage && claim.status === "cerrado"
  const finalizedStatus = !helpResolved && claim.status === "cerrado"
  const conversationStatus = getConversationStatusLabel(claim, messages)
  return (
    <section className={`admin-claim-manager admin-ds-surface mt-3 overflow-hidden ${mode === "messaging" ? "admin-claim-manager-messaging" : ""} ${ADMIN_SENSITIVE_DANGER.panel}`}>
      <header className="admin-claim-header border-b p-3 sm:p-4">
        <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-lg font-black text-white">Pedido BX-{1000 + pedido.id}</h3>
              <span className={`inline-flex items-center gap-2 px-2.5 py-1 text-10px font-black uppercase ${finalizedStatus ? "admin-claim-status-finalized" : `rounded-full border ${helpResolved ? "admin-claim-help-resolved-badge" : getStatusTone(claim.status, cancellation)}`}`}>
                <span className="size-2 rounded-full bg-current" />
                {getStatusLabel(claim)}
              </span>
            </div>
          </div>

          {claims.length > 1 && (
            <div className="w-full sm:w-56">
              <AdminSelect
                title="Seleccionar caso"
                value={String(claim.id)}
                compact
                onChange={(value) => setClaimId(Number(value))}
              >
                {claims.map((item) => (
                  <option key={item.id} value={String(item.id)}>
                    #{item.id} · {PROBLEM_LABELS[item.failure_type ?? ""] ?? "Ayuda"}
                  </option>
                ))}
              </AdminSelect>
            </div>
          )}
        </div>

        {cancellation && !cancellationCanBeApproved && !closed && (
          <p className="mt-3 rounded-lg border border-red-300/30 bg-red-950/70 px-3 py-2 text-xs font-bold text-red-100">
            Esta orden ya está facturada, despachada o entregada. No se puede aprobar la cancelación desde esta acción.
          </p>
        )}
        {closed && !helpMessage && !cancellation && (
          <div className="mt-3 rounded-lg border border-[#77E6E2]/24 bg-[#77E6E2]/6 px-3 py-2">
            <p className="text-xs font-black text-[#D7FFFD]">Reclamo finalizado</p>
            <p className="mt-1 text-[11px] font-semibold leading-4 text-white/65">
              El historial queda disponible para consulta. Podés enviar una aclaración al cliente, pero no registrar nuevas acciones.
            </p>
          </div>
        )}
      </header>

      {!helpMessage && !cancellation && (
        <div className="admin-claim-summary grid gap-3 border-b p-3 sm:p-4 md:grid-cols-3">
          <section className="admin-claim-card rounded-xl border p-3">
            <p className="text-10px font-black uppercase text-white/45">Pedido</p>
            <p className="mt-1 text-xs font-bold text-white">{formatDate(pedido.created_at)}</p>
            <p className="mt-1 text-xs font-semibold text-white/70">{pedido.estado}</p>
            <p className="mt-1 text-xs font-semibold text-white/70">
              {getClaimSummaryPaymentLabel(pedido)} · {pedido.shipping_type === "sucursal" ? "Retiro en sucursal" : "Envío a domicilio"}
            </p>
            <p className="mt-1 text-xs font-semibold text-white/70">Total: {formatPrice(pedido.total)}</p>
          </section>

          <section className="admin-claim-card rounded-xl border p-3">
            <p className="text-10px font-black uppercase text-white/45">Motivo del reclamo</p>
            <p className="mt-1 text-xs font-bold text-white">{PROBLEM_LABELS[claim.failure_type ?? ""] ?? "Reclamo"}</p>
            <p className="mt-1 text-[11px] leading-4 text-white/60 line-clamp-3">{claim.description}</p>
          </section>

          <section className="admin-claim-card rounded-xl border p-3">
            <p className="text-10px font-black uppercase text-white/45">Producto afectado</p>
            {summaryAffectedItems.length === 0 ? (
              <p className="mt-1.5 text-xs font-semibold text-white/70">Pedido completo</p>
            ) : (
              <ul className="mt-1.5 space-y-2">
                {summaryAffectedItems.map(({ item, quantity }) => {
                  const image = getCuentaItemImage(item)
                  const variantName = item.conditioned_name || item.producto_variantes?.nombre
                  const sku = item.conditioned_sku || item.producto_variantes?.sku
                  return (
                    <li key={item.id} className="flex items-center gap-2">
                      <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md border border-white/10 bg-white">
                        {image ? (
                          <img src={image} alt="" className="size-full object-contain" />
                        ) : (
                          <Package className="size-4 text-black/40" />
                        )}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-bold text-white">
                          {item.productos?.nombre ?? `Producto #${item.producto_id}`}
                        </span>
                        <span className="block truncate text-10px text-white/55">
                          {variantName ? `${variantName} · ` : ""}
                          {sku ? `SKU ${sku} · ` : ""}
                          {quantity} de {item.cantidad} reclamadas
                        </span>
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </div>
      )}

      <div className="admin-claim-workspace grid gap-3 p-3 sm:p-4">
        <main className="space-y-3">
          {!helpMessage && (
            <section className="admin-claim-card rounded-xl border p-3">
              <h4 className="text-sm font-black text-white">Evidencia</h4>
              {evidenceFiles.length === 0 ? (
                <div className="mt-2 rounded-lg border border-white/10 bg-black/20 px-3 py-3">
                  <p className="text-xs font-bold text-white/70">El cliente no adjuntó imágenes ni videos.</p>
                </div>
              ) : (
                <div className="mt-2 space-y-2">
                  {evidenceFiles.map((file) => (
                    <article key={file.id} className="admin-claim-file-row flex items-center gap-2 rounded-lg border p-2">
                      <button
                        type="button"
                        onClick={() => setPreviewFile(file)}
                        className="grid size-11 shrink-0 place-items-center overflow-hidden rounded-md border border-white/10 bg-black/30"
                        aria-label={`Ver ${file.file_name}`}
                      >
                        {file.mime_type.startsWith("image/") && file.signedUrl ? (
                          <img src={file.signedUrl} alt={file.file_name} className="size-full object-cover" />
                        ) : file.mime_type.startsWith("video/") ? (
                          <Play className="size-5 text-blue-100" />
                        ) : (
                          <FileText className="size-5 text-blue-100" />
                        )}
                      </button>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-black text-white">{file.file_name}</p>
                        <p className="mt-1 text-10px font-bold uppercase text-white/50">{getFileTypeLabel(file.mime_type)} · {formatFileSize(file.file_size)}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setPreviewFile(file)}
                        className="admin-claim-evidence-action admin-claim-evidence-action-view grid place-items-center rounded-md border"
                        aria-label={`Ver ${file.file_name}`}
                        title="Ver"
                      >
                        <Eye className="size-3" />
                      </button>
                      <a
                        href={file.signedUrl ?? undefined}
                        download={file.file_name}
                        className="admin-claim-evidence-action admin-claim-evidence-action-download grid place-items-center rounded-md border"
                        aria-label={`Descargar ${file.file_name}`}
                        title="Descargar"
                      >
                        <Download className="size-3" />
                      </a>
                    </article>
                  ))}
                </div>
              )}
            </section>
          )}

          <ClaimConversation
            messages={messages}
            chatRef={chatRef}
            response={response}
            saving={saving}
            closed={conversationLocked}
            statusLabel={conversationStatus}
            customerMentionName={customerMentionName}
            canUseCustomerMention={isAdmin}
            onResponseChange={(value) => {
              if (!responseVersionRef.current) responseVersionRef.current = claim.updated_at
              if (!value) responseVersionRef.current = null
              setResponse(value)
            }}
            onSendResponse={() => void sendResponse()}
          />
        </main>

        <aside>
          {helpMessage ? (
          <section className={`admin-claim-card rounded-xl border p-2.5 ${helpResolved ? "admin-claim-help-resolved-card" : ""}`}>
            <h4 className="text-sm font-black text-white">Mensajería</h4>
            <div className={`mt-2 rounded-lg px-2.5 py-1.5 ${helpResolved ? "admin-claim-help-resolved-state" : "bg-black/20"}`}>
              <p className="text-10px font-black uppercase text-white/45">Estado actual</p>
              <p className="mt-0.5 text-xs font-black text-white">{getStatusLabel(claim)}</p>
            </div>
            {canCloseConversation ? (
              <div className="mt-2">
                <DecisionButton
                  icon={<CheckCircle2 className="size-4" />}
                  title="Cerrar conversación"
                  description="Finalizar este chat de ayuda y enviar el mail de contacto al cliente."
                  tone="primary"
                  disabled={saving}
                  onClick={openCloseConversation}
                />
              </div>
            ) : (
              <p className={`mt-2 rounded-lg px-3 py-2 text-xs font-bold ${helpResolved ? "admin-claim-help-resolved-note" : "bg-black/20 text-white/55"}`}>Conversación cerrada.</p>
            )}
          </section>
          ) : (
          <section className="admin-claim-card rounded-xl border p-2.5">
            <h4 className="text-sm font-black text-white">Gestionar reclamo</h4>
            <div className="mt-2 rounded-lg bg-black/20 px-2.5 py-1.5">
              <p className="text-10px font-black uppercase text-white/45">Estado actual</p>
              <p className="mt-0.5 text-xs font-black text-white">{getStatusLabel(claim)}</p>
            </div>

            {claim.resolution && claim.resolution !== "rechazado" && (
              <div className="mt-2 rounded-lg border border-blue-300/18 bg-[#112A43]/30 px-2.5 py-2">
                <p className="text-10px font-black uppercase text-blue-200/75">Decisión tomada</p>
                <p className="mt-0.5 text-xs font-black text-white">
                  {getOrderClaimResolutionLabel(claim.resolution)}
                </p>
                <p className="mt-1 text-[11px] font-semibold leading-4 text-white/66">
                  {getResolutionNextStep(claim)}
                </p>
              </div>
            )}

            {cancellation ? (
              <div className="mt-2 grid gap-2">
                <DecisionButton
                  icon={<ShieldCheck className="size-4" />}
                  title="Aprobar cancelación"
                  description="Aceptar solicitud"
                  tone="success"
                  disabled={saving || closed || !isAdmin || !cancellationCanBeApproved}
                  onClick={() => openDecision("approve_cancellation")}
                />
                <DecisionButton
                  icon={<XCircle className="size-4" />}
                  title="Rechazar cancelación"
                  description="Requiere un motivo"
                  tone="danger"
                  disabled={saving || closed}
                  onClick={() => openDecision("reject_cancellation")}
                />
              </div>
            ) : (
              <div className="mt-2 grid gap-2">
                {canReviewClaim && (
                  <>
                    <DecisionButton
                      icon={<CheckCircle2 className="size-4" />}
                      title="El reclamo es válido"
                      description="Registrar que BEYONIX acepta el reclamo."
                      tone="success"
                      disabled={saving || !isAdmin}
                      onClick={() => openDecision("approve")}
                    />
                    <DecisionButton
                      icon={<XCircle className="size-4" />}
                      title="El reclamo no corresponde"
                      description="Informar al cliente el motivo del rechazo."
                      tone="danger"
                      disabled={saving}
                      onClick={() => openDecision("reject")}
                    />
                  </>
                )}
                {canCompleteReplacementSolution && (
                  <DecisionButton
                    icon={<PackageCheck className="size-4" />}
                    title={claim.resolution === "envio_unidad_faltante" ? "Marcar unidad enviada" : "Marcar producto reemplazado"}
                    description={claim.resolution === "envio_unidad_faltante" ? "Confirmar que se envió o entregó la unidad faltante." : "Confirmar que se envió o entregó la nueva unidad."}
                    tone="success"
                    disabled={saving}
                    onClick={() =>
                      setPendingConfirmation({
                        title: claim.resolution === "envio_unidad_faltante" ? "Marcar unidad enviada" : "Marcar producto reemplazado",
                        description: "Esto finaliza el reclamo y notifica al cliente que la gestión quedó completada. No se puede deshacer desde acá.",
                        confirmLabel: "Confirmar y finalizar",
                        run: markAcceptedSolutionDone,
                      })
                    }
                  />
                )}
                {canIssueCreditNote && (
                  <DecisionButton
                    icon={<CreditCard className="size-4" />}
                    title="Gestionar nota de crédito"
                    description="Revisar productos e importes en Facturación."
                    tone="success"
                    disabled={saving || !invoiced}
                    onClick={onOpenBilling}
                  />
                )}
                {isAdmin && !closed && ["cupon_descuento", "saldo_a_favor"].includes(claim.resolution ?? "") && (
                  <DecisionButton
                    icon={<CreditCard className="size-4" />}
                    title="Nota de crédito emitida"
                    description={
                      creditNoteIssued
                        ? "Confirmar que el crédito fue generado para el cliente."
                        : "Se habilita después de que ARCA autorice la nota de crédito."
                    }
                    tone="success"
                    disabled={saving || !creditNoteIssued}
                    mutedWhenDisabled
                    onClick={() =>
                      setPendingConfirmation({
                        title: "Confirmar nota de crédito emitida",
                        description: "Esto finaliza el reclamo y le informa al cliente que ya puede usar el saldo a favor. No se puede deshacer desde acá.",
                        confirmLabel: "Confirmar y finalizar",
                        run: markAcceptedSolutionDone,
                      })
                    }
                  />
                )}
                {canManageRefund && (
                  <div className="rounded-lg border border-emerald-300/20 bg-emerald-950/20 p-2">
                    <p className="text-xs font-black text-white">Reembolso</p>
                    <div className="mt-2 grid gap-2">
                      <p className="text-xs text-white/70">El importe se toma de la nota de crédito autorizada. Registrá el comprobante únicamente después de devolver el dinero.</p>
                      <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-white/10 bg-black/20 px-2 py-1.5 text-10px font-bold text-white/75 hover:border-emerald-300/35">
                        <Upload className="size-3.5" />
                        <span className="truncate">{refundProofFile?.name || refundProof?.file_name || "Subir comprobante"}</span>
                        <input
                          type="file"
                          accept=".jpg,.jpeg,.pdf"
                          className="sr-only"
                          onChange={(event) => setRefundProofFile(event.target.files?.[0] ?? null)}
                        />
                      </label>
                      <button
                        type="button"
                        disabled={saving || !refundProofFile}
                        onClick={() => setPendingConfirmation({ title: "Registrar reintegro", description: "Confirmá que ya devolviste el importe de la nota de crédito autorizada. Se registrará el reintegro financiero y su comprobante en el pedido.", confirmLabel: "Registrar reintegro", run: uploadRefundProof })}
                        className="admin-ds-button admin-ds-button-secondary h-8 px-3 text-10px font-black disabled:opacity-45"
                      >
                        Subir comprobante
                      </button>
                      {pedido.financial_status === "refunded" && (
                        <DecisionButton
                          icon={<CheckCircle2 className="size-4" />}
                          title="Marcar reintegro realizado"
                          description="Confirmar que el dinero fue devuelto al cliente."
                          tone="success"
                          disabled={saving}
                          onClick={() =>
                            setPendingConfirmation({
                              title: "Marcar reintegro realizado",
                              description: "Esto confirma el reintegro registrado en el pedido y finaliza el reclamo. No se puede deshacer desde acá.",
                              confirmLabel: "Confirmar reintegro",
                              run: markRefundDone,
                            })
                          }
                        />
                      )}
                    </div>
                  </div>
                )}
                {canCloseClaim && (
                  <DecisionButton
                    icon={<CheckCircle2 className="size-4" />}
                    title="Finalizar reclamo"
                    description="Bloquear nuevas acciones y dejarlo visible en el historial."
                    tone="primary"
                    disabled={saving}
                    onClick={() => openDecision("close")}
                  />
                )}
                {closed && (
                  <div className="rounded-lg border border-[#77E6E2]/20 bg-[#77E6E2]/5 px-3 py-2">
                    <p className="text-xs font-black text-[#D7FFFD]">Reclamo finalizado</p>
                    <p className="mt-1 text-[11px] font-semibold leading-4 text-white/65">
                      No hay acciones pendientes. Si el cliente necesita contactarse de nuevo, debe escribir a beyonix.ar@gmail.com.
                    </p>
                  </div>
                )}
              </div>
            )}

            {canCloseConversation && (
              <div className="mt-2 border-t border-white/10 pt-2">
                <p className="mb-2 text-10px font-black uppercase text-white/45">Gestionar conversación</p>
                <DecisionButton
                  icon={<CheckCircle2 className="size-4" />}
                  title="Cerrar conversación"
                  description="Finalizar este chat de ayuda y enviar el mail de contacto al cliente."
                  tone="primary"
                  disabled={saving}
                  onClick={openCloseConversation}
                />
              </div>
            )}
          </section>
          )}
        </aside>
      </div>

      {shouldShowReturnInventoryPanel(claim.failure_type) && (
        <ReturnInventoryPanel
          pedido={pedido}
          claim={claim}
          canManage={isAdmin && !closed && !(pedido.order_credit_notes ?? []).some((note) => note.claim_id === claim.id && ["processing", "authorized"].includes(note.status))}
          onUpdated={onInventoryUpdated}
        />
      )}

      {notice && <p className={`mx-3 mb-3 rounded-lg border px-3 py-2 text-xs font-bold text-white sm:mx-4 sm:mb-4 ${ADMIN_SENSITIVE_DANGER.panelSoft}`}>{notice}</p>}

      {previewFile && (
        <FilePreviewModal file={files.find((file) => file.id === previewFile.id) ?? previewFile} onClose={() => setPreviewFile(null)} />
      )}

      {showCloseConversationModal && (
        <CloseConversationModal
          saving={saving}
          onClose={() => {
            if (!saving) {
              setShowCloseConversationModal(false)
              decisionVersionRef.current = null
            }
          }}
          onConfirm={() => void closeConversation()}
        />
      )}

      {decisionAction && (
        <ClaimActionModal
          action={decisionAction}
          saving={saving}
          message={decisionMessage}
          reason={decisionReason}
          resolution={decisionResolution}
          creditNoteAmount={decisionCreditNoteAmount}
          cancellationCanBeApproved={cancellationCanBeApproved}
          onMessageChange={setDecisionMessage}
          onReasonChange={setDecisionReason}
          onResolutionChange={setDecisionResolution}
          onCreditNoteAmountChange={setDecisionCreditNoteAmount}
          onClose={closeDecision}
          onConfirm={() => void runDecisionAction()}
        />
      )}
      {pendingConfirmation && (
        <AdminModal
          open
          compact
          eyebrow="Confirmación requerida"
          title={pendingConfirmation.title}
          description={pendingConfirmation.description}
          onClose={() => {
            if (!saving) setPendingConfirmation(null)
          }}
          footer={
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <AdminSecondaryButton
                disabled={saving}
                onClick={() => setPendingConfirmation(null)}
              >
                Cancelar
              </AdminSecondaryButton>
              <AdminButton
                variant="primary"
                disabled={saving}
                onClick={async () => {
                  await pendingConfirmation.run()
                  setPendingConfirmation(null)
                }}
              >
                {saving ? "Confirmando..." : pendingConfirmation.confirmLabel}
              </AdminButton>
            </div>
          }
        >
          {null}
        </AdminModal>
      )}
    </section>
  )
}

function DecisionButton({
  icon,
  title,
  description,
  tone = "secondary",
  disabled = false,
  mutedWhenDisabled = false,
  onClick,
}: {
  icon: ReactNode
  title: string
  description: string
  tone?: "warning" | "success" | "danger" | "primary" | "secondary"
  disabled?: boolean
  mutedWhenDisabled?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`admin-claim-decision-button is-${tone} ${
        disabled && mutedWhenDisabled ? "is-disabled-muted" : ""
      } rounded-lg border px-2.5 py-1.5 text-left transition disabled:cursor-not-allowed disabled:opacity-45`}
    >
      <span className="flex items-center gap-2">
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-white/10 text-white">{icon}</span>
        <span className="min-w-0">
          <span className="block text-xs font-black text-white">{title}</span>
          <span className="mt-0.5 block text-10px font-semibold leading-4 text-white/75">{description}</span>
        </span>
      </span>
    </button>
  )
}

function ClaimConversation({
  messages,
  chatRef,
  response,
  saving,
  closed,
  statusLabel,
  customerMentionName,
  canUseCustomerMention,
  onResponseChange,
  onSendResponse,
}: {
  messages: SupabaseOrderClaimMessage[]
  chatRef: RefObject<HTMLDivElement | null>
  response: string
  saving: boolean
  closed: boolean
  statusLabel: string
  customerMentionName: string
  canUseCustomerMention: boolean
  onResponseChange: (value: string) => void
  onSendResponse: () => void
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const nextCaretPositionRef = useRef<number | null>(null)

  useLayoutEffect(() => {
    if (nextCaretPositionRef.current === null) return

    const textarea = textareaRef.current
    const position = nextCaretPositionRef.current
    nextCaretPositionRef.current = null
    textarea?.setSelectionRange(position, position)
  }, [response])

  const handleResponseChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const nextValue = event.target.value
    const nativeEvent = event.nativeEvent as InputEvent

    if (
      canUseCustomerMention &&
      customerMentionName &&
      nativeEvent.inputType === "insertText" &&
      nativeEvent.data === "@"
    ) {
      const cursorPosition = event.target.selectionStart ?? nextValue.length
      const beforeMention = nextValue.slice(0, Math.max(0, cursorPosition - 1))
      const afterMention = nextValue.slice(cursorPosition)
      const nextResponse = `${beforeMention}${customerMentionName}${afterMention}`

      nextCaretPositionRef.current = beforeMention.length + customerMentionName.length
      onResponseChange(nextResponse)
      return
    }

    onResponseChange(nextValue)
  }

  return (
    <section className="admin-claim-chat-panel flex flex-col overflow-hidden rounded-xl border">
      <div className="admin-claim-header border-b px-3 py-1.5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-black text-white">Conversación con el cliente</h4>
            <p className="mt-0.5 text-10px text-white/50">{messages.length} mensaje{messages.length === 1 ? "" : "s"} · {statusLabel}</p>
          </div>
          <MessageSquare className="size-4 text-blue-200" />
        </div>
      </div>
      <div ref={chatRef} className="admin-claim-chat-thread min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5">
        {closed && (
          <p className="rounded-lg border border-teal-300/20 bg-teal-500/10 px-3 py-2 text-xs font-bold text-teal-100">
            Conversación finalizada. No se pueden enviar nuevos mensajes.
          </p>
        )}
        {messages.length === 0 && (
          <p className="rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-xs text-white/66">Todavía no hay mensajes en esta conversación.</p>
        )}
        {messages.map((message) => {
          const isCustomer = message.author_role === "cliente"
          return (
            <div key={message.id} className={`flex ${isCustomer ? "justify-start" : "justify-end"}`}>
              <div className={`admin-claim-chat-bubble ${isCustomer ? "admin-claim-chat-bubble-customer" : "admin-claim-chat-bubble-beyonix"} rounded-lg border px-3 py-2`}>
                <p className="text-10px font-black text-blue-100">{isCustomer ? "Cliente" : "BEYONIX"}</p>
                <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-white">{getClaimMessageText(message.message)}</p>
                <p className="mt-1 text-10px text-white/45">{formatDate(message.created_at)}</p>
              </div>
            </div>
          )
        })}
      </div>
      <div className="admin-claim-composer border-t p-2">
        <div className="flex gap-2">
          <textarea
            ref={textareaRef}
            value={response}
            disabled={closed || saving}
            onChange={handleResponseChange}
            rows={1}
            placeholder={closed ? "Reclamo finalizado" : "Responder al cliente"}
            className={`${adminControlClassName} min-h-8 min-w-0 basis-4/5 resize-none px-3 py-1.5 text-xs leading-5 disabled:cursor-not-allowed disabled:opacity-45`}
          />
          <button type="button" disabled={saving || closed || response.trim().length < 2} onClick={onSendResponse} className="admin-ds-button admin-ds-button-primary inline-flex h-8 basis-1/5 shrink-0 items-center justify-center gap-2 px-3 text-10px font-black disabled:opacity-45">
            <Send className="size-3.5" />
            {saving ? "Enviando..." : "Enviar respuesta"}
          </button>
        </div>
      </div>
    </section>
  )
}

function FilePreviewModal({ file, onClose }: { file: SupabaseOrderClaimFile; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/78 p-4" role="dialog" aria-modal="true" aria-label={`Vista previa de ${file.file_name}`}>
      <div className="admin-claim-preview-modal w-full max-w-5xl overflow-hidden rounded-xl border border-blue-300/24 bg-[#050c14] shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-black text-white">{file.file_name}</p>
            <p className="mt-0.5 text-10px font-bold uppercase text-white/45">{getFileTypeLabel(file.mime_type)} · {formatFileSize(file.file_size)}</p>
          </div>
          <button type="button" onClick={onClose} className="admin-ds-button admin-ds-button-secondary h-9 px-3 text-xs font-black" aria-label="Cerrar vista previa">
            <X className="size-4" />
          </button>
        </div>
        <div className="grid max-h-[75vh] place-items-center overflow-auto bg-black/35 p-4">
          {file.mime_type.startsWith("image/") && file.signedUrl ? (
            <img src={file.signedUrl} alt={file.file_name} className="max-h-[68vh] max-w-full object-contain" />
          ) : file.mime_type.startsWith("video/") && file.signedUrl ? (
            <video src={file.signedUrl} controls className="max-h-[68vh] max-w-full" />
          ) : (
            <div className="py-12 text-center">
              <FileText className="mx-auto size-10 text-white/45" />
              <p className="mt-3 text-sm font-bold text-white">Este archivo no tiene vista previa integrada.</p>
              <a href={file.signedUrl ?? undefined} target="_blank" rel="noreferrer" className="admin-ds-button admin-ds-button-primary mt-4 inline-flex h-10 px-4 text-xs font-black">
                Abrir archivo
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function CloseConversationModal({
  saving,
  onClose,
  onConfirm,
}: {
  saving: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/78 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Cerrar conversación"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-[#112A43] bg-[#050c14] p-4 shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h4 className="text-base font-black text-white">Cerrar conversación</h4>
            <p className="mt-2 text-sm font-bold leading-5 text-white">¿Confirmás que querés cerrar esta conversación?</p>
            <p className="mt-1.5 text-xs font-semibold leading-5 text-white/64">
              El cliente recibirá el contacto beyonix.ar@gmail.com para cualquier consulta previa a la entrega.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="admin-ds-button admin-ds-button-secondary h-8 px-2 text-10px font-black disabled:opacity-45"
            aria-label="Cerrar"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            disabled={saving}
            onClick={onClose}
            className="admin-ds-button admin-ds-button-secondary h-9 px-4 text-xs font-black disabled:opacity-45"
          >
            Volver
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={onConfirm}
            className="inline-flex h-9 items-center justify-center rounded-lg border border-red-300/30 bg-red-950/85 px-4 text-xs font-black text-red-50 transition hover:border-red-300/55 hover:bg-red-900 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {saving ? "Cerrando..." : "Cerrar conversación"}
          </button>
        </div>
      </div>
    </div>
  )
}

function ClaimActionModal({
  action,
  saving,
  message,
  reason,
  resolution,
  creditNoteAmount,
  cancellationCanBeApproved,
  onMessageChange,
  onReasonChange,
  onResolutionChange,
  onCreditNoteAmountChange,
  onClose,
  onConfirm,
}: {
  action: ClaimAction
  saving: boolean
  message: string
  reason: string
  resolution: Exclude<OrderClaimResolution, "rechazado">
  creditNoteAmount: string
  cancellationCanBeApproved: boolean
  onMessageChange: (value: string) => void
  onReasonChange: (value: string) => void
  onResolutionChange: (value: Exclude<OrderClaimResolution, "rechazado">) => void
  onCreditNoteAmountChange: (value: string) => void
  onClose: () => void
  onConfirm: () => void
}) {
  const destructive = action === "reject" || action === "reject_cancellation"
  const title =
    action === "approve"
        ? "El reclamo es válido"
        : action === "reject"
          ? "El reclamo no corresponde"
          : action === "close"
            ? "Finalizar reclamo"
            : action === "approve_cancellation"
              ? "Aprobar cancelación"
              : "Rechazar cancelación"
  const subtitle =
    action === "approve"
        ? "Registrar que BEYONIX acepta el reclamo."
        : action === "reject"
          ? "Informar al cliente el motivo del rechazo."
          : action === "close"
            ? "Finalizar el reclamo indica que no quedan gestiones pendientes."
            : action === "approve_cancellation"
              ? "Esta acción cancela el pedido si el backend confirma que no fue facturado ni despachado."
              : "Esta acción rechazará la cancelación y notificará el motivo al cliente."
  const ctaLabel =
    action === "approve"
        ? "Aceptar reclamo"
        : action === "reject"
          ? "Rechazar reclamo"
          : action === "approve_cancellation"
            ? "Aprobar cancelación"
            : action === "reject_cancellation"
              ? "Rechazar cancelación"
              : "Finalizar reclamo"

  const creditNoteAmountNumber = Number(creditNoteAmount.replace(",", ".").trim())
  const confirmDisabled =
    saving ||
    (action === "reject" && message.trim().length < 5) ||
    (action === "reject_cancellation" && message.trim().length < 5) ||
    (action === "approve_cancellation" && !cancellationCanBeApproved) ||
    (
      action === "approve" &&
      resolution === "cupon_descuento" &&
      (!Number.isFinite(creditNoteAmountNumber) || creditNoteAmountNumber <= 0)
    )
  const resolutionToneClassNames: Record<Exclude<OrderClaimResolution, "rechazado">, string> = {
    cambio_producto: "border-blue-300/25 hover:border-blue-300/60",
    envio_unidad_faltante: "border-sky-300/25 hover:border-sky-300/60",
    cupon_descuento: "border-amber-300/25 hover:border-amber-300/60",
    saldo_a_favor: "border-cyan-300/25 hover:border-cyan-300/60",
    reintegro_total: "border-emerald-300/25 hover:border-emerald-300/60",
    reintegro_parcial: "border-emerald-300/25 hover:border-emerald-300/60",
    otro: "border-white/10 hover:border-white/25",
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/78 p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="admin-claim-action-modal w-full max-w-md rounded-xl border border-blue-300/24 bg-[#050c14] p-3 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h4 className="text-base font-black text-white">{title}</h4>
            <p className="mt-1 text-xs font-semibold leading-5 text-white/64">{subtitle}</p>
          </div>
          <button type="button" onClick={onClose} disabled={saving} className="admin-ds-button admin-ds-button-secondary h-8 px-2 text-10px font-black" aria-label="Cerrar">
            <X className="size-4" />
          </button>
        </div>

        <div className="mt-3 space-y-2">
          {action === "approve" && (
            <div>
              <p className="text-sm font-black text-white">¿Cómo se resolverá el caso?</p>
              <div className="mt-2 grid gap-1">
                {RESOLUTION_OPTIONS.map((option) => (
                  <label key={option.value} className={`flex cursor-pointer items-center gap-2 rounded-lg border bg-white/[0.03] px-2.5 py-1.5 text-xs font-bold text-white ${resolutionToneClassNames[option.value]}`}>
                    <input
                      type="radio"
                      name="claim-resolution"
                      value={option.value}
                      checked={resolution === option.value}
                      onChange={(event) => onResolutionChange(event.target.value as Exclude<OrderClaimResolution, "rechazado">)}
                    />
                    {option.label}
                  </label>
                ))}
              </div>
              {resolution === "cupon_descuento" && (
                <div className="mt-2 rounded-lg border border-emerald-300/20 bg-emerald-950/18 p-2">
                  <label className="text-10px font-black uppercase text-emerald-100/70">
                    Monto a reconocer con nota de crédito
                  </label>
                  <p className="mt-1 text-[11px] font-semibold leading-4 text-emerald-50/70">
                    Cargá solo la diferencia a favor del cliente. Ej: si facturaste $50.000 y conserva un producto de $20.000, corresponde $30.000.
                  </p>
                  <input
                    inputMode="decimal"
                    value={creditNoteAmount}
                    onChange={(event) => onCreditNoteAmountChange(event.target.value)}
                    placeholder="Ej: 2500"
                    className={`${adminControlClassName} mt-1 h-8 min-h-8 px-2 text-xs`}
                  />
                </div>
              )}
            </div>
          )}

          {action === "approve_cancellation" && (
            <div>
              <label className="text-10px font-black uppercase text-white/50">Mensaje para el cliente</label>
              <textarea
                value={message}
                onChange={(event) => onMessageChange(event.target.value)}
                rows={3}
                placeholder="Opcional"
                className={`${adminControlClassName} mt-1 min-h-20 resize-none px-3 py-2 text-xs leading-5`}
              />
            </div>
          )}

          {(action === "reject" || action === "reject_cancellation") && (
            <>
              <div>
                <label className="text-10px font-black uppercase text-white/50">Motivo</label>
                <select
                  value={reason}
                  onChange={(event) => onReasonChange(event.target.value)}
                  className={`${adminControlClassName} mt-1`}
                >
                  {REJECTION_REASONS.map((item) => (
                    <option key={item} value={item}>{item}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-10px font-black uppercase text-white/50">Mensaje para el cliente</label>
                <textarea
                  value={message}
                  onChange={(event) => onMessageChange(event.target.value)}
                  rows={3}
                  placeholder="Escribí el motivo que recibirá el cliente."
                  className={`${adminControlClassName} mt-1 min-h-20 resize-none px-3 py-2 text-xs leading-5`}
                />
              </div>
            </>
          )}
        </div>

        <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" disabled={saving} onClick={onClose} className="admin-ds-button admin-ds-button-secondary h-9 px-4 text-xs font-black">
            Volver
          </button>
          <button
            type="button"
            disabled={confirmDisabled}
            onClick={onConfirm}
            className={`admin-ds-button ${destructive ? "admin-ds-button-destructive" : action === "close" ? "admin-claim-action-confirm-ok" : "admin-ds-button-primary"} h-9 px-4 text-xs font-black`}
          >
            {saving ? "Procesando..." : ctaLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
