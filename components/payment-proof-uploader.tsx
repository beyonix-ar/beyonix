"use client"

import { useRef, useState } from "react"
import {
  FileCheck2,
  ImageUp,
  Upload,
} from "lucide-react"

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
  const inputRef = useRef<HTMLInputElement>(null)
  const actionLabel = initialUploaded
    ? "Reemplazar comprobante"
    : "Subir comprobante"

  const selectFile = (nextFile: File | null) => {
    const validationError = getPaymentProofValidationError(nextFile)

    setFile(nextFile)
    setError(validationError)
  }

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    selectFile(event.target.files?.[0] ?? null)
  }

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setIsDragging(false)
    selectFile(event.dataTransfer.files?.[0] ?? null)
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

      setFile(null)
      if (inputRef.current) inputRef.current.value = ""
      onUploaded?.(data.order as SupabasePedido)
    } catch {
      setError("No hemos podido subir el comprobante. Inténtalo de nuevo.")
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className={`border ${compact ? "rounded-xl border-[#303846] bg-[#1B2028] p-3 shadow-[0_0_24px_rgba(17,42,67,0.16)]" : "rounded-2xl border-[#112A43] bg-[#0B0B0B] p-4 sm:p-5"}`}>
      <div className={compact ? "space-y-2.5" : "space-y-4"}>
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
            onClick={() => inputRef.current?.click()}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                inputRef.current?.click()
              }
            }}
            onDragEnter={(event) => {
              event.preventDefault()
              setIsDragging(true)
            }}
            onDragOver={(event) => {
              event.preventDefault()
              setIsDragging(true)
            }}
            onDragLeave={(event) => {
              event.preventDefault()
              if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                setIsDragging(false)
              }
            }}
            onDrop={handleDrop}
            className={`${compact ? "mt-2 min-h-32 px-4 py-3" : "mt-3 min-h-44 px-5 py-6"} flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed text-center outline-none transition-all focus-visible:ring-2 focus-visible:ring-beyonix-focus ${
              isDragging
                ? "border-beyonix-sky bg-[#112A43] shadow-[0_0_0_3px_rgba(79,131,173,0.12)]"
                : file
                  ? "border-emerald-400/35 bg-emerald-400/5"
                : compact
                  ? "border-[#303846] bg-[#222832] hover:border-[#112A43] hover:bg-[#252c37]"
                  : "border-white/20 bg-[#141414] hover:border-[#112A43] hover:bg-[#181818]"
            }`}
          >
            <span className={`flex items-center justify-center rounded-xl border ${compact ? "size-10" : "size-12"} ${
              file
                ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-300"
                : "border-[#112A43] bg-[#112A43]/40 text-white"
            }`}>
              {file ? (
                <FileCheck2 className={compact ? "size-5" : "size-6"} />
              ) : (
                <ImageUp className={compact ? "size-5" : "size-6"} />
              )}
            </span>

            {file ? (
              <>
                <p className={`${compact ? "mt-2" : "mt-3"} max-w-full truncate text-sm font-semibold text-white`}>
                  {file.name}
                </p>
                <p className={`mt-1 text-xs ${compact ? "text-[#9CA3AF]" : "text-white/50"}`}>
                  {(file.size / 1024 / 1024).toFixed(2)} MB · Toca para reemplazar
                </p>
              </>
            ) : (
              <>
                <p className={`${compact ? "mt-2" : "mt-3"} text-sm font-semibold text-white`}>
                  Arrastra el comprobante aquí
                </p>
                <p className={`mt-1 text-xs ${compact ? "text-[#C8C8C8]" : "text-white/55"}`}>
                  o toca para elegirlo desde tu dispositivo
                </p>
              </>
            )}

            <span className={`${compact ? "mt-2.5 px-3 py-1.5" : "mt-4 px-4 py-2"} rounded-lg bg-[#112A43] text-xs font-semibold text-white transition-colors hover:bg-[#183B5E]`}>
              Seleccionar archivo
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

        <Button
          type="button"
          aria-label={`${actionLabel} del pedido ${orderId}`}
          title={actionLabel}
          onClick={handleUpload}
          disabled={uploading || Boolean(error) || !file}
          className={`w-full cursor-pointer text-white ${
            file && !error
              ? "bg-[#16A34A] hover:bg-[#15803D]"
              : "bg-[#112A43] hover:bg-[#183B5E]"
          } disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-white/55`}
        >
          <Upload className="mr-2 size-4" />
          {uploading ? "Subiendo..." : actionLabel}
        </Button>
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
        title={actionLabel}
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
