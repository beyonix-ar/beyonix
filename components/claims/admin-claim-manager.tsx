"use client"

import { useEffect, useId, useLayoutEffect, useRef, useState, type ChangeEvent, type ReactNode, type RefObject } from "react"
import {
  Check,
  CheckCircle2,
  ChevronDown,
  CircleQuestionMark,
  ClipboardList,
  CreditCard,
  Download,
  Eye,
  FileText,
  Flag,
  Info,
  LoaderCircle,
  Lock,
  MessageSquare,
  Package,
  PackageCheck,
  PackageOpen,
  Pencil,
  Play,
  Repeat2,
  Send,
  ShieldCheck,
  Truck,
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
import { getAdminCapabilities } from "@/lib/admin/admin-capabilities"
import { ADMIN_SENSITIVE_DANGER } from "@/lib/admin/admin-sensitive-visuals"
import { notifyOrderNotificationsChanged } from "@/lib/admin/order-notifications"
import { getCuentaItemImage } from "@/lib/account/account-utils"
import { getOrderClaimResolutionLabel, getPendingRefundNotes } from "@/lib/order-claims"
import { MercadoPagoRefundAction } from "@/components/claims/mercadopago-refund-action"
import {
  isClaimVisibleForMode,
  shouldShowReturnInventoryPanel,
} from "@/lib/orders/claim-visibility"
import { shouldPollSingleClaim } from "@/lib/orders/claim-polling"
import {
  getClaimProgressSteps,
  getReplacementFlow,
  sumReplacedUnits,
  sumClaimReplacedUnits,
  type ClaimProgressStep,
  type ClaimStepState,
  type RegisteredReplacement,
  type ReplacementFlow,
  type ReplacementLoadState,
} from "@/lib/orders/claim-replacement-flow"
import { useClaimReplyDraft } from "@/components/claims/use-claim-reply-draft"
import { useScopedState } from "@/hooks/use-scoped-state"
import {
  getOrCreateIdempotencyAttempt,
  type IdempotencyAttempt,
} from "@/lib/business/idempotency-attempt"
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
  return {
    received: "0",
    goodCondition: "0",
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

function getReturnedQuantity(item: SupabasePedidoItem) {
  return Number(item.return_restocked_quantity ?? 0) + Number(item.return_written_off_quantity ?? 0)
}

function getReceptionTotals(entries: Array<{ item: SupabasePedidoItem; quantity: number }>) {
  return entries.reduce(
    (totals, { item, quantity }) => ({
      claimed: totals.claimed + quantity,
      received: totals.received + Math.min(quantity, getReturnedQuantity(item)),
    }),
    { claimed: 0, received: 0 },
  )
}

// Ayuda contextual: ícono con tooltip que aparece en hover y en foco de
// teclado (Escape lo cierra). Sólo CSS, sin dependencias nuevas; el texto
// queda enlazado por aria-describedby para lectores de pantalla.
function ClaimHelpTip({ label, children }: { label: string; children: string }) {
  const tooltipId = useId()

  return (
    <span className="admin-claim-help">
      <button
        type="button"
        aria-label={`Ayuda: ${label}`}
        aria-describedby={tooltipId}
        onKeyDown={(event) => {
          if (event.key === "Escape") event.currentTarget.blur()
        }}
        className="admin-claim-help-trigger admin-claim-flow-control"
      >
        <CircleQuestionMark className="size-3.5" />
      </button>
      <span role="tooltip" id={tooltipId} className="admin-claim-help-bubble">
        {children}
      </span>
    </span>
  )
}

function ClaimStepper({ steps }: { steps: ClaimProgressStep[] }) {
  if (steps.length === 0) return null

  return (
    <ol aria-label="Progreso del reclamo" className="admin-claim-stepper">
      {steps.map((step, index) => (
        <li
          key={step.key}
          aria-current={step.state === "current" ? "step" : undefined}
          className={`admin-claim-stepper-item is-${step.state}`}
        >
          <span className="admin-claim-stepper-dot" aria-hidden="true">
            {step.state === "done" ? <Check className="size-3.5" strokeWidth={3} /> : index + 1}
          </span>
          <span className="admin-claim-stepper-label">{step.label}</span>
          <span className="sr-only">
            {step.state === "done" ? " (completado)" : step.state === "current" ? " (paso actual)" : " (pendiente)"}
          </span>
        </li>
      ))}
    </ol>
  )
}

function ReceptionCounts({ claimed, received }: { claimed: number; received: number }) {
  const pending = Math.max(0, claimed - received)

  return (
    <dl className="admin-claim-reception-counts" aria-label="Unidades del reclamo">
      <div className="admin-claim-reception-count">
        <dt>Reclamadas</dt>
        <dd>{claimed}</dd>
      </div>
      <div className="admin-claim-reception-count">
        <dt>Recibidas</dt>
        <dd>{received}</dd>
      </div>
      <div className={`admin-claim-reception-count ${pending > 0 ? "is-pending" : "is-complete"}`}>
        <dt>Pendientes</dt>
        <dd>{pending}</dd>
      </div>
    </dl>
  )
}

function ReceptionProductHeader({
  item,
  productName,
  meta,
  claimed,
  received,
  lastReceptionAt,
}: {
  item: SupabasePedidoItem
  productName: string
  meta: string[]
  claimed: number
  received: number
  lastReceptionAt?: string | null
}) {
  const image = getCuentaItemImage(item)

  return (
    <div className="admin-claim-reception-product">
      <div className="flex min-w-0 items-center gap-3">
        <span className="admin-claim-reception-thumb">
          {image ? <img src={image} alt="" className="size-full object-contain" /> : <Package className="size-5" />}
        </span>
        <div className="min-w-0">
          <p className="admin-claim-reception-title">{productName}</p>
          {(meta.length > 0 || lastReceptionAt) && (
            <p className="admin-claim-reception-tags">
              {meta.map((part) => (
                <span key={part} className="admin-claim-reception-tag">{part}</span>
              ))}
              {lastReceptionAt && (
                <span className="admin-claim-reception-tag is-muted">
                  Última recepción {formatDate(lastReceptionAt)}
                </span>
              )}
            </p>
          )}
        </div>
      </div>
      <ReceptionCounts claimed={claimed} received={received} />
    </div>
  )
}

export function ReturnInventoryPanel({
  pedido,
  claim,
  canManage,
  registeredReplacements = null,
  onUpdated,
  onClaimChange,
}: {
  pedido: SupabasePedido
  claim: SupabaseOrderClaim
  canManage: boolean
  registeredReplacements?: RegisteredReplacement[] | null
  onUpdated?: () => void | Promise<void>
  /** Publica el reclamo devuelto por el servidor (p. ej. tras corregir productos). */
  onClaimChange?: (claim: SupabaseOrderClaim) => void
}) {
  // Estado remoto: productos, stock y selección reclamada se leen siempre de
  // las props. Los refrescos (polling, realtime, recargas) sólo actualizan
  // esto; nunca reescriben lo que el operador está editando.
  const orderItems = pedido.orden_items ?? []
  const affectedItems = getClaimAffectedItems(claim, orderItems)
  const affectedQuantityById = new Map(
    affectedItems.map((item) => [item.order_item_id, item.quantity]),
  )
  const items = orderItems.filter((item) => affectedQuantityById.has(Number(item.id)))

  // Estado de edición local: atado a (pedido, reclamo). Sólo se limpia al
  // cambiar de entidad, al confirmar con éxito o por acción del operador.
  // Un ítem sin borrador muestra el valor del servidor (no editado todavía).
  const draftScope = `${pedido.id}:${claim.id}`
  const [drafts, setDrafts] = useScopedState<Record<number, ReturnInventoryDraft>>(draftScope, {})
  const [editingAffectedItems, setEditingAffectedItems] = useScopedState(draftScope, false)
  const [affectedDrafts, setAffectedDrafts] = useScopedState<Record<number, string>>(draftScope, {})
  const [confirmationItemId, setConfirmationItemId] = useScopedState<number | null>(draftScope, null)
  const [notice, setNotice] = useScopedState<{ ok: boolean; message: string } | null>(draftScope, null)
  // También por entidad: un request que termina después de cambiar de
  // reclamo no deja "guardando" ni bloquea el formulario del nuevo.
  const [savingAffectedItems, setSavingAffectedItems] = useScopedState(draftScope, false)
  const [savingItemId, setSavingItemId] = useScopedState<number | null>(draftScope, null)
  const affectedVersionRef = useRef(claim.updated_at)
  const returnReceptionAttemptsRef = useRef<Record<number, IdempotencyAttempt | null>>({})

  const getAffectedDraftsFromClaim = () =>
    Object.fromEntries(affectedItems.map((item) => [item.order_item_id, String(item.quantity)]))

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

      onClaimChange?.(data.claim)
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
    // Devoluciones parciales sucesivas: ya no es "una sola vez por ítem" --
    // el tope es lo reclamado MENOS lo ya registrado en eventos anteriores.
    const alreadyReturned =
      Number(item.return_restocked_quantity ?? 0) + Number(item.return_written_off_quantity ?? 0)
    const remaining = claimedQuantity - alreadyReturned

    if (remaining <= 0) {
      setNotice({
        ok: false,
        message: "Ya se registró la recepción completa de este producto para el reclamo.",
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

    if (received > remaining) {
      setNotice({
        ok: false,
        message: `Quedan ${remaining} unidad(es) disponibles para registrar de este producto.`,
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

    if (received === 0) {
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

      const attempt = getOrCreateIdempotencyAttempt(
        returnReceptionAttemptsRef.current[item.id] ?? null,
        { itemId: item.id, restocked, writtenOff, note: draft.note.trim() },
        "return",
      )
      returnReceptionAttemptsRef.current[item.id] = attempt

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
            idempotencyKey: attempt.key,
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

      // Éxito: la próxima carga sobre este ítem (si queda remanente) es un
      // evento nuevo, no un reintento -- necesita una key nueva.
      returnReceptionAttemptsRef.current[item.id] = null
      // Recién ahora el borrador de este ítem deja de tener sentido: se
      // descarta y el ítem vuelve a mostrar lo que informa el servidor.
      setDrafts((current) => {
        const next = { ...current }
        delete next[item.id]
        return next
      })
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
  const confirmationStockDelta = confirmationRestocked
  const confirmationProductStock = Number(confirmationItem?.productos?.stock ?? 0)
  const confirmationVariantStock = Number(
    confirmationItem?.producto_variantes?.stock ?? 0,
  )
  const confirmationVariantName =
    confirmationItem?.conditioned_name?.trim() ||
    confirmationItem?.producto_variantes?.nombre?.trim() ||
    "Variante seleccionada"
  const receptionTotals = getReceptionTotals(
    items.map((item) => ({ item, quantity: affectedQuantityById.get(Number(item.id)) ?? 0 })),
  )
  const hasPendingInventory = receptionTotals.received < receptionTotals.claimed
  const progressSteps = getClaimProgressSteps({
    status: claim.status,
    resolution: claim.resolution,
    claimedUnits: receptionTotals.claimed,
    receivedUnits: receptionTotals.received,
    replacedUnits: claim.resolution === "cambio_producto"
      ? sumClaimReplacedUnits(registeredReplacements, claim, pedido.order_claims ?? [])
      : sumReplacedUnits(registeredReplacements, items.map((item) => Number(item.id))),
    creditNoteAuthorized: Boolean(
      pedido.order_credit_notes?.some((note) => note.claim_id === claim.id && note.status === "authorized"),
    ),
    refundCompleted: Boolean(claim.refund_completed_at),
  })

  return (
    <>
      <section
        id={`claim-reception-${claim.id}`}
        className="admin-claim-card admin-claim-reception-panel bx-surface bx-surface-section mx-3 mb-3 p-4 sm:mx-4 sm:mb-4 sm:p-5"
      >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="admin-claim-section-icon" aria-hidden="true">
            <PackageOpen className="size-5" />
          </span>
          <div className="min-w-0">
            <h4 className="admin-claim-reception-heading">Recepción del producto original</h4>
            <p className="admin-claim-reception-subtitle">
              Registrá cómo volvió el producto que entregó el cliente.
            </p>
            {claim.affected_items_updated_at && (
              <p className="admin-claim-reception-note">Productos corregidos por administración.</p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {!canManage && hasPendingInventory && (
            <span className="admin-claim-pill is-neutral">
              <Lock className="size-3" />
              Solo lectura
            </span>
          )}
          {canManage && (
            <button
              type="button"
              aria-expanded={editingAffectedItems}
              onClick={() => {
                affectedVersionRef.current = claim.updated_at
                // Al abrir, el editor parte de la selección vigente del servidor.
                if (!editingAffectedItems) setAffectedDrafts(getAffectedDraftsFromClaim())
                setEditingAffectedItems(!editingAffectedItems)
              }}
              className="admin-claim-flow-button admin-claim-flow-control is-secondary is-compact"
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
      <div className="admin-claim-stepper-track">
        <ClaimStepper steps={progressSteps} />
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
                        {locked ? " · Con recepción registrada" : ""}
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
                setAffectedDrafts(getAffectedDraftsFromClaim())
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

      <div className="mt-4 space-y-3">
        {items.length > 0 ? (
          items.map((item) => {
            const draft = drafts[item.id] ?? getReturnInventoryDraft(item)
            const productName = item.productos?.nombre ?? `Producto #${item.producto_id}`
            const claimedQuantity = affectedQuantityById.get(Number(item.id)) ?? 0
            const receivedQuantity = getReturnedQuantity(item)
            const productStock = Number(item.productos?.stock ?? 0)
            const variantStock = Number(item.producto_variantes?.stock ?? 0)
            const variantName =
              item.conditioned_name?.trim() ||
              item.producto_variantes?.nombre?.trim() ||
              "Variante seleccionada"
            const variantSku = item.conditioned_sku?.trim() || item.producto_variantes?.sku?.trim()
            const itemMeta = [
              item.conditioned_name?.trim() || item.producto_variantes?.nombre?.trim(),
              variantSku ? `SKU ${variantSku}` : null,
            ].filter((part): part is string => Boolean(part))
            const saving = savingItemId === item.id
            // Devoluciones parciales sucesivas: "procesado" ya no es un
            // booleano único -- el ítem sigue disponible mientras quede
            // remanente entre lo reclamado y lo efectivamente registrado.
            const remainingQuantity = claimedQuantity - receivedQuantity
            const inventoryLocked = Boolean(item.return_inventory_processed_at) && remainingQuantity <= 0
            const draftReceived = Number(draft.received || 0)
            const draftGoodCondition = Number(draft.goodCondition || 0)
            const draftWrittenOff = Math.max(draftReceived - draftGoodCondition, 0)
            const nextProductStock = productStock + draftGoodCondition
            const nextVariantStock = variantStock + draftGoodCondition
            const singleUnitCondition =
              claimedQuantity === 1 && draftReceived === 1
                ? draftGoodCondition === 1
                  ? "yes"
                  : "no"
                : null
            const noteRequired = draftWrittenOff > 0
            const missingStep =
              claimedQuantity === 1
                ? !singleUnitCondition
                  ? "Elegí qué hacer con la unidad."
                  : null
                : !(draftReceived > 0)
                  ? "Indicá cuántas unidades llegaron."
                  : null
            const missingReason =
              missingStep ??
              (noteRequired && draft.note.trim().length < 3
                ? "Indicá el motivo de la baja."
                : null)

            if (inventoryLocked) {
              const restockedQuantity = Number(item.return_restocked_quantity ?? 0)
              const writtenOffQuantity = Number(item.return_written_off_quantity ?? 0)
              const onlyRestocked = restockedQuantity > 0 && writtenOffQuantity === 0
              const onlyWrittenOff = writtenOffQuantity > 0 && restockedQuantity === 0
              const resultLabel = onlyRestocked
                ? claimedQuantity === 1
                  ? "Volvió al stock"
                  : `${restockedQuantity} unidades volvieron al stock`
                : onlyWrittenOff
                  ? claimedQuantity === 1
                    ? "Dada de baja"
                    : `${writtenOffQuantity} unidades dadas de baja`
                  : `${restockedQuantity} al stock · ${writtenOffQuantity} de baja`
              const impactParts = [
                restockedQuantity > 0
                  ? `+${restockedQuantity} ${restockedQuantity === 1 ? "unidad" : "unidades"} al stock disponible`
                  : null,
                writtenOffQuantity > 0
                  ? `${writtenOffQuantity} ${writtenOffQuantity === 1 ? "unidad registrada" : "unidades registradas"} como baja o pérdida`
                  : null,
              ].filter((part): part is string => Boolean(part))
              const resultTone = onlyRestocked ? "is-restock" : onlyWrittenOff ? "is-writeoff" : "is-mixed"

              return (
                <article key={`return-inventory-${item.id}`} className="admin-claim-reception-item">
                  <ReceptionProductHeader
                    item={item}
                    productName={productName}
                    meta={itemMeta}
                    claimed={claimedQuantity}
                    received={receivedQuantity}
                  />
                  <div className={`admin-claim-reception-feedback mt-3 ${resultTone}`}>
                    {onlyRestocked ? (
                      <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
                    ) : onlyWrittenOff ? (
                      <XCircle className="mt-0.5 size-4 shrink-0" />
                    ) : (
                      <PackageCheck className="mt-0.5 size-4 shrink-0" />
                    )}
                    <div>
                      <p className="admin-claim-reception-feedback-title">Recepción completa · {resultLabel}</p>
                      <p className="admin-claim-reception-feedback-text">{impactParts.join(" · ")}.</p>
                    </div>
                  </div>
                </article>
              )
            }

            return (
              <article key={`return-inventory-${item.id}`} className="admin-claim-reception-item">
                <ReceptionProductHeader
                  item={item}
                  productName={productName}
                  meta={itemMeta}
                  claimed={claimedQuantity}
                  received={receivedQuantity}
                  lastReceptionAt={item.return_inventory_processed_at}
                />

                {claimedQuantity === 1 ? (
                  <div className="admin-claim-reception-block">
                    <p className="admin-claim-reception-question" id={`reception-question-${item.id}`}>
                      ¿Qué hacemos con esta unidad?
                    </p>
                    <div
                      role="group"
                      aria-labelledby={`reception-question-${item.id}`}
                      className="mt-2.5 grid gap-2.5 sm:grid-cols-2"
                    >
                      <button
                        type="button"
                        disabled={!canManage || saving}
                        aria-pressed={singleUnitCondition === "yes"}
                        onClick={() => selectSingleUnitCondition(item, true)}
                        className="admin-claim-choice admin-claim-flow-control is-restock"
                      >
                        <span className="admin-claim-choice-icon" aria-hidden="true">
                          <PackageCheck className="size-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="admin-claim-choice-title">Volver al stock</span>
                          <span className="admin-claim-choice-text">Producto en buen estado y apto para la venta.</span>
                        </span>
                        <span className="admin-claim-choice-check" aria-hidden="true">
                          <Check className="size-3" strokeWidth={3} />
                        </span>
                      </button>
                      <button
                        type="button"
                        disabled={!canManage || saving}
                        aria-pressed={singleUnitCondition === "no"}
                        onClick={() => selectSingleUnitCondition(item, false)}
                        className="admin-claim-choice admin-claim-flow-control is-writeoff"
                      >
                        <span className="admin-claim-choice-icon" aria-hidden="true">
                          <XCircle className="size-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="admin-claim-choice-title">Dar de baja</span>
                          <span className="admin-claim-choice-text">Producto dañado o no apto para volver a venderse.</span>
                        </span>
                        <span className="admin-claim-choice-check" aria-hidden="true">
                          <Check className="size-3" strokeWidth={3} />
                        </span>
                      </button>
                    </div>
                    {singleUnitCondition && (
                      <p className={`admin-claim-pill mt-2.5 ${singleUnitCondition === "yes" ? "is-success" : "is-danger"}`}>
                        {singleUnitCondition === "yes"
                          ? item.variante_id
                            ? `Stock: ${productStock} → ${nextProductStock} · ${variantName}: ${variantStock} → ${nextVariantStock}`
                            : `Stock: ${productStock} → ${nextProductStock}`
                          : "La unidad no vuelve al stock."}
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="admin-claim-reception-block">
                    <p className="admin-claim-reception-question">¿Qué hacemos con las unidades que llegaron?</p>
                    <div className="mt-2.5 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                      <label className="admin-claim-quantity">
                        <span className="admin-claim-reception-label">Llegaron ahora</span>
                        <input
                          type="number"
                          min={0}
                          max={Math.max(0, remainingQuantity)}
                          step={1}
                          inputMode="numeric"
                          value={draft.received}
                          disabled={!canManage || saving}
                          onChange={(event) => updateDraft(item, "received", event.target.value)}
                          className={`${adminControlClassName} admin-claim-quantity-input`}
                        />
                      </label>
                      <label className="admin-claim-quantity is-restock">
                        <span className="admin-claim-reception-label is-restock">Vuelven al stock</span>
                        <input
                          type="number"
                          min={0}
                          max={draftReceived}
                          step={1}
                          inputMode="numeric"
                          value={draft.goodCondition}
                          disabled={!canManage || saving}
                          onChange={(event) => updateDraft(item, "goodCondition", event.target.value)}
                          className={`${adminControlClassName} admin-claim-quantity-input`}
                        />
                      </label>
                      <p className="admin-claim-quantity is-writeoff">
                        <span className="admin-claim-reception-label is-writeoff">Se dan de baja</span>
                        <strong className="admin-claim-quantity-value">{draftWrittenOff}</strong>
                      </p>
                    </div>
                    <p className="admin-claim-reception-hint mt-2.5">
                      <Info className="size-3.5 shrink-0" aria-hidden="true" />
                      Si recibís el pedido en partes, registrá sólo las unidades que llegaron ahora.
                    </p>
                  </div>
                )}

                <label className="admin-claim-reception-block block">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="admin-claim-reception-label">Observación interna</span>
                    <span className={`admin-claim-pill is-small ${noteRequired ? "is-danger" : "is-neutral"}`}>
                      {noteRequired ? "Obligatoria al dar de baja" : "Opcional"}
                    </span>
                  </span>
                  <textarea
                    value={draft.note}
                    disabled={!canManage || saving}
                    maxLength={1000}
                    rows={2}
                    aria-required={noteRequired}
                    onChange={(event) => updateDraft(item, "note", event.target.value)}
                    placeholder="Ej.: producto golpeado, faltan accesorios…"
                    className="admin-claim-note mt-2 w-full resize-none outline-none disabled:cursor-not-allowed disabled:opacity-55"
                  />
                </label>

                {canManage && (
                  <div className="admin-claim-reception-footer">
                    <button
                      type="button"
                      disabled={savingItemId !== null || Boolean(missingReason)}
                      aria-describedby={missingReason ? `reception-missing-${item.id}` : undefined}
                      onClick={() => void saveItem(item)}
                      className="admin-claim-flow-button admin-claim-flow-control is-primary is-large"
                    >
                      {saving ? <LoaderCircle className="size-4 animate-spin" /> : <PackageCheck className="size-4" />}
                      {saving ? "Guardando..." : "Confirmar recepción"}
                    </button>
                    {missingReason && (
                      <p className="admin-claim-reception-missing" id={`reception-missing-${item.id}`}>
                        {missingReason}
                      </p>
                    )}
                  </div>
                )}
              </article>
            )
          })
        ) : (
          <p className="admin-claim-reception-hint">
            Este reclamo no tiene productos seleccionados. Usá “Corregir productos” para indicarlos.
          </p>
        )}
      </div>
      </section>

      {confirmationItem && (
        // Isla visual propia (admin-reception-modal__*, globals.css): se
        // renderiza dentro del detalle de pedido, cuyas reglas globales pisan
        // bg-*, [rounded][border], text-white/N, tracking-widest y
        // .admin-ds-surface -- por eso el marcado no usa ninguna de ellas.
        <div
          className="admin-reception-modal__backdrop fixed inset-0 z-120 flex items-center justify-center p-4"
          role="presentation"
          onMouseDown={() => setConfirmationItemId(null)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="return-inventory-confirmation-title"
            aria-describedby="return-inventory-confirmation-description"
            className="admin-reception-modal w-full max-w-md p-4 sm:p-5"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <span className="admin-reception-modal__icon" aria-hidden="true">
                <PackageCheck className="size-5" />
              </span>
              <div className="min-w-0">
                <p className="admin-reception-modal__eyebrow">Confirmar movimiento</p>
                <h4 id="return-inventory-confirmation-title" className="admin-reception-modal__title mt-1">
                  Recepción de {confirmationItem.productos?.nombre ?? `Producto #${confirmationItem.producto_id}`}
                </h4>
                <p id="return-inventory-confirmation-description" className="admin-reception-modal__subtitle mt-1">
                  Revisá el destino de las unidades antes de modificar el inventario.
                </p>
              </div>
            </div>

            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              <div className="admin-reception-modal__metric is-restock">
                <p className="admin-reception-modal__metric-label">Vuelven al stock</p>
                <p className="admin-reception-modal__metric-value mt-1">{confirmationRestocked}</p>
              </div>
              <div className="admin-reception-modal__metric is-writeoff">
                <p className="admin-reception-modal__metric-label">Baja o pérdida</p>
                <p className="admin-reception-modal__metric-value mt-1">{confirmationWrittenOff}</p>
              </div>
            </div>

            <div className="admin-reception-modal__stock mt-3">
              <p className="admin-reception-modal__stock-label">Stock resultante</p>
              <div className="admin-reception-modal__stock-lines mt-1 space-y-0.5">
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

            <p className="admin-reception-modal__warning mt-3">
              Al confirmar se registra la recepción y su impacto de stock. Si queda remanente reclamado, podrás registrar una nueva recepción. No se borra el historial anterior.
            </p>

            <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                disabled={savingItemId !== null}
                onClick={() => setConfirmationItemId(null)}
                className="admin-claim-flow-button admin-claim-flow-control is-secondary is-large"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={savingItemId !== null}
                onClick={() => void saveItem(confirmationItem, true)}
                className="admin-claim-flow-button admin-claim-flow-control is-primary is-large"
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
  registeredReplacements = null,
  replacementLoadState,
}: {
  pedido: SupabasePedido
  mode?: "all" | "messaging" | "claims"
  onClaimChange: (claim: SupabaseOrderClaim) => void
  onInventoryUpdated?: () => void | Promise<void>
  onOpenBilling: () => void
  /** Reemplazos del pedido ya cargados por OrderReplacements; null = desconocido. */
  registeredReplacements?: RegisteredReplacement[] | null
  replacementLoadState?: ReplacementLoadState
}) {
  const { user } = useAuth()
  const isAdmin = getAdminCapabilities(user?.rol).canManageReturns
  const allClaims = pedido.order_claims ?? []
  const claims = allClaims.filter((item) => isClaimVisibleForMode(item.failure_type, mode))
  const [claimId, setClaimId] = useState<number | null>(claims[0]?.id ?? null)
  const claim = claims.find((item) => item.id === claimId) ?? claims[0]
  // Borrador de la respuesta: atado a (pedido, reclamo), nunca a los datos
  // que llegan del servidor -- las recargas (polling, realtime, mensaje
  // nuevo, cambio de estado) no lo vacían. Se limpia sólo tras un envío OK,
  // al borrarlo a mano o al pasar a otro pedido/reclamo (ver el hook).
  const [response, setResponse, clearResponse] = useClaimReplyDraft(pedido.id, claim?.id ?? null)
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
  // Último mensaje de éxito: el aviso se pinta en verde sólo si es ése;
  // cualquier error posterior lo reemplaza y vuelve al tono de alerta.
  const [successNotice, setSuccessNotice] = useState("")
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
    if (overrides.status === "cerrado" && claim.resolution === "cambio_producto" && (
      (replacementLoadState && replacementLoadState !== "ready") ||
      (sumClaimReplacedUnits(registeredReplacements, claim, allClaims) ?? 0) <= 0
    )) {
      setNotice("Primero verificá y registrá el reemplazo de este reclamo antes de finalizarlo.")
      return false
    }
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
      setSuccessNotice(successMessage)
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
    if (sent) clearResponse()
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
    if (sent) clearResponse()
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
      clearResponse()
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
      // Sin aviso: el panel ya muestra "Solución aprobada" y los pasos siguientes.
      "",
    )
    if (sent) {
      clearResponse()
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
      clearResponse()
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
      clearResponse()
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
      clearResponse()
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
      setSuccessNotice("Comprobante de reintegro cargado.")
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
  const summaryReceptionTotals = getReceptionTotals(summaryAffectedItems)
  const replacedUnits = claim.resolution === "cambio_producto" ? sumClaimReplacedUnits(
    registeredReplacements, claim, allClaims,
  ) : sumReplacedUnits(
    registeredReplacements,
    summaryAffectedItems.map(({ item }) => Number(item.id)),
  )
  const replacementFlow = getReplacementFlow({
    status: claim.status,
    resolution: claim.resolution,
    claimedUnits: summaryReceptionTotals.claimed,
    receivedUnits: summaryReceptionTotals.received,
    replacedUnits,
    replacementLoadState,
  })
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
          <section className="admin-claim-card bx-surface bx-surface-section rounded-xl border p-3">
            <p className="text-10px font-black uppercase text-white/45">Pedido</p>
            <p className="mt-1 text-xs font-bold text-white">{formatDate(pedido.created_at)}</p>
            <p className="mt-1 text-xs font-semibold text-white/70">{pedido.estado}</p>
            <p className="mt-1 text-xs font-semibold text-white/70">
              {getClaimSummaryPaymentLabel(pedido)} · {pedido.shipping_type === "sucursal" ? "Retiro en sucursal" : "Envío a domicilio"}
            </p>
            <p className="mt-1 text-xs font-semibold text-white/70">Total: {formatPrice(pedido.total)}</p>
          </section>

          <section className="admin-claim-card bx-surface bx-surface-section rounded-xl border p-3">
            <p className="text-10px font-black uppercase text-white/45">Motivo del reclamo</p>
            <p className="mt-1 text-xs font-bold text-white">{PROBLEM_LABELS[claim.failure_type ?? ""] ?? "Reclamo"}</p>
            <p className="mt-1 text-[11px] leading-4 text-white/60 line-clamp-3">{claim.description}</p>
          </section>

          <section className="admin-claim-card bx-surface bx-surface-section rounded-xl border p-3">
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
            <section className="admin-claim-card bx-surface bx-surface-section rounded-xl border p-3">
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
          <section className={`admin-claim-card rounded-xl border p-2.5 ${helpResolved ? "admin-claim-help-resolved-card" : "bx-surface bx-surface-section"}`}>
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
          <section className="admin-claim-card admin-claim-manage-panel bx-surface bx-surface-section rounded-xl border p-3 sm:p-4">
            <div className="flex items-center gap-2.5">
              <span className="admin-claim-section-icon is-small" aria-hidden="true">
                <ClipboardList className="size-4" />
              </span>
              <h4 className="admin-claim-manage-heading">Gestionar reclamo</h4>
            </div>
            <div className={`admin-claim-overview mt-3 ${claim.resolution && claim.resolution !== "rechazado" ? "has-resolution" : ""}`}>
              <div className="admin-claim-status-box admin-claim-overview-tile">
                <p className="admin-claim-status-label admin-claim-overview-label">Estado actual</p>
                <p className="admin-claim-status-value admin-claim-overview-value">
                  <span className="admin-claim-overview-dot" aria-hidden="true" />
                  {getStatusLabel(claim)}
                </p>
              </div>

              {claim.resolution && claim.resolution !== "rechazado" && (
                <div className="admin-claim-resolution-box admin-claim-overview-tile">
                  <p className="admin-claim-resolution-label admin-claim-overview-label">
                    {claim.resolution === "otro" ? "Decisión tomada" : "Solución aprobada"}
                  </p>
                  <p className="admin-claim-resolution-value admin-claim-overview-value">
                    {getOrderClaimResolutionLabel(claim.resolution)}
                  </p>
                </div>
              )}
            </div>
            {claim.resolution && claim.resolution !== "rechazado" && !canCompleteReplacementSolution && (
              <p className="admin-claim-resolution-next mt-2 text-[11px] font-semibold leading-4">
                {getResolutionNextStep(claim)}
              </p>
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
                  <ReplacementFlowSteps
                    flow={replacementFlow}
                    missingUnit={claim.resolution === "envio_unidad_faltante"}
                    claimedUnits={summaryReceptionTotals.claimed}
                    receivedUnits={summaryReceptionTotals.received}
                    replacedUnits={replacedUnits}
                    replacementLoadState={replacementLoadState}
                    saving={saving}
                    onGoToReception={() => document.getElementById(`claim-reception-${claim.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                    onRegisterReplacement={() => document.getElementById(`order-replacements-${pedido.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                    onConfirmDelivery={() => setPendingConfirmation({
                      title: "Confirmar entrega del reemplazo",
                      description: "Confirmá sólo si ya registraste el retiro de stock y efectivamente enviaste o entregaste el reemplazo. Se finalizará el reclamo y se notificará al cliente. Esta confirmación no crea un envío ni descuenta stock adicional.",
                      confirmLabel: "Ya fue enviado o entregado",
                      run: markAcceptedSolutionDone,
                    })}
                    onFinalize={canCloseClaim ? () => openDecision("close") : undefined}
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
                {canManageRefund && pedido.payment_method_id === "mercadopago" && (
                  <MercadoPagoRefundAction pedido={pedido} onUpdated={onInventoryUpdated} />
                )}
                {canManageRefund && pedido.payment_method_id !== "mercadopago" && (
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
                {canCloseClaim && !canCompleteReplacementSolution && (
                  <DecisionButton
                    icon={<CheckCircle2 className="size-4" />}
                    title="Finalizar reclamo"
                    description="Bloquear nuevas acciones y dejarlo visible en el historial."
                    tone="primary"
                    disabled={saving || (claim.resolution === "cambio_producto" && !replacementFlow.canConfirmDelivery)}
                    onClick={() => openDecision("close")}
                  />
                )}
                {closed && (
                  <div className="admin-claim-closed-note px-3 py-2">
                    <p className="admin-claim-closed-title text-xs font-black">Reclamo finalizado</p>
                    <p className="admin-claim-closed-text mt-1 text-[11px] font-semibold leading-4">
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
          registeredReplacements={registeredReplacements}
          onUpdated={onInventoryUpdated}
          onClaimChange={onClaimChange}
        />
      )}

      {notice && (
        notice === successNotice ? (
          <p role="status" className="admin-claim-notice-success mx-3 mb-3 px-3 py-2 text-xs font-bold sm:mx-4 sm:mb-4">{notice}</p>
        ) : (
          <p role="alert" className={`mx-3 mb-3 rounded-lg border px-3 py-2 text-xs font-bold text-white sm:mx-4 sm:mb-4 ${ADMIN_SENSITIVE_DANGER.panelSoft}`}>{notice}</p>
        )
      )}

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
          closeBlocked={claim.resolution === "cambio_producto" && !replacementFlow.canConfirmDelivery}
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
                disabled={saving || (claim.resolution === "cambio_producto" && !replacementFlow.canConfirmDelivery)}
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

type ReplacementFlowStepView = {
  key: string
  icon: ReactNode
  title: string
  description: string
  help: string
  state: ClaimStepState
  doneLabel: string
  progress: string | null
  blockedReason: string | null
  action?: { label: string; enabled: boolean; onClick: () => void }
}

function FlowStepBadge({ step, active }: { step: ReplacementFlowStepView; active: boolean }) {
  if (step.state === "done") {
    return <span className="admin-claim-pill is-success is-small"><Check className="size-3" strokeWidth={3} />{step.doneLabel}</span>
  }
  if (active) return <span className="admin-claim-pill is-brand is-small">Ahora</span>
  if (step.action && !step.action.enabled) {
    return <span className="admin-claim-pill is-neutral is-small"><Lock className="size-3" />Bloqueado</span>
  }
  if (step.progress) return <span className="admin-claim-pill is-warning is-small">{step.progress}</span>
  return <span className="admin-claim-pill is-neutral is-small">Pendiente</span>
}

export function ReplacementFlowSteps({
  flow,
  missingUnit,
  claimedUnits,
  receivedUnits,
  replacedUnits,
  replacementLoadState,
  saving,
  onGoToReception,
  onRegisterReplacement,
  onConfirmDelivery,
  onFinalize,
}: {
  flow: ReplacementFlow
  missingUnit: boolean
  claimedUnits: number
  receivedUnits: number
  replacedUnits: number | null
  replacementLoadState?: ReplacementLoadState
  saving: boolean
  onGoToReception: () => void
  onRegisterReplacement: () => void
  onConfirmDelivery: () => void
  onFinalize?: () => void
}) {
  const steps: ReplacementFlowStepView[] = []
  const verifyingReplacement =
    !missingUnit && (replacedUnits === null || replacementLoadState === "loading" || replacementLoadState === "error")

  if (flow.requiresReception) {
    steps.push({
      key: "reception",
      icon: <PackageOpen className="size-4" />,
      title: "Recibir producto original",
      description: "Registrá cómo volvió el producto del cliente.",
      help: "Cuando el producto vuelva a BEYONIX, indicá en la sección de recepción si vuelve al stock o se da de baja. Podés registrar recepciones parciales.",
      state: flow.reception,
      doneLabel: "Recibido",
      progress:
        claimedUnits === 0
          ? "Sin productos"
          : receivedUnits > 0
            ? `${receivedUnits} de ${claimedUnits}`
            : null,
      blockedReason: null,
      action: { label: "Ir a recepción", enabled: true, onClick: onGoToReception },
    })
  }

  steps.push({
    key: "replacement",
    icon: <Repeat2 className="size-4" />,
    title: missingUnit ? "Preparar unidad faltante" : "Preparar reemplazo",
    description: missingUnit
      ? "Elegí la unidad que recibirá el cliente y descontala del stock."
      : "Elegí qué producto recibirá el cliente y descontalo del stock.",
    help: "Te lleva a “Reemplazos del pedido”: ahí elegís la variante que recibe el cliente y se descuenta del stock. No crea un envío.",
    state: flow.replacement,
    doneLabel: "Registrado",
    progress: replacedUnits !== null && replacedUnits > 0 ? `${replacedUnits} de ${claimedUnits}` : null,
    blockedReason: flow.canRegisterReplacement ? null : "Disponible cuando llegue el producto original.",
    action: { label: "Registrar reemplazo", enabled: flow.canRegisterReplacement, onClick: onRegisterReplacement },
  })

  steps.push({
    key: "delivery",
    icon: <Truck className="size-4" />,
    title: missingUnit ? "Entregar unidad faltante" : "Entregar reemplazo",
    description: "Confirmá cuando el nuevo producto ya fue enviado o entregado.",
    help: "Usá esta acción cuando el reemplazo ya fue enviado o entregado al cliente. Esto finaliza el reclamo y le avisa al cliente.",
    state: flow.delivery,
    doneLabel: "Entregado",
    progress: null,
    blockedReason: verifyingReplacement
      ? replacementLoadState === "error"
        ? "No pudimos verificar el reemplazo. Reintentá antes de continuar."
        : "Verificando reemplazo…"
      : flow.canConfirmDelivery
        ? null
        : "Disponible cuando registres el reemplazo.",
    action: { label: "Confirmar envío o entrega", enabled: flow.canConfirmDelivery, onClick: onConfirmDelivery },
  })

  const primaryKey = steps.find((step) => step.state === "current" && step.action?.enabled)?.key
  const finalizeBlocked = !missingUnit && !flow.canConfirmDelivery

  return (
    <div className="admin-claim-flow">
      <p className="admin-claim-flow-heading">Próximos pasos</p>
      <ol className="admin-claim-flow-list">
        {steps.map((step) => {
          const active = step.key === primaryKey
          const blocked = Boolean(step.action && !step.action.enabled) && step.state !== "done"
          return (
            <li
              key={step.key}
              aria-current={active ? "step" : undefined}
              className={`admin-claim-flow-step is-${step.state} ${active ? "is-active" : ""} ${blocked ? "is-blocked" : ""}`}
            >
              <span className="admin-claim-flow-marker" aria-hidden="true">
                {step.state === "done" ? <Check className="size-3.5" strokeWidth={3} /> : step.icon}
              </span>
              <div className="admin-claim-flow-body">
                <div className="flex items-start justify-between gap-2">
                  <p className="admin-claim-flow-title">{step.title}</p>
                  <span className="flex shrink-0 items-center gap-1">
                    <FlowStepBadge step={step} active={active} />
                    <ClaimHelpTip label={step.title}>{step.help}</ClaimHelpTip>
                  </span>
                </div>
                {step.state !== "done" && (
                  <>
                    <p className="admin-claim-flow-text">{step.description}</p>
                    {step.blockedReason && (
                      <p className="admin-claim-flow-blocked">
                        {replacementLoadState === "loading" && step.key === "delivery" ? (
                          <LoaderCircle className="size-3 shrink-0 animate-spin" aria-hidden="true" />
                        ) : (
                          <Lock className="size-3 shrink-0" aria-hidden="true" />
                        )}
                        {step.blockedReason}
                      </p>
                    )}
                    {step.action && (
                      <button
                        type="button"
                        disabled={saving || !step.action.enabled}
                        onClick={step.action.onClick}
                        className={`admin-claim-flow-button admin-claim-flow-control ${active ? "is-primary" : "is-secondary"} mt-2.5`}
                      >
                        {step.action.label}
                      </button>
                    )}
                  </>
                )}
              </div>
            </li>
          )
        })}
        {onFinalize && (
          <li className={`admin-claim-flow-step is-alternative ${finalizeBlocked ? "is-blocked" : ""}`}>
            <span className="admin-claim-flow-marker" aria-hidden="true">
              <Flag className="size-4" />
            </span>
            <div className="admin-claim-flow-body">
              <div className="flex items-start justify-between gap-2">
                <p className="admin-claim-flow-title">Finalizar reclamo</p>
                <span className="flex shrink-0 items-center gap-1">
                  <span className="admin-claim-pill is-neutral is-small">
                    {finalizeBlocked ? <><Lock className="size-3" />Bloqueado</> : "Alternativa"}
                  </span>
                  <ClaimHelpTip label="Finalizar reclamo">
                    Cierra el reclamo sin usar “Confirmar envío o entrega”. Podés dejar un mensaje opcional al cliente.
                  </ClaimHelpTip>
                </span>
              </div>
              <p className="admin-claim-flow-text">Cerrá el caso con un mensaje opcional al cliente.</p>
              {finalizeBlocked && (
                <p className="admin-claim-flow-blocked">
                  <Lock className="size-3 shrink-0" aria-hidden="true" />
                  Disponible cuando registres el reemplazo.
                </p>
              )}
              <button
                type="button"
                disabled={saving || finalizeBlocked}
                onClick={onFinalize}
                className="admin-claim-flow-button admin-claim-flow-control is-secondary mt-2.5"
              >
                Finalizar reclamo
              </button>
            </div>
          </li>
        )}
      </ol>
    </div>
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
      // Tono, borde y radio viven en .admin-claim-decision-button (globals.css)
      // con variantes Light/Dark: sin rounded+border ni text-white/N, que las
      // reglas globales del admin reescribían (texto oscuro sobre fondo oscuro).
      className={`admin-claim-decision-button is-${tone} ${
        disabled && mutedWhenDisabled ? "is-disabled-muted" : ""
      } px-2.5 py-1.5 text-left transition disabled:cursor-not-allowed`}
    >
      <span className="flex items-center gap-2">
        <span className="admin-claim-decision-icon grid size-6 shrink-0 place-items-center">{icon}</span>
        <span className="min-w-0">
          <span className="admin-claim-decision-title block text-xs font-black">{title}</span>
          <span className="admin-claim-decision-description mt-0.5 block text-10px font-semibold leading-4">{description}</span>
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
    <section className="admin-claim-chat-panel bx-surface bx-surface-section flex flex-col overflow-hidden rounded-xl border">
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
              {/* Colores por remitente en .admin-claim-chat-* (globals.css): sin
                  rounded+border ni text-white/N, que el tema Light reescribe. */}
              <div className={`admin-claim-chat-bubble ${isCustomer ? "admin-claim-chat-bubble-customer" : "admin-claim-chat-bubble-beyonix"}`}>
                <p className="admin-claim-chat-author">{isCustomer ? "Cliente" : "BEYONIX"}</p>
                <p className="admin-claim-chat-text mt-1 whitespace-pre-wrap">{getClaimMessageText(message.message)}</p>
                <p className="admin-claim-chat-time mt-1">{formatDate(message.created_at)}</p>
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
  closeBlocked = false,
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
  closeBlocked?: boolean
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
    (action === "close" && closeBlocked) ||
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
