"use client"

import { useRef, useState } from "react"
import {
  FileCheck2,
  ImageUp,
  Upload,
} from "lucide-react"

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

interface PaymentProofActionButtonProps {
  orderId: number
  initialUploaded?: boolean
  onUploaded?: (order: SupabasePedido) => void
  className?: string
  label?: string
}

export function PaymentProofUploader({
  orderId,
  initialUploaded = false,
  compact = false,
  onUploaded,
}: PaymentProofUploaderProps) {
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState("")
  const [isDragging, setIsDragging] = useState(false)
  const [uploadedFileName, setUploadedFileName] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)
  const actionLabel = initialUploaded ? "Reemplazar comprobante" : "Comprobante de pago"
  const hasUploadedFeedback = Boolean(uploadedFileName)

  const uploadFile = async (nextFile: File | null) => {
    const validationError = getPaymentProofValidationError(nextFile)

    setFile(nextFile)
    setUploadedFileName("")
    setError(validationError)

    if (validationError || !nextFile) {
      return
    }

    setUploading(true)
    setError("")

    try {
      const formData = new FormData()
      formData.set("orderId", String(orderId))
      formData.set("file", nextFile)

      const response = await fetch("/api/payment-proofs", {
        method: "POST",
        body: formData,
      })
      const data = await response.json()

      if (!response.ok || !data.order) {
        setError(data.error || "No pudimos subir el comprobante.")
        return
      }

      setUploadedFileName(nextFile.name)
      setFile(null)
      if (inputRef.current) inputRef.current.value = ""
      onUploaded?.(data.order as SupabasePedido)
    } catch {
      setError("No hemos podido subir el comprobante. Inténtalo de nuevo.")
    } finally {
      setUploading(false)
    }
  }

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    void uploadFile(event.target.files?.[0] ?? null)
  }

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    if (uploading) return
    setIsDragging(false)
    void uploadFile(event.dataTransfer.files?.[0] ?? null)
  }

  return (
    <div className={`border ${compact ? "rounded-xl border-[#303846] bg-[#1B2028] p-2.5 shadow-[0_0_24px_rgba(17,42,67,0.16)]" : "rounded-2xl border-[#112A43] bg-[#0B0B0B] p-4 sm:p-5"}`}>
      <div className={compact ? "space-y-2" : "space-y-4"}>
        <div>
          <p className="text-11px font-black uppercase tracking-widest text-white/70">
            {actionLabel}
          </p>
          <input
            ref={inputRef}
            id={`payment-proof-${orderId}`}
            type="file"
            accept=".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf"
            onChange={handleFileChange}
            className="sr-only"
          />

          <div
            role="button"
            tabIndex={0}
            aria-label="Seleccionar o arrastrar un comprobante"
            aria-disabled={uploading}
            onClick={() => {
              if (!uploading) inputRef.current?.click()
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                if (!uploading) inputRef.current?.click()
              }
            }}
            onDragEnter={(event) => {
              event.preventDefault()
              if (uploading) return
              setIsDragging(true)
            }}
            onDragOver={(event) => {
              event.preventDefault()
              if (uploading) return
              setIsDragging(true)
            }}
            onDragLeave={(event) => {
              event.preventDefault()
              if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                setIsDragging(false)
              }
            }}
            onDrop={handleDrop}
            className={`${compact ? "mt-1.5 min-h-24 px-3 py-2" : "mt-3 min-h-40 px-4 py-5"} flex flex-col items-center justify-center rounded-xl border border-dashed text-center outline-none transition-all focus-visible:ring-2 focus-visible:ring-beyonix-focus ${
              uploading
                ? "cursor-wait border-beyonix-blue-light/45 bg-[#112A43]/35"
                : isDragging
                  ? "border-beyonix-sky bg-[#112A43] shadow-[0_0_0_3px_rgba(79,131,173,0.12)]"
                  : file || hasUploadedFeedback
                    ? "border-emerald-400/35 bg-emerald-400/5"
                    : compact
                      ? "cursor-pointer border-beyonix-blue-light/28 bg-[#0B1624] hover:border-beyonix-blue-light/55 hover:bg-[#112A43]/65"
                      : "cursor-pointer border-beyonix-blue-light/28 bg-[#0B111A] hover:border-beyonix-blue-light/55 hover:bg-[#112A43]/55"
            }`}
          >
            <span className={`flex items-center justify-center rounded-xl border ${compact ? "size-9" : "size-12"} ${
              file || hasUploadedFeedback
                ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-300"
                : "border-beyonix-blue-light/35 bg-[#112A43]/55 text-white"
            }`}>
              {file || hasUploadedFeedback ? (
                <FileCheck2 className={compact ? "size-5" : "size-6"} />
              ) : (
                <ImageUp className={compact ? "size-5" : "size-6"} />
              )}
            </span>

            {uploading ? (
              <>
                <p className={`${compact ? "mt-1.5" : "mt-3"} max-w-full truncate text-sm font-semibold text-white`}>
                  Subiendo comprobante...
                </p>
                {file && (
                  <p className={`mt-1 max-w-full truncate text-xs ${compact ? "text-[#9CA3AF]" : "text-white/50"}`}>
                    {file.name}
                  </p>
                )}
              </>
            ) : hasUploadedFeedback ? (
              <>
                <p className={`${compact ? "mt-1.5" : "mt-3"} text-sm font-semibold text-emerald-200`}>
                  Comprobante subido correctamente
                </p>
                <p className={`mt-1 max-w-full truncate text-xs ${compact ? "text-[#9CA3AF]" : "text-white/50"}`}>
                  {uploadedFileName} · Toca para reemplazar
                </p>
              </>
            ) : file ? (
              <>
                <p className={`${compact ? "mt-1.5" : "mt-3"} max-w-full truncate text-sm font-semibold text-white`}>
                  {file.name}
                </p>
                <p className={`mt-1 text-xs ${compact ? "text-[#9CA3AF]" : "text-white/50"}`}>
                  {(file.size / 1024 / 1024).toFixed(2)} MB · Toca para reemplazar
                </p>
              </>
            ) : (
              <>
                <p className={`${compact ? "mt-1.5" : "mt-3"} text-sm font-semibold text-white`}>
                  Arrastrá el comprobante aquí
                </p>
                <p className={`mt-1 text-xs ${compact ? "text-[#C8C8C8]" : "text-white/55"}`}>
                  o toca para elegirlo desde tu dispositivo
                </p>
              </>
            )}

            <span className={`${compact ? "mt-1.5 h-8 px-3" : "mt-3 h-9 px-4"} inline-flex items-center justify-center rounded-lg border border-beyonix-blue-light/42 bg-[#112A43] text-xs font-black text-white shadow-[0_0_14px_rgba(47,111,163,0.16)] transition-all duration-200 hover:border-beyonix-blue-light/70 hover:bg-[#183B5E] hover:shadow-[0_0_18px_rgba(47,111,163,0.22)]`}>
              {uploading ? "Subiendo..." : "Seleccionar archivo"}
            </span>
          </div>

          <p className={`${compact ? "mt-1.5 leading-4 text-[#9CA3AF]" : "mt-2 leading-5 text-white/45"} text-center text-xs`}>
            JPG, JPEG, PNG o PDF · Máximo 5 MB
          </p>
        </div>

        {error && (
          <div className="rounded-xl border border-red-500/20 bg-red-950 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}
      </div>
    </div>
  )
}

export function PaymentProofActionButton({
  orderId,
  initialUploaded = false,
  onUploaded,
  className = "",
  label,
}: PaymentProofActionButtonProps) {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)
  const actionLabel =
    label ?? (initialUploaded ? "Editar comprobante" : "Agregar comprobante")

  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const selectedFile = event.target.files?.[0] ?? null
    const validationError = getPaymentProofValidationError(selectedFile)

    if (validationError || !selectedFile) {
      setError(validationError)
      return
    }

    setUploading(true)
    setError("")

    try {
      const formData = new FormData()
      formData.set("orderId", String(orderId))
      formData.set("file", selectedFile)

      const response = await fetch("/api/payment-proofs", {
        method: "POST",
        body: formData,
      })
      const data = await response.json()

      if (!response.ok || !data.order) {
        setError(data.error || "No pudimos subir el comprobante.")
        return
      }

      onUploaded?.(data.order as SupabasePedido)
    } catch {
      setError("No hemos podido subir el comprobante. Inténtalo de nuevo.")
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ""
    }
  }

  return (
    <span className="flex w-full flex-col items-stretch gap-1">
      <input
        ref={inputRef}
        id={`payment-proof-action-${orderId}`}
        type="file"
        accept=".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf"
        onChange={(event) => void handleFileChange(event)}
        className="sr-only"
      />
      <button
        type="button"
        aria-label={`${actionLabel} del pedido ${orderId}`}
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
        className={`${className} cursor-pointer disabled:cursor-not-allowed disabled:opacity-50`}
      >
        <Upload className="size-4" />
        {uploading ? "Subiendo..." : actionLabel}
      </button>
      {error && (
        <span className="max-w-52 text-left text-10px font-semibold leading-4 text-red-300 sm:text-right">
          {error}
        </span>
      )}
    </span>
  )
}
