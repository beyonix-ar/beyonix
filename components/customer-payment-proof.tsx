"use client"

import { useEffect, useState } from "react"
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
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
    description: "Subí el comprobante para validar tu pago.",
    icon: Clock3,
    className: "border-amber-300/15 bg-amber-300/[0.06] text-amber-100",
  },
  en_revision: {
    title: "Pago en revisión",
    description: "Recibimos tu comprobante correctamente.",
    icon: Clock3,
    className: "border-amber-300/15 bg-amber-300/[0.06] text-amber-100",
  },
  confirmado: {
    title: "Pago confirmado",
    description: "Tu comprobante ya fue validado.",
    icon: CheckCircle2,
    className: "border-emerald-400/20 bg-emerald-400/8 text-emerald-200",
  },
  rechazado: {
    title: "Comprobante rechazado",
    description:
      "El comprobante no pudo validarse. Puedes subir uno nuevo.",
    icon: AlertCircle,
    className: "border-red-400/20 bg-red-400/8 text-red-200",
  },
} as const

export function CustomerPaymentProof({
  order,
  onUploaded,
  showHeading = true,
  hideProofWhenConfirmed = false,
}: {
  order: SupabasePedido
  onUploaded: (updatedOrder: SupabasePedido) => void
  showHeading?: boolean
  hideProofWhenConfirmed?: boolean
}) {
  const paymentStatus =
    order.payment_status &&
    order.payment_status in PAYMENT_STATUS_CONTENT
      ? (order.payment_status as keyof typeof PAYMENT_STATUS_CONTENT)
      : "pendiente_comprobante"
  const status = PAYMENT_STATUS_CONTENT[paymentStatus]
  const StatusIcon = status.icon
  const hasProof = Boolean(order.payment_proof_url)
  const isConfirmed = paymentStatus === "confirmado"
  const showProof = hasProof && !(hideProofWhenConfirmed && isConfirmed)
  const canReplace = [
    "pendiente_comprobante",
    "en_revision",
    "rechazado",
  ].includes(paymentStatus)
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
    <div>
      {showHeading && (
        <p className="text-11px font-bold uppercase tracking-widest text-white/55">
          Transferencia bancaria
        </p>
      )}

      <div
        className={`${showHeading ? "mt-3" : ""} rounded-xl border ${compactLayout ? "px-3 py-2.5" : "px-4 py-3"} ${status.className}`}
      >
        <div className={`flex items-start ${compactLayout ? "gap-2.5" : "gap-3"}`}>
          <StatusIcon className={`mt-0.5 shrink-0 ${compactLayout ? "size-4" : "size-5"}`} />
          <div>
            <p className="text-sm font-black">{status.title}</p>
            <p className={`${compactLayout ? "mt-0.5 text-xs text-[#C8C8C8]" : "mt-1 text-sm text-white/65"} leading-5`}>
              {status.description}
            </p>
          </div>
        </div>
      </div>

      {showProof && (
        <div className="mt-3 flex flex-col gap-3 rounded-xl border border-[#303846] bg-[#1B2028] p-3 sm:flex-row sm:items-center">
          {isImage && signedUrl ? (
            <img
              src={signedUrl}
              alt="Vista previa del comprobante"
              className="h-20 w-24 shrink-0 rounded-lg border border-white/10 bg-black object-cover"
            />
          ) : (
            <div className="flex h-20 w-24 shrink-0 items-center justify-center rounded-lg border border-[#112A43] bg-[#112A43]/30 text-white">
              <FileText className="size-7" />
            </div>
          )}

          <div className="min-w-0 flex-1">
            <p className="text-10px font-black uppercase tracking-widest text-white/40">
              Comprobante enviado
            </p>
            <p className="mt-1 truncate text-sm font-semibold text-white">
              {fileName}
            </p>
            {previewError && (
              <p className="mt-1 text-xs text-red-300">{previewError}</p>
            )}
          </div>

          {signedUrl && (
            <a
              href={signedUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-xl border border-[#112A43] bg-[#112A43] px-4 text-xs font-black text-white transition-colors hover:bg-[#183B5E]"
            >
              <ExternalLink className="size-4" />
              Ver comprobante
            </a>
          )}
        </div>
      )}

      {canReplace && hasProof && (
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#303846] bg-[#1B2028] px-3 py-2">
          <p className="text-xs text-[#C8C8C8]">
            ¿Subiste el archivo equivocado?
          </p>
          <PaymentProofActionButton
            orderId={order.id}
            initialUploaded
            label="Cambiar comprobante"
            onUploaded={onUploaded}
            className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-semibold text-beyonix-sky transition-colors hover:text-white"
          />
        </div>
      )}

      {canReplace && !hasProof && (
        <div className={compactLayout ? "mt-2.5" : "mt-3"}>
          <PaymentProofUploader
            orderId={order.id}
            compact
            onUploaded={onUploaded}
          />
        </div>
      )}
    </div>
  )
}
