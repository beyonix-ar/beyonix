"use client"

import { useState } from "react"
import { CheckCircle2, Upload } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  getPaymentProofValidationError,
} from "@/lib/payments/transfer"
import type { SupabasePedido } from "@/lib/supabase/types"

interface PaymentProofUploaderProps {
  orderId: number
  initialUploaded?: boolean
  compact?: boolean
  onUploaded?: (order: SupabasePedido) => void
}

export function PaymentProofUploader({
  orderId,
  initialUploaded = false,
  compact = false,
  onUploaded,
}: PaymentProofUploaderProps) {
  const [file, setFile] = useState<File | null>(null)
  const [uploaded, setUploaded] = useState(initialUploaded)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState("")

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const nextFile = event.target.files?.[0] ?? null
    const validationError = getPaymentProofValidationError(nextFile)

    setFile(nextFile)
    setError(validationError)
  }

  const handleUpload = async () => {
    const validationError = getPaymentProofValidationError(file)

    if (validationError || !file) {
      setError(validationError)
      return
    }

    setUploading(true)
    setError("")

    try {
      const formData = new FormData()
      formData.set("orderId", String(orderId))
      formData.set("file", file)

      const response = await fetch("/api/payment-proofs", {
        method: "POST",
        body: formData,
      })
      const data = await response.json()

      if (!response.ok || !data.order) {
        setError(data.error || "No pudimos subir el comprobante.")
        return
      }

      setUploaded(true)
      setFile(null)
      onUploaded?.(data.order as SupabasePedido)
    } catch {
      setError("No pudimos subir el comprobante. Intentá nuevamente.")
    } finally {
      setUploading(false)
    }
  }

  if (uploaded) {
    return (
      <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/10 px-4 py-3 text-sm font-semibold text-emerald-300">
        <CheckCircle2 className="mr-2 inline size-4" />
        Comprobante recibido. Pago en revisión.
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-beyonix-blue-light/18 bg-black p-4">
      <div className={compact ? "space-y-3" : "space-y-4"}>
        <div>
          <label
            htmlFor={`payment-proof-${orderId}`}
            className="block text-11px font-black uppercase tracking-widest text-beyonix-cyan"
          >
            Subir comprobante
          </label>
          <input
            id={`payment-proof-${orderId}`}
            type="file"
            accept=".jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf"
            onChange={handleFileChange}
            className="mt-2 block w-full cursor-pointer rounded-xl border border-beyonix-blue-light bg-beyonix-surface-3 px-3 py-2 text-sm text-white file:mr-3 file:cursor-pointer file:rounded-lg file:border-0 file:bg-beyonix-blue file:px-3 file:py-2 file:text-xs file:font-black file:uppercase file:text-white hover:border-beyonix-sky focus-visible:border-beyonix-focus focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-beyonix-focus"
          />
          <p className="mt-2 text-xs leading-5 text-white/52">
            Formatos permitidos: JPG, PNG, WEBP o PDF. Tamaño máximo: 5 MB.
          </p>
        </div>

        {error && (
          <div className="rounded-xl border border-red-500/20 bg-red-950 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        <Button
          type="button"
          aria-label={`Subir comprobante del pedido ${orderId}`}
          title="Subir comprobante"
          onClick={handleUpload}
          disabled={uploading || Boolean(error) || !file}
          className="w-full cursor-pointer bg-beyonix-blue text-white hover:bg-beyonix-blue-hover disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-white/55"
        >
          <Upload className="mr-2 size-4" />
          {uploading ? "Subiendo..." : "Subir comprobante"}
        </Button>
      </div>
    </div>
  )
}
