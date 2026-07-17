"use client"

import { useEffect, useState } from "react"
import {
  AlertCircle,
  CheckCircle2,
  CloudUpload,
  ExternalLink,
  FileText,
} from "lucide-react"

import {
  PaymentProofActionButton,
  PaymentProofUploader,
} from "@/components/payment-proof-uploader"
import type { SupabasePedido } from "@/lib/supabase/types"

const PAYMENT_STATUS_CONTENT = {
  pendiente_comprobante: {
    title: "Comprobante pendiente",
    description: "Subí el comprobante para que podamos confirmar tu pago.",
    icon: CloudUpload,
    className: "border-beyonix-gray-700 bg-beyonix-gray-900",
    accentClassName: "text-beyonix-status-pending",
  },
  en_revision: {
    title: "Comprobante recibido",
    description: "Recibimos tu comprobante y estamos revisando el pago.",
    icon: CheckCircle2,
    className: "border-beyonix-gray-700 bg-beyonix-gray-900",
    accentClassName: "text-beyonix-status-success",
  },
  confirmado: {
    title: "Pago confirmado",
    description: "Tu pago fue confirmado correctamente.",
    icon: CheckCircle2,
    className: "border-beyonix-gray-700 bg-beyonix-gray-900",
    accentClassName: "text-beyonix-status-success",
  },
  rechazado: {
    title: "Comprobante rechazado",
    description:
      "El comprobante no pudo validarse. Podés subir uno nuevo.",
    icon: AlertCircle,
    className: "border-beyonix-gray-700 bg-beyonix-gray-900",
    accentClassName: "text-beyonix-status-danger",
  },
  vencido_falta_comprobante: {
    title: "Pedido cancelado por falta de pago",
    description: "No se recibió el comprobante dentro del plazo de 48 hs.",
    icon: AlertCircle,
    className: "border-beyonix-gray-700 bg-beyonix-gray-900",
    accentClassName: "text-beyonix-status-danger",
  },
} as const

export function CustomerPaymentProof({
  order,
  onUploaded,
  showHeading = true,
  hideProofWhenConfirmed = false,
  expandUploader = false,
}: {
  order: SupabasePedido
  onUploaded: (updatedOrder: SupabasePedido) => void
  showHeading?: boolean
  hideProofWhenConfirmed?: boolean
  expandUploader?: boolean
}) {
  const hasProof = Boolean(order.payment_proof_url || order.payment_proof_uploaded_at)
  const rawPaymentStatus =
    order.payment_status &&
    order.payment_status in PAYMENT_STATUS_CONTENT
      ? (order.payment_status as keyof typeof PAYMENT_STATUS_CONTENT)
      : "pendiente_comprobante"
  const paymentStatus =
    order.payment_method_id === "transferencia" &&
    rawPaymentStatus === "pendiente_comprobante" &&
    hasProof
      ? "en_revision"
      : rawPaymentStatus
  const status = PAYMENT_STATUS_CONTENT[paymentStatus]
  const StatusIcon = status.icon
  const isConfirmed = paymentStatus === "confirmado"
  const isCanceled = (order.estado ?? "").toLowerCase() === "cancelado"
  const showProof = hasProof && !(hideProofWhenConfirmed && isConfirmed)
  const canReplace = [
    "pendiente_comprobante",
    "en_revision",
    "rechazado",
  ].includes(paymentStatus) && !isCanceled
  const fileName = order.payment_proof_file_name || "Comprobante de pago"
  const isImage = /\.(jpe?g|png|webp)$/i.test(fileName)
  const [signedUrl, setSignedUrl] = useState("")
  const [previewError, setPreviewError] = useState("")
  const compactLayout = !showHeading

  useEffect(() => {
    let active = true

    async function loadSignedUrl() {
      if (!showProof) {
        setSignedUrl("")
        return
      }

      setPreviewError("")

      try {
        const response = await fetch(`/api/payment-proofs/${order.id}`)
        const data = (await response.json()) as {
          signedUrl?: string | null
          error?: string
        }

        if (!response.ok || !data.signedUrl) {
          throw new Error(data.error || "No se pudo abrir el comprobante.")
        }

        if (active) setSignedUrl(data.signedUrl)
      } catch (error) {
        if (active) {
          setPreviewError(
            error instanceof Error
              ? error.message
              : "No se pudo abrir el comprobante.",
          )
        }
      }
    }

    void loadSignedUrl()

    return () => {
      active = false
    }
  }, [order.id, order.payment_proof_uploaded_at, showProof])

  return (
    <div className={expandUploader ? "flex h-full flex-col" : ""}>
      {showHeading && (
        <p className="text-11px font-bold uppercase tracking-widest text-beyonix-gray-500">
          Transferencia bancaria
        </p>
      )}

      <div
        className={`${showHeading ? "mt-3" : ""} rounded-xl border ${compactLayout ? "px-3 py-2" : "px-4 py-3"} ${status.className}`}
      >
        <div className={`flex items-start ${compactLayout ? "gap-2" : "gap-3"}`}>
          <StatusIcon
            className={`mt-0.5 shrink-0 ${status.accentClassName} ${compactLayout ? "size-4" : "size-5"}`}
          />
          <div>
            <p className={`text-sm font-black ${status.accentClassName}`}>
              {status.title}
            </p>
            <p className={`${compactLayout ? "text-xs text-beyonix-gray-300" : "mt-1 text-sm text-beyonix-gray-300"} leading-5`}>
              {status.description}
            </p>
          </div>
        </div>
      </div>

      {showProof && (
        <div className="mt-3 flex flex-col gap-3 rounded-xl border border-beyonix-gray-700 bg-beyonix-gray-900 p-3 sm:flex-row sm:items-center">
          {isImage && signedUrl ? (
            <img
              src={signedUrl}
              alt="Vista previa del comprobante"
              className="h-20 w-24 shrink-0 rounded-lg border border-beyonix-gray-700 bg-beyonix-gray-900 object-cover"
            />
          ) : (
            <div className="flex h-20 w-24 shrink-0 items-center justify-center rounded-lg border border-beyonix-gray-700 bg-beyonix-gray-900 text-white">
              <FileText className="size-7" />
            </div>
          )}

          <div className="min-w-0 flex-1">
            <p className="text-10px font-black uppercase tracking-widest text-beyonix-gray-500">
              Comprobante enviado
            </p>
            <p className="mt-1 truncate text-sm font-semibold text-white">
              {fileName}
            </p>
            {previewError && (
              <p className="mt-1 text-xs text-beyonix-status-danger">{previewError}</p>
            )}
          </div>

          {signedUrl && (
            <a
              href={signedUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 shrink-0 items-center justify-center gap-2 rounded-lg border border-beyonix-blue-500 bg-beyonix-blue-700 px-3 text-xs font-black text-white shadow-md shadow-black/20 transition-colors hover:border-beyonix-blue-300 hover:bg-beyonix-blue-500"
            >
              <ExternalLink className="size-4" />
              Ver comprobante
            </a>
          )}
        </div>
      )}

      {canReplace && hasProof && (
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-beyonix-gray-700 bg-beyonix-gray-900 px-3 py-2">
          <p className="text-xs text-beyonix-gray-300">
            ¿Subiste el archivo equivocado?
          </p>
          <PaymentProofActionButton
            orderId={order.id}
            initialUploaded
            label="Cambiar comprobante"
            onUploaded={onUploaded}
            className="inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-beyonix-blue-500 bg-beyonix-blue-700 px-3 text-xs font-black text-white shadow-md shadow-black/15 transition-colors hover:border-beyonix-blue-300 hover:bg-beyonix-blue-500"
          />
        </div>
      )}

      {canReplace && !hasProof && (
        <div className={`${compactLayout ? "mt-2" : "mt-3"} ${expandUploader ? "flex flex-1 flex-col" : ""}`}>
          <PaymentProofUploader
            orderId={order.id}
            compact
            expand={expandUploader}
            onUploaded={onUploaded}
          />
        </div>
      )}
    </div>
  )
}
