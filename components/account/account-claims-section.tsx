"use client"

import { useEffect, useState } from "react"
import { Camera, Download, FileText, Paperclip, Send } from "lucide-react"

import {
  getClaimDeadline,
  getClaimFileValidationError,
  getOrderClaimResolutionLabel,
  getOrderClaimStatusLabel,
  getOrderClaimTypeLabel,
  isClaimWindowOpen,
} from "@/lib/order-claims"
import {
  formatCuentaOrderDate,
  formatPublicOrderId,
} from "@/lib/account/account-formatters"
import type {
  OrderClaimType,
  SupabaseOrderClaim,
  SupabaseOrderClaimFile,
  SupabaseOrderClaimMessage,
  SupabasePedido,
} from "@/lib/supabase/types"
function formatClaimDeadline(value: Date) {
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(value)
}

function formatClaimActivityDate(value: string) {
  return new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date(value))
}

function getClaimTitle(claim: SupabaseOrderClaim) {
  if (claim.claim_type === "transporte_48hs") return "Reclamo por entrega"
  if (claim.claim_type === "garantia_beyonix") return "Garantía del producto"
  return getOrderClaimTypeLabel(claim.claim_type)
}

function getClaimReasonLabel(claim: SupabaseOrderClaim) {
  const labels: Record<string, string> = {
    danado: "Llegó dañado",
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
    otro: "Otro problema",
  }

  return labels[claim.failure_type ?? ""] ?? claim.failure_type ?? getClaimTitle(claim)
}

function getClaimStatusBadge(status: SupabaseOrderClaim["status"]) {
  const styles: Record<SupabaseOrderClaim["status"], string> = {
    recibido: "border-sky-300/35 bg-[#112A43] text-white",
    en_revision: "border-amber-300/40 bg-amber-400/12 text-white",
    falta_informacion: "border-beyonix-blue-light/45 bg-[#112A43] text-white",
    aprobado: "border-emerald-300/35 bg-emerald-400/12 text-white",
    reintegro_pendiente: "border-[#77E6E2]/35 bg-[#77E6E2]/10 text-white",
    cambio_pendiente: "border-[#77E6E2]/35 bg-[#77E6E2]/10 text-white",
    cupon_pendiente: "border-[#77E6E2]/35 bg-[#77E6E2]/10 text-white",
    reemplazo_enviado: "border-blue-300/35 bg-[#112A43] text-white",
    rechazado: "border-red-300/35 bg-red-500/12 text-white",
    cerrado: "border-emerald-300/35 bg-emerald-500/12 text-white",
  }

  return styles[status] ?? "border-white/10 bg-[#181818] text-white"
}

function getClaimStatusText(status: SupabaseOrderClaim["status"]) {
  if (status === "falta_informacion") return "Esperando respuesta del cliente"
  if (status === "reintegro_pendiente") return "Reintegro pendiente"
  if (status === "cambio_pendiente") return "Solución en proceso"
  if (status === "cupon_pendiente") return "Cupón pendiente"
  if (status === "reemplazo_enviado") return "Solución en proceso"
  if (status === "aprobado") return "Solución en proceso"
  if (status === "cerrado") return "Resuelto"
  return getOrderClaimStatusLabel(status)
}

function getClaimOrderProduct(order: SupabasePedido) {
  const items = order.orden_items ?? []

  if (!items.length) return "No informado"
  if (items.length === 1) {
    return items[0].productos?.nombre ?? `Producto #${items[0].producto_id}`
  }

  const firstName = items[0].productos?.nombre ?? `Producto #${items[0].producto_id}`
  return `${firstName} + ${items.length - 1} más`
}

function getClaimInitialFiles(claim: SupabaseOrderClaim) {
  const firstCustomerMessage = (claim.order_claim_messages ?? [])
    .filter((message) => message.author_role === "cliente")
    .sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    )[0]

  if (!firstCustomerMessage) return claim.order_claim_files ?? []

  return (claim.order_claim_files ?? []).filter(
    (file) =>
      new Date(file.created_at).getTime() <=
      new Date(firstCustomerMessage.created_at).getTime() + 60_000,
  )
}

function getCustomerClaimMessageText(message: string) {
  const match = message.match(/^Producto afectado:\s*.+?(?:\r?\n){2}([\s\S]*)$/)
  return match?.[1]?.trim() || message
}

function getReplyFilesList(files: Record<string, File[]>) {
  return Object.values(files).flat()
}

function ClaimAttachmentChip({
  file,
}: {
  file: SupabaseOrderClaimFile
}) {
  const isImage = file.mime_type?.startsWith("image/")
  const isVideo = file.mime_type?.startsWith("video/")

  return (
    <a
      href={file.signedUrl ?? undefined}
      target="_blank"
      rel="noreferrer"
      className="group inline-flex max-w-full items-center gap-2 rounded-xl border border-beyonix-blue-light/25 bg-black px-2.5 py-2 text-xs font-bold text-white transition-colors hover:border-beyonix-blue-light hover:bg-[#112A43]"
    >
      {isImage && file.signedUrl ? (
        <span
          className="size-8 shrink-0 rounded-lg border border-white/10 bg-cover bg-center"
          style={{ backgroundImage: `url(${file.signedUrl})` }}
        />
      ) : isVideo ? (
        <Camera className="size-4 shrink-0 text-beyonix-sky" />
      ) : (
        <FileText className="size-4 shrink-0 text-beyonix-sky" />
      )}
      <span className="min-w-0 truncate">{file.file_name}</span>
      <Download className="size-3.5 shrink-0 text-white/70 group-hover:text-white" />
    </a>
  )
}

function ClaimFilePicker({
  label,
  role,
  accept,
  required,
  onFiles,
}: {
  label: string
  role: string
  accept: string
  required?: boolean
  onFiles: (role: string, files: File[]) => void | Promise<void>
}) {
  return (
    <label className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl border border-beyonix-blue-light/35 bg-[#181818] px-3 text-xs font-black uppercase tracking-wide text-white transition-colors hover:border-beyonix-blue-light hover:bg-[#112A43]">
      <Paperclip className="size-4 text-beyonix-sky" />
      {label}
      {required ? "*" : ""}
      <input
        type="file"
        accept={accept}
        multiple={!accept.includes("video")}
        onChange={(event) =>
          onFiles(role, Array.from(event.target.files ?? []))
        }
        className="sr-only"
      />
    </label>
  )
}

function ClaimFileInput({
  label,
  role,
  accept,
  required,
  onFiles,
}: {
  label: string
  role: string
  accept: string
  required?: boolean
  onFiles: (role: string, files: File[]) => void | Promise<void>
}) {
  return (
    <label className="block rounded-xl border border-white/8 bg-[#111111] p-3 transition-colors hover:bg-[#141414]">
      <span className="text-10px font-black uppercase tracking-widest text-white/45">
        {label} {required ? "*" : ""}
      </span>
      <input
        type="file"
        accept={accept}
        multiple={!accept.includes("video")}
        onChange={(event) =>
          onFiles(role, Array.from(event.target.files ?? []))
        }
        className="mt-2 block w-full cursor-pointer text-xs font-semibold text-white/65 file:mr-3 file:cursor-pointer file:rounded-lg file:border-0 file:bg-beyonix-blue file:px-3 file:py-2 file:text-xs file:font-black file:uppercase file:tracking-wide file:text-beyonix-sky"
      />
    </label>
  )
}

function ClaimHeaderCard({
  claim,
  order,
  deliveredAt,
}: {
  claim: SupabaseOrderClaim
  order: SupabasePedido
  deliveredAt: string
}) {
  const isTransportClaim = claim.claim_type === "transporte_48hs"

  return (
    <div className="rounded-2xl border border-white/8 bg-[#141414] p-4">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="min-w-0">
          <p className="text-11px font-black uppercase tracking-widest text-beyonix-cyan">
            Centro de reclamos
          </p>
          <h3 className="mt-2 text-2xl font-black text-white">
            Seguimiento del reclamo
          </h3>
          <div className="mt-3 flex flex-wrap gap-2">
            <span className={`rounded-full border px-3 py-1 text-10px font-black uppercase tracking-wide ${getClaimStatusBadge(claim.status)}`}>
              {getClaimStatusText(claim.status)}
            </span>
            <span className="rounded-full border border-white/8 bg-[#181818] px-3 py-1 text-10px font-black uppercase tracking-wide text-white">
              Pedido #{formatPublicOrderId(order.id)}
            </span>
            <span className="rounded-full border border-beyonix-blue-light/25 bg-[#181818] px-3 py-1 text-10px font-black uppercase tracking-wide text-white">
              {getClaimReasonLabel(claim)}
            </span>
          </div>
        </div>
        <div className="grid gap-2 text-sm font-bold text-white sm:grid-cols-2 xl:min-w-[25rem]">
          <div className="rounded-xl border border-white/8 bg-[#181818] p-3">
            <p className="text-10px font-black uppercase tracking-widest text-white/55">
              Producto
            </p>
            <p className="mt-1 truncate text-white">
              {getClaimOrderProduct(order)}
            </p>
          </div>
          <div className="rounded-xl border border-white/8 bg-[#181818] p-3">
            <p className="text-10px font-black uppercase tracking-widest text-white/55">
              Tiempo estimado
            </p>
            <p className="mt-1 text-white">
              {isTransportClaim
                ? "Respuesta antes de 48hs hábiles"
                : `Garantía hasta ${formatClaimDeadline(
                    getClaimDeadline(deliveredAt, "garantia_beyonix"),
                  )}`}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

function ClaimSummaryCard({
  claim,
}: {
  claim: SupabaseOrderClaim
}) {
  const initialFiles = getClaimInitialFiles(claim)

  return (
    <aside className="space-y-3">
      <div className="rounded-2xl border border-white/8 bg-[#141414] p-4">
        <p className="text-11px font-black uppercase tracking-widest text-beyonix-cyan">
          Resumen del problema
        </p>
        <h4 className="mt-3 text-lg font-black text-white">
          Problema informado
        </h4>
        <p className="mt-2 text-sm font-semibold leading-6 text-white">
          {claim.description}
        </p>
        {claim.failure_type && (
          <div className="mt-3 rounded-xl border border-white/8 bg-[#181818] p-3">
            <p className="text-10px font-black uppercase tracking-widest text-white/55">
              Tipo de falla
            </p>
            <p className="mt-1 text-sm font-bold text-white">
              {claim.failure_type}
            </p>
          </div>
        )}
        {claim.started_at && (
          <div className="mt-3 rounded-xl border border-white/8 bg-[#181818] p-3">
            <p className="text-10px font-black uppercase tracking-widest text-white/55">
              Inicio informado
            </p>
            <p className="mt-1 text-sm font-bold text-white">
              {claim.started_at}
            </p>
          </div>
        )}
        {initialFiles.length > 0 && (
          <div className="mt-4">
            <p className="mb-2 text-10px font-black uppercase tracking-widest text-white/55">
              Evidencia inicial
            </p>
            <div className="grid gap-2">
              {initialFiles.map((file) => (
                <ClaimAttachmentChip key={file.id} file={file} />
              ))}
            </div>
          </div>
        )}
      </div>
      {(claim.offered_resolutions ?? []).length > 0 && (
        <div className="rounded-2xl border border-white/8 bg-[#141414] p-4">
          <p className="text-11px font-black uppercase tracking-widest text-beyonix-cyan">
            Solución
          </p>
          {claim.customer_selected_resolution ? (
            <p className="mt-3 text-sm font-semibold leading-6 text-white">
              Elegiste{" "}
              <span className="font-black">
                {getOrderClaimResolutionLabel(
                  claim.customer_selected_resolution,
                )}
              </span>
              . BEYONIX continuará la gestión desde el chat.
            </p>
          ) : (
            <p className="mt-3 text-sm font-semibold leading-6 text-white">
              BEYONIX te ofreció opciones de solución. Elegí una desde el chat
              para continuar.
            </p>
          )}
        </div>
      )}
    </aside>
  )
}

function ClaimMessageBubble({
  message,
}: {
  message: SupabaseOrderClaimMessage
}) {
  const isCustomer = message.author_role === "cliente"

  return (
    <div className={`flex ${isCustomer ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[min(42rem,92%)] rounded-2xl border px-4 py-3 ${
          isCustomer
            ? "border-beyonix-blue-light/35 bg-[#112A43] text-white"
            : "border-beyonix-blue-light/20 bg-[#181818] text-white"
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-10px font-black uppercase tracking-widest text-white">
            {isCustomer ? "Vos" : "BEYONIX"}
          </p>
          <p className="text-10px font-semibold text-white/70">
            {formatCuentaOrderDate(message.created_at)}
          </p>
        </div>
        <p className="mt-2 whitespace-pre-wrap text-sm font-semibold leading-6 text-white">
          {getCustomerClaimMessageText(message.message)}
        </p>
      </div>
    </div>
  )
}

function ClaimChat({
  claim,
  onChooseResolution,
  loading,
}: {
  claim: SupabaseOrderClaim
  onChooseResolution: (claim: SupabaseOrderClaim, resolution: string) => void
  loading: boolean
}) {
  const messages = [...(claim.order_claim_messages ?? [])].sort(
    (a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  )

  return (
    <div className="rounded-2xl border border-white/8 bg-[#141414] p-4">
      <div className="flex items-center justify-between gap-3 border-b border-white/8 pb-3">
        <div>
          <p className="text-11px font-black uppercase tracking-widest text-beyonix-cyan">
            Chat de soporte
          </p>
          <h4 className="mt-1 text-lg font-black text-white">
            Conversación con BEYONIX
          </h4>
        </div>
        <span className="rounded-full border border-beyonix-blue-light/25 bg-[#181818] px-3 py-1 text-10px font-black uppercase tracking-wide text-white">
          {messages.length} mensajes
        </span>
      </div>
      <div className="mt-4 space-y-3">
        {messages.length ? (
          messages.map((message) => (
            <ClaimMessageBubble key={message.id} message={message} />
          ))
        ) : (
          <div className="rounded-2xl border border-white/8 bg-[#181818] p-4 text-sm font-semibold text-white">
            Todavía no hay mensajes en este reclamo.
          </div>
        )}
      </div>
      {(claim.offered_resolutions ?? []).length > 0 &&
        !claim.customer_selected_resolution && (
          <div className="mt-4 rounded-2xl border border-beyonix-blue-light/20 bg-[#181818] p-3">
            <p className="text-11px font-black uppercase tracking-widest text-beyonix-cyan">
              Soluciones disponibles
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {(claim.offered_resolutions ?? []).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => onChooseResolution(claim, item)}
                  disabled={loading}
                  className="min-h-10 cursor-pointer rounded-xl border border-beyonix-blue-light/30 bg-[#112A43] px-3 py-2 text-left text-xs font-black uppercase tracking-wide text-white transition-colors hover:border-beyonix-blue-light hover:bg-beyonix-blue-hover disabled:cursor-wait disabled:opacity-50"
                >
                  {getOrderClaimResolutionLabel(item)}
                </button>
              ))}
            </div>
          </div>
        )}
    </div>
  )
}

function ClaimReplyBox({
  reply,
  replyFiles,
  loading,
  error,
  onReplyChange,
  onFiles,
  onSubmit,
}: {
  reply: string
  replyFiles: Record<string, File[]>
  loading: boolean
  error: string
  onReplyChange: (value: string) => void
  onFiles: (role: string, files: File[]) => void | Promise<void>
  onSubmit: () => void
}) {
  const files = getReplyFilesList(replyFiles)

  return (
    <div className="rounded-2xl border border-white/8 bg-[#141414] p-4">
      <p className="text-11px font-black uppercase tracking-widest text-beyonix-cyan">
        Responder
      </p>
      <textarea
        value={reply}
        onChange={(event) => onReplyChange(event.target.value)}
        rows={4}
        placeholder="Escribí tu mensaje..."
        className="mt-3 w-full resize-none rounded-2xl border border-beyonix-blue-light/25 bg-[#181818] px-4 py-3 text-sm font-semibold leading-6 text-white outline-none placeholder:text-white/55 focus:border-beyonix-blue-light"
      />
      {files.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {files.map((file) => (
            <span
              key={`${file.name}-${file.size}`}
              className="inline-flex max-w-56 items-center gap-2 rounded-xl border border-beyonix-blue-light/25 bg-[#181818] px-3 py-2 text-xs font-bold text-white"
            >
              <FileText className="size-4 shrink-0 text-beyonix-sky" />
              <span className="truncate">{file.name}</span>
            </span>
          ))}
        </div>
      )}
      {error && (
        <p className="mt-3 rounded-xl border border-red-300/25 bg-red-500/10 px-3 py-2 text-xs font-bold text-white">
          {error}
        </p>
      )}
      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <ClaimFilePicker
          label="Adjuntar archivo"
          role="evidencia_adicional"
          accept="image/*,video/*"
          onFiles={onFiles}
        />
        <button
          type="button"
          onClick={onSubmit}
          disabled={loading}
          className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl border border-beyonix-blue-light/45 bg-[#112A43] px-5 text-xs font-black uppercase tracking-wide text-white transition-colors hover:border-beyonix-blue-light hover:bg-beyonix-blue-hover disabled:cursor-wait disabled:opacity-50"
        >
          <Send className="size-4" />
          {loading ? "Enviando..." : "Enviar respuesta"}
        </button>
      </div>
    </div>
  )
}

function ClaimActivityTimeline({ claim }: { claim: SupabaseOrderClaim }) {
  const sortedMessages = [...(claim.order_claim_messages ?? [])].sort(
    (a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  )
  const events = [
    {
      at: claim.created_at,
      label: "Reclamo creado",
    },
    ...sortedMessages
      .slice(1)
      .map((message) => ({
        at: message.created_at,
        label:
          message.author_role === "cliente"
            ? "Cliente respondió"
            : "BEYONIX respondió",
      })),
    ...(claim.order_claim_files ?? [])
      .filter(
        (file) =>
          new Date(file.created_at).getTime() >
          new Date(claim.created_at).getTime() + 60_000,
      )
      .map((file) => ({
        at: file.created_at,
        label: `Archivo agregado: ${file.file_name}`,
      })),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())

  if (events.length <= 1) return null

  return (
    <div className="rounded-2xl border border-white/8 bg-[#141414] p-4">
      <p className="text-11px font-black uppercase tracking-widest text-beyonix-cyan">
        Actividad del reclamo
      </p>
      <div className="mt-3 space-y-2">
        {events.map((event, index) => (
          <div
            key={`${event.at}-${index}`}
            className="flex gap-3 text-xs font-semibold leading-5 text-white"
          >
            <span className="mt-1 size-2 shrink-0 rounded-full bg-beyonix-sky" />
            <p className="min-w-0">
              <span className="text-white/70">
                {formatClaimActivityDate(event.at)}
              </span>{" "}
              — {event.label}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}

export function ClaimsCenterPanel({ order }: { order: SupabasePedido }) {
  const deliveredAt = order.delivered_at || order.created_at
  const [claims, setClaims] = useState<SupabaseOrderClaim[]>(
    order.order_claims ?? [],
  )
  const [selectedType, setSelectedType] =
    useState<OrderClaimType>("transporte_48hs")
  const [description, setDescription] = useState("")
  const [failureType, setFailureType] = useState("")
  const [startedAt, setStartedAt] = useState("")
  const [fileMap, setFileMap] = useState<Record<string, File[]>>({})
  const [checks, setChecks] = useState({
    realInfo: false,
    keptPackaging: false,
    noMisuse: false,
  })
  const [reply, setReply] = useState("")
  const [replyFiles, setReplyFiles] = useState<Record<string, File[]>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const transportOpen = isClaimWindowOpen(deliveredAt, "transporte_48hs")
  const warrantyOpen = isClaimWindowOpen(deliveredAt, "garantia_beyonix")
  const activeClaim = claims.find((claim) =>
    ["recibido", "en_revision", "falta_informacion", "aprobado"].includes(
      claim.status,
    ),
  )
  const displayedClaim = activeClaim ?? claims[0]

  useEffect(() => {
    let active = true

    async function loadClaims() {
      const response = await fetch(`/api/orders/${order.id}/claims`)
      const data = (await response.json()) as {
        claims?: SupabaseOrderClaim[]
      }

      if (active && response.ok) {
        setClaims(data.claims ?? [])
      }
    }

    void loadClaims()
    return () => {
      active = false
    }
  }, [order.id])

  const validateEvidenceFiles = async (files: File[]) => {
    const sizeOrTypeError = files
      .map((file) => getClaimFileValidationError(file))
      .find(Boolean)

    if (sizeOrTypeError) return sizeOrTypeError

    for (const file of files) {
      if (!file.type.startsWith("video/")) continue

      const duration = await new Promise<number>((resolve) => {
        const video = document.createElement("video")
        const url = URL.createObjectURL(file)

        video.preload = "metadata"
        video.onloadedmetadata = () => {
          URL.revokeObjectURL(url)
          resolve(video.duration)
        }
        video.onerror = () => {
          URL.revokeObjectURL(url)
          resolve(Number.POSITIVE_INFINITY)
        }
        video.src = url
      })

      if (!Number.isFinite(duration) || duration > 30) {
        return "El video debe durar como máximo 30 segundos."
      }
    }

    return ""
  }

  const setFiles = async (role: string, files: File[]) => {
    setError("")
    const validationError = await validateEvidenceFiles(files)

    if (validationError) {
      setError(validationError)
      return
    }

    setFileMap((current) => ({ ...current, [role]: files }))
  }

  const setExtraFiles = async (role: string, files: File[]) => {
    setError("")
    const validationError = await validateEvidenceFiles(files)

    if (validationError) {
      setError(validationError)
      return
    }

    setReplyFiles((current) => ({ ...current, [role]: files }))
  }

  const appendFiles = (formData: FormData, source: Record<string, File[]>) => {
    Object.entries(source).forEach(([role, files]) => {
      files.forEach((file) => {
        formData.append("files", file)
        formData.append("fileRoles", role)
      })
    })
  }

  const submitClaim = async () => {
    setLoading(true)
    setError("")

    try {
      const formData = new FormData()
      formData.set("claimType", selectedType)
      formData.set("description", description)
      formData.set("failureType", failureType)
      formData.set("startedAt", startedAt)
      formData.set("confirm_real_info", String(checks.realInfo))
      formData.set("confirm_kept_packaging", String(checks.keptPackaging))
      formData.set("confirm_no_misuse", String(checks.noMisuse))
      appendFiles(formData, fileMap)

      const response = await fetch(`/api/orders/${order.id}/claims`, {
        method: "POST",
        body: formData,
      })
      const data = (await response.json()) as {
        claim?: SupabaseOrderClaim
        error?: string
      }

      if (!response.ok || !data.claim) {
        setError(data.error || "No se pudo enviar el reclamo.")
        return
      }

      setClaims((current) => [data.claim as SupabaseOrderClaim, ...current])
      setDescription("")
      setFailureType("")
      setStartedAt("")
      setFileMap({})
    } catch {
      setError("No se pudo enviar el reclamo.")
    } finally {
      setLoading(false)
    }
  }

  const submitExtraInfo = async (claim: SupabaseOrderClaim) => {
    setLoading(true)
    setError("")

    try {
      const formData = new FormData()
      formData.set("claimId", String(claim.id))
      formData.set("message", reply)
      appendFiles(formData, replyFiles)

      const response = await fetch(`/api/orders/${order.id}/claims`, {
        method: "POST",
        body: formData,
      })
      const data = (await response.json()) as {
        claim?: SupabaseOrderClaim
        error?: string
      }

      if (!response.ok || !data.claim) {
        setError(data.error || "No se pudo agregar información.")
        return
      }

      setClaims((current) =>
        current.map((currentClaim) =>
          currentClaim.id === data.claim?.id ? data.claim : currentClaim,
        ),
      )
      setReply("")
      setReplyFiles({})
    } catch {
      setError("No se pudo agregar información.")
    } finally {
      setLoading(false)
    }
  }

  const submitResolutionChoice = async (
    claim: SupabaseOrderClaim,
    selectedResolution: string,
  ) => {
    setLoading(true)
    setError("")

    try {
      const response = await fetch(`/api/orders/${order.id}/claims`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          claimId: claim.id,
          selectedResolution,
        }),
      })
      const data = (await response.json()) as {
        claim?: SupabaseOrderClaim
        error?: string
      }

      if (!response.ok || !data.claim) {
        setError(data.error || "No se pudo guardar la solución elegida.")
        return
      }

      setClaims((current) =>
        current.map((currentClaim) =>
          currentClaim.id === data.claim?.id ? data.claim : currentClaim,
        ),
      )
    } catch {
      setError("No se pudo guardar la solución elegida.")
    } finally {
      setLoading(false)
    }
  }

  if (displayedClaim) {
    const conversationOpen = Boolean(activeClaim)

    return (
      <section className="mb-4 space-y-4 rounded-2xl border border-beyonix-blue-light/20 bg-black p-4">
        <ClaimHeaderCard
          claim={displayedClaim}
          order={order}
          deliveredAt={deliveredAt}
        />
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,0.36fr)]">
          <div className="min-w-0 space-y-4">
            <ClaimChat
              claim={displayedClaim}
              loading={loading}
              onChooseResolution={(claim, resolution) =>
                void submitResolutionChoice(claim, resolution)
              }
            />
            {conversationOpen ? (
              <ClaimReplyBox
                reply={reply}
                replyFiles={replyFiles}
                loading={loading}
                error={error}
                onReplyChange={setReply}
                onFiles={setExtraFiles}
                onSubmit={() => void submitExtraInfo(displayedClaim)}
              />
            ) : (
              <div className="rounded-2xl border border-white/8 bg-[#141414] p-4 text-sm font-semibold leading-6 text-white">
                Este reclamo está finalizado. La conversación permanece
                disponible como referencia.
              </div>
            )}
          </div>
          <div className="min-w-0 space-y-4">
            <ClaimSummaryCard claim={displayedClaim} />
            <ClaimActivityTimeline claim={displayedClaim} />
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="mb-4 rounded-2xl border border-beyonix-blue-light/20 bg-black p-4">
      <div className="rounded-2xl border border-white/8 bg-[#141414] p-4">
        <p className="text-11px font-black uppercase tracking-widest text-beyonix-cyan">
          Centro de reclamos
        </p>
        <h3 className="mt-2 text-2xl font-black text-white">
          Solicitar revisión
        </h3>
        <p className="mt-2 max-w-3xl text-sm font-semibold leading-6 text-white">
          Elegí el motivo correcto para que podamos revisar la evidencia y darte
          una respuesta desde este mismo pedido.
        </p>
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <button
            type="button"
            onClick={() => setSelectedType("transporte_48hs")}
            disabled={!transportOpen}
            className={`rounded-2xl border p-4 text-left transition-colors ${
              selectedType === "transporte_48hs"
                ? "border-beyonix-blue-light/45 bg-[#112A43]"
                : "border-white/8 bg-[#181818] hover:border-beyonix-blue-light/25"
            } disabled:cursor-not-allowed disabled:opacity-50`}
          >
            <p className="text-base font-black text-white">
              Mi producto llegó dañado
            </p>
            <p className="mt-2 text-sm font-semibold leading-6 text-white">
              Si el paquete llegó golpeado, abierto o el producto sufrió daños
              durante el envío, cargá la evidencia para iniciar la revisión.
            </p>
            <p className="mt-3 text-11px font-black uppercase tracking-wide text-white">
              Límite: {formatClaimDeadline(getClaimDeadline(deliveredAt, "transporte_48hs"))}
            </p>
          </button>
          <button
            type="button"
            onClick={() => setSelectedType("garantia_beyonix")}
            disabled={!warrantyOpen}
            className={`rounded-2xl border p-4 text-left transition-colors ${
              selectedType === "garantia_beyonix"
                ? "border-beyonix-blue-light/45 bg-[#112A43]"
                : "border-white/8 bg-[#181818] hover:border-beyonix-blue-light/25"
            } disabled:cursor-not-allowed disabled:opacity-50`}
          >
            <p className="text-base font-black text-white">
              Solicitar garantía BEYONIX
            </p>
            <p className="mt-2 text-sm font-semibold leading-6 text-white">
              Si el producto presenta una falla de funcionamiento, nuestro
              equipo revisará el caso y te ofrecerá una solución.
            </p>
            <p className="mt-3 text-11px font-black uppercase tracking-wide text-white">
              Límite: {formatClaimDeadline(getClaimDeadline(deliveredAt, "garantia_beyonix"))}
            </p>
          </button>
        </div>
      </div>

      {!transportOpen && (
        <p className="mt-4 rounded-xl border border-amber-300/25 bg-amber-400/10 px-3 py-2 text-xs font-semibold leading-5 text-white">
          El plazo de reclamo por transporte ya finalizó. Si el producto
          presenta una falla, podés solicitar garantía BEYONIX.
        </p>
      )}

      {warrantyOpen ? (
        <div className="mt-4 space-y-3 rounded-2xl border border-white/8 bg-[#141414] p-4">
          {selectedType === "garantia_beyonix" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <input
                value={failureType}
                onChange={(event) => setFailureType(event.target.value)}
                placeholder="Tipo de falla"
                className="h-11 rounded-xl border border-beyonix-blue-light/25 bg-[#181818] px-3 text-sm font-semibold text-white outline-none placeholder:text-white/55"
              />
              <input
                value={startedAt}
                onChange={(event) => setStartedAt(event.target.value)}
                placeholder="Cuándo empezó la falla"
                className="h-11 rounded-xl border border-beyonix-blue-light/25 bg-[#181818] px-3 text-sm font-semibold text-white outline-none placeholder:text-white/55"
              />
            </div>
          )}
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={4}
            placeholder="Describí brevemente qué pasó."
            className="w-full resize-none rounded-xl border border-beyonix-blue-light/25 bg-[#181818] px-3 py-3 text-sm font-semibold text-white outline-none placeholder:text-white/55 focus:border-beyonix-blue-light"
          />

          {selectedType === "transporte_48hs" ? (
            <div className="grid gap-3 lg:grid-cols-3">
              <ClaimFileInput label="Foto del embalaje exterior" role="embalaje_exterior" accept="image/*" required onFiles={setFiles} />
              <ClaimFileInput label="Foto del producto completo" role="producto_completo" accept="image/*" required onFiles={setFiles} />
              <ClaimFileInput label="Foto del daño" role="danio" accept="image/*" required onFiles={setFiles} />
              <ClaimFileInput label="Video opcional (máximo 30 segundos)" role="video" accept="video/*" onFiles={setFiles} />
            </div>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              <ClaimFileInput label="Fotos de referencia" role="funcionamiento_foto" accept="image/*" onFiles={setFiles} />
              <ClaimFileInput label="Video de funcionamiento (máximo 30 segundos)" role="video" accept="video/*" required onFiles={setFiles} />
            </div>
          )}

          <div className="space-y-2 rounded-xl border border-white/8 bg-[#181818] p-3">
            {[
              ["realInfo", "Confirmo que la información enviada es real y corresponde al producto recibido."],
              ["keptPackaging", "Confirmo que conservé el embalaje, accesorios y comprobantes disponibles."],
              ["noMisuse", "Confirmo que el producto no sufrió golpes, agua, manipulación indebida o mal uso."],
            ].map(([key, label]) => (
              <label key={key} className="flex gap-2 text-xs font-semibold leading-5 text-white">
                <input
                  type="checkbox"
                  checked={checks[key as keyof typeof checks]}
                  onChange={(event) =>
                    setChecks((current) => ({
                      ...current,
                      [key]: event.target.checked,
                    }))
                  }
                  className="mt-1 size-4 accent-[#112A43]"
                />
                {label}
              </label>
            ))}
          </div>

          {error && (
            <p className="rounded-xl border border-red-300/25 bg-red-500/10 px-3 py-2 text-xs font-semibold text-white">
              {error}
            </p>
          )}
          <button
            type="button"
            onClick={() => void submitClaim()}
            disabled={loading}
            className="inline-flex h-10 cursor-pointer items-center justify-center rounded-xl border border-beyonix-blue-light/45 bg-[#112A43] px-4 text-11px font-black uppercase tracking-wide text-white transition-colors hover:border-beyonix-blue-light hover:bg-beyonix-blue-hover disabled:cursor-wait disabled:opacity-50"
          >
            {loading ? "Enviando..." : "Enviar solicitud"}
          </button>
        </div>
      ) : null}
    </section>
  )
}
