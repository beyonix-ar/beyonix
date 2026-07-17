"use client"

import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type ReactNode, type RefObject } from "react"
import {
  CheckCircle2,
  CreditCard,
  Download,
  Eye,
  FileText,
  MessageSquare,
  PackageCheck,
  Play,
  Send,
  ShieldCheck,
  Upload,
  XCircle,
  X,
} from "lucide-react"

import { AdminSelect, adminControlClassName } from "@/app/admin/components/admin-controls"
import { useAuth } from "@/context/auth-context"
import { ADMIN_SENSITIVE_DANGER } from "@/lib/admin/admin-sensitive-visuals"
import { notifyOrderNotificationsChanged } from "@/lib/admin/order-notifications"
import { getOrderClaimResolutionLabel } from "@/lib/order-claims"
import { supabase } from "@/lib/supabase/client"
import type {
  OrderClaimResolution,
  OrderClaimStatus,
  SupabaseOrderClaimFile,
  SupabaseOrderClaimMessage,
  SupabaseOrderClaim,
  SupabasePedido,
} from "@/lib/supabase/types"

const PROBLEM_LABELS: Record<string, string> = {
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
    return "Reclamo finalizado"
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

    if (claim.status === "cambio_pendiente" || claim.status === "cerrado") {
      return "Reposición de la unidad faltante registrada. El reclamo quedó finalizado en el historial."
    }

    return "Prepará y despachá la unidad faltante. Luego registrá la acción cuando corresponda."
  }

  if (resolution === "cambio_producto") {
    if (claim.status === "reemplazo_enviado") {
      return "Reemplazo despachado. El cliente puede consultar el seguimiento desde el chat."
    }

    if (claim.status === "cambio_pendiente" || claim.status === "cerrado") {
      return "Cambio registrado. El reclamo quedó finalizado en el historial."
    }

    return "Coordiná por el chat dónde debe enviar o entregar el producto original. Luego prepará el reemplazo y marcá la acción cuando corresponda."
  }

  if (resolution === "cupon_descuento") {
    if (claim.status === "cupon_pendiente" || claim.status === "cerrado") {
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

    return "Reintegro registrado para el cliente. El reclamo quedó finalizado."
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

export function AdminClaimManager({
  pedido,
  mode = "all",
  onClaimChange,
}: {
  pedido: SupabasePedido
  mode?: "all" | "messaging" | "claims"
  onClaimChange: (claim: SupabaseOrderClaim) => void
}) {
  const { isAdmin } = useAuth()
  const allClaims = pedido.order_claims ?? []
  const claims = allClaims.filter((item) => {
    if (mode === "messaging") return item.failure_type === "consulta_pedido"
    if (mode === "claims") return item.failure_type !== "consulta_pedido" && item.failure_type !== "cancelar_compra"
    return true
  })
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
  const [refundDate, setRefundDate] = useState("")
  const [refundAmount, setRefundAmount] = useState("")
  const [previewFile, setPreviewFile] = useState<SupabaseOrderClaimFile | null>(null)
  const [showCloseConversationModal, setShowCloseConversationModal] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loadingOrderClaims, setLoadingOrderClaims] = useState(false)
  const [notice, setNotice] = useState("")
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
    setLoadingOrderClaims(true)

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
      } finally {
        if (active) setLoadingOrderClaims(false)
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
    setRefundDate("")
    setRefundAmount("")
    setPreviewFile(null)
    setResponse("")
    setNotice("")
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
        nextMessageCount !== messageCount
      ) {
        onClaimChange(data.claim)
      }
    }

    const intervalId = window.setInterval(() => void refreshClaim(), 5000)
    window.addEventListener("focus", refreshClaim)
    return () => {
      active = false
      window.clearInterval(intervalId)
      window.removeEventListener("focus", refreshClaim)
    }
  }, [claim?.id, claim?.updated_at, messageCount, onClaimChange])

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
        return false
      }

      onClaimChange(data.claim)
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
    const nextStatus = claim.resolution === "cupon_descuento" ? "cupon_pendiente" : "cambio_pendiente"
    const sent = await updateClaim(
      {
        status: nextStatus,
        resolution: claim.resolution ?? decisionResolution,
      },
      "Reclamo finalizado.",
    )
    if (sent) closeDecision()
  }

  const issueCreditNote = async () => {
    if (!claim) return
    setSaving(true)
    setNotice("")

    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        setNotice("La sesión administrativa venció.")
        return
      }

      const request = await fetch(`/api/admin/orders/${pedido.id}/credit-note`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      })
      const data = (await request.json()) as {
        error?: string
      }

      if (!request.ok) {
        setNotice(data.error || "No se pudo emitir la nota de crédito.")
        return
      }

      setNotice("Nota de crédito emitida por ARCA.")
      notifyOrderNotificationsChanged()
      await markAcceptedSolutionDone()
    } catch {
      setNotice("No se pudo emitir la nota de crédito.")
    } finally {
      setSaving(false)
    }
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
      formData.set("action", "upload_refund_proof")
      formData.set("file", refundProofFile)

      const request = await fetch(`/api/admin/order-claims/${claim.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
        body: formData,
      })
      const data = (await request.json()) as {
        claim?: SupabaseOrderClaim
        error?: string
      }

      if (!request.ok || !data.claim) {
        setNotice(data.error || "No se pudo cargar el comprobante.")
        return
      }

      onClaimChange(data.claim)
      setRefundProofFile(null)
      setNotice("Comprobante de reintegro cargado.")
      notifyOrderNotificationsChanged()
    } catch {
      setNotice("No se pudo cargar el comprobante.")
    } finally {
      setSaving(false)
    }
  }

  const markRefundDone = async () => {
    if (!claim) return
    if (!refundDate.trim() || !refundAmount.trim()) {
      setNotice("Indicá la fecha y el monto reintegrado.")
      return
    }

    const sent = await updateClaim(
      {
        status: "cambio_pendiente",
        resolution: "reintegro_total",
        admin_response: `Reintegro realizado el ${refundDate.trim()} por ${refundAmount.trim()}.`,
        append_message: true,
      },
      "Reintegro marcado como realizado.",
    )
    if (sent) {
      setRefundDate("")
      setRefundAmount("")
    }
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
          : "Mensajería de ayuda"
    const emptyDescription =
      mode === "claims"
        ? "Este pedido todavía no tiene reclamos formales cargados."
        : mode === "messaging"
          ? "Este pedido todavía no tiene mensajes previos a la entrega."
          : "Este pedido todavía no tiene mensajes de ayuda ni reclamos."
    return (
      <section className="admin-claim-manager admin-ds-card mt-3 p-4">
        <h3 className="text-base font-black text-white">{title}</h3>
        <p className="mt-1 text-sm text-white/66">{emptyDescription}</p>
        {notice && <p className="mt-3 rounded-lg border border-red-300/20 bg-red-500/8 px-3 py-2 text-xs font-bold text-red-100">{notice}</p>}
      </section>
    )
  }

  const messages = sortUniqueMessages(claim.order_claim_messages)
  const files = claim.order_claim_files ?? []
  const refundProof = files.find((file) => file.file_role === "comprobante_devolucion")
  const evidenceFiles = files.filter((file) => !["comprobante_devolucion", "comprobante_diferencia"].includes(file.file_role))
  const closed = ["cerrado", "rechazado"].includes(claim.status)
  const conversationLocked = claim.status === "rechazado"
  const helpMessage = claim.failure_type === "consulta_pedido"
  const canReviewClaim = !closed && ["recibido", "en_revision", "falta_informacion"].includes(claim.status)
  const canCompleteAcceptedSolution = !closed && claim.status === "aprobado"
  const canCompleteReplacementSolution =
    canCompleteAcceptedSolution &&
    (claim.resolution === "cambio_producto" || claim.resolution === "envio_unidad_faltante")
  const canManageRefund = !closed && claim.status === "reintegro_pendiente" && claim.resolution === "reintegro_total"
  const canIssueCreditNote =
    !closed &&
    claim.resolution === "cupon_descuento" &&
    !pedido.credit_note_issued &&
    pedido.credit_note_status !== "authorized" &&
    !pedido.credit_note_cae
  const canCloseClaim = !closed && !cancellation
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
            onResponseChange={setResponse}
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
                  onClick={() => setShowCloseConversationModal(true)}
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
                  disabled={saving || closed || !cancellationCanBeApproved}
                  onClick={() => setDecisionAction("approve_cancellation")}
                />
                <DecisionButton
                  icon={<XCircle className="size-4" />}
                  title="Rechazar cancelación"
                  description="Requiere un motivo"
                  tone="danger"
                  disabled={saving || closed}
                  onClick={() => setDecisionAction("reject_cancellation")}
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
                      disabled={saving}
                      onClick={() => setDecisionAction("approve")}
                    />
                    <DecisionButton
                      icon={<XCircle className="size-4" />}
                      title="El reclamo no corresponde"
                      description="Informar al cliente el motivo del rechazo."
                      tone="danger"
                      disabled={saving}
                      onClick={() => setDecisionAction("reject")}
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
                    onClick={() => void markAcceptedSolutionDone()}
                  />
                )}
                {canCompleteAcceptedSolution && claim.resolution === "cupon_descuento" && canIssueCreditNote && (
                  <DecisionButton
                    icon={<CreditCard className="size-4" />}
                    title="Emitir nota de crédito"
                    description="Generarla por ARCA con el monto cargado."
                    tone="success"
                    disabled={saving || !invoiced}
                    onClick={() => void issueCreditNote()}
                  />
                )}
                {canCompleteAcceptedSolution && claim.resolution === "cupon_descuento" && (
                  <DecisionButton
                    icon={<CreditCard className="size-4" />}
                    title="Nota de crédito emitida"
                    description="Confirmar que el crédito fue generado para el cliente."
                    tone="success"
                    disabled={saving}
                    onClick={() => void markAcceptedSolutionDone()}
                  />
                )}
                {canManageRefund && (
                  <div className="rounded-lg border border-emerald-300/20 bg-emerald-950/20 p-2">
                    <p className="text-xs font-black text-white">Reembolso</p>
                    <div className="mt-2 grid gap-2">
                      <input
                        type="date"
                        value={refundDate}
                        onChange={(event) => setRefundDate(event.target.value)}
                        className={`${adminControlClassName} h-8 min-h-8 px-2 text-xs`}
                        aria-label="Fecha del reintegro"
                      />
                      <input
                        value={refundAmount}
                        onChange={(event) => setRefundAmount(event.target.value)}
                        placeholder="Monto reintegrado"
                        className={`${adminControlClassName} h-8 min-h-8 px-2 text-xs`}
                      />
                      <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-white/10 bg-black/20 px-2 py-1.5 text-10px font-bold text-white/75 hover:border-emerald-300/35">
                        <Upload className="size-3.5" />
                        <span className="truncate">{refundProofFile?.name || refundProof?.file_name || "Subir comprobante"}</span>
                        <input
                          type="file"
                          accept="image/*,application/pdf"
                          className="sr-only"
                          onChange={(event) => setRefundProofFile(event.target.files?.[0] ?? null)}
                        />
                      </label>
                      <button
                        type="button"
                        disabled={saving || !refundProofFile}
                        onClick={() => void uploadRefundProof()}
                        className="admin-ds-button admin-ds-button-secondary h-8 px-3 text-10px font-black disabled:opacity-45"
                      >
                        Subir comprobante
                      </button>
                      {refundProof && (
                        <DecisionButton
                          icon={<CheckCircle2 className="size-4" />}
                          title="Marcar reintegro realizado"
                          description="Confirmar que el dinero fue devuelto al cliente."
                          tone="success"
                          disabled={saving}
                          onClick={() => void markRefundDone()}
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
                    onClick={() => setDecisionAction("close")}
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
                  onClick={() => setShowCloseConversationModal(true)}
                />
              </div>
            )}
          </section>
          )}
        </aside>
      </div>

      {notice && <p className={`mx-3 mb-3 rounded-lg border px-3 py-2 text-xs font-bold text-white sm:mx-4 sm:mb-4 ${ADMIN_SENSITIVE_DANGER.panelSoft}`}>{notice}</p>}

      {previewFile && (
        <FilePreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />
      )}

      {showCloseConversationModal && (
        <CloseConversationModal
          saving={saving}
          onClose={() => {
            if (!saving) setShowCloseConversationModal(false)
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
    </section>
  )
}

function DecisionButton({
  icon,
  title,
  description,
  tone = "secondary",
  disabled = false,
  onClick,
}: {
  icon: ReactNode
  title: string
  description: string
  tone?: "warning" | "success" | "danger" | "primary" | "secondary"
  disabled?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`admin-claim-decision-button is-${tone} rounded-lg border px-2.5 py-1.5 text-left transition disabled:cursor-not-allowed disabled:opacity-45`}
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
