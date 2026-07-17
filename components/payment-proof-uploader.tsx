"use client"

import { useRef, useState } from "react"
import {
  FileCheck2,
  ImageUp,
  Upload,
  X,
} from "lucide-react"

import {
  getPaymentProofValidationError,
} from "@/lib/payments/transfer"
import type { SupabasePedido } from "@/lib/supabase/types"

interface PaymentProofUploaderProps {
  orderId: number
  initialUploaded?: boolean
  compact?: boolean
  expand?: boolean
  onUploaded?: (order: SupabasePedido) => void
}

interface PaymentProofActionButtonProps {
  orderId: number
  initialUploaded?: boolean
  onUploaded?: (order: SupabasePedido) => void
  className?: string
  label?: string
}

function formatFileSize(size: number) {
  if (!Number.isFinite(size) || size <= 0) return "0 KB"

  const sizeInMb = size / 1024 / 1024

  return sizeInMb >= 1
    ? `${sizeInMb.toFixed(2)} MB`
    : `${Math.max(Math.round(size / 1024), 1)} KB`
}

export function PaymentProofUploader({
  orderId,
  initialUploaded = false,
  compact = false,
  expand = false,
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

  const clearSelectedFile = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    setFile(null)
    setError("")
    setUploadedFileName("")

    if (inputRef.current) {
      inputRef.current.value = ""
    }
  }

  return (
    <div className={`border ${expand ? "flex flex-1 flex-col" : ""} ${compact ? "rounded-xl border-beyonix-gray-700 bg-beyonix-gray-900 p-3 shadow-lg shadow-black/20" : "rounded-2xl border-beyonix-gray-700 bg-beyonix-gray-900 p-4 sm:p-5"}`}>
      <div className={`${expand ? "flex flex-1 flex-col" : ""} ${compact ? "space-y-2" : "space-y-4"}`}>
        <div className={expand ? "flex flex-1 flex-col" : ""}>
          <p className="text-11px font-black uppercase tracking-widest text-beyonix-gray-300">
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
            aria-busy={uploading}
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
            className={`${compact ? `mt-2 ${expand ? "min-h-28 flex-1" : "min-h-28"} px-3 py-2` : "mt-3 min-h-36 px-4 py-4"} flex flex-col items-center justify-center rounded-xl border border-dashed text-center outline-none transition-colors focus-visible:ring-2 focus-visible:ring-beyonix-blue-500 ${
              uploading
                ? "cursor-wait border-beyonix-blue-500 bg-beyonix-blue-900"
                : isDragging
                  ? "border-beyonix-blue-300 bg-beyonix-blue-700/40 ring-2 ring-beyonix-blue-500/30"
                  : file || hasUploadedFeedback
                    ? "border-beyonix-status-success/35 bg-beyonix-status-success/10"
                    : compact
                      ? "cursor-pointer border-beyonix-gray-700 bg-beyonix-gray-900 hover:border-beyonix-blue-500 hover:bg-beyonix-blue-900"
                      : "cursor-pointer border-beyonix-gray-700 bg-beyonix-gray-900 hover:border-beyonix-blue-500 hover:bg-beyonix-blue-900"
            }`}
          >
            <span className={`flex items-center justify-center rounded-xl border ${compact ? "size-9" : "size-12"} ${
              file || hasUploadedFeedback
                ? "border-beyonix-status-success/30 bg-beyonix-status-success/10 text-beyonix-status-success"
                : "border-beyonix-blue-500/60 bg-beyonix-blue-900 text-beyonix-blue-300"
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
                  Subiendo comprobante
                </p>
                {file && (
                  <div className="mt-1 max-w-full text-center text-xs text-beyonix-gray-300">
                    <p className="truncate">{file.name}</p>
                    <p className="mt-0.5">{formatFileSize(file.size)}</p>
                  </div>
                )}
                <div className="mt-3 w-full max-w-xs">
                  <div className="h-1.5 overflow-hidden rounded-full bg-beyonix-gray-700">
                    <div className="h-full w-2/3 animate-pulse rounded-full bg-beyonix-blue-500" />
                  </div>
                  <p className="mt-1.5 text-10px font-semibold uppercase tracking-wider text-beyonix-blue-300">
                    Subida en progreso
                  </p>
                </div>
              </>
            ) : hasUploadedFeedback ? (
              <>
                <p className={`${compact ? "mt-1.5" : "mt-3"} text-sm font-semibold text-beyonix-status-success`}>
                  Comprobante subido correctamente
                </p>
                <p className="mt-1 max-w-full truncate text-xs text-beyonix-gray-300">
                  {uploadedFileName} · Toca para reemplazar
                </p>
              </>
            ) : file ? (
              <>
                <div className={`${compact ? "mt-1.5" : "mt-3"} max-w-full text-center`}>
                  <p className="truncate text-sm font-semibold text-white">
                    {file.name}
                  </p>
                  <p className="mt-1 text-xs text-beyonix-gray-300">
                    {formatFileSize(file.size)}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label="Quitar archivo seleccionado"
                  title="Quitar archivo seleccionado"
                  onClick={clearSelectedFile}
                  className="mt-2 inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-beyonix-status-danger/35 bg-beyonix-status-danger/10 px-3 text-xs font-semibold text-beyonix-status-danger transition-colors hover:border-beyonix-status-danger/60 hover:bg-beyonix-status-danger/20"
                >
                  <X className="size-3.5" aria-hidden="true" />
                  Quitar
                </button>
              </>
            ) : (
              <>
                <p className={`${compact ? "mt-1.5" : "mt-3"} text-sm font-semibold text-white`}>
                  Arrastrá el comprobante aquí
                </p>
                <p className="mt-1 text-xs text-beyonix-gray-300">
                  o toca para elegirlo desde tu dispositivo
                </p>
              </>
            )}

            {!uploading && (
              <span className={`${compact ? "mt-2 h-8 px-3" : "mt-3 h-9 px-4"} inline-flex items-center justify-center rounded-lg border border-beyonix-blue-500 bg-beyonix-blue-700 text-xs font-black text-white shadow-md shadow-black/20 transition-colors hover:border-beyonix-blue-300 hover:bg-beyonix-blue-500`}>
                {file ? "Cambiar archivo" : "Seleccionar archivo"}
              </span>
            )}
          </div>

          <p className={`${compact ? "mt-1.5 leading-4" : "mt-2 leading-5"} text-center text-xs text-beyonix-gray-500`}>
            JPG, JPEG, PNG o PDF · Máximo 5 MB
          </p>
        </div>

        {error && (
          <div className="rounded-xl border border-beyonix-status-danger/30 bg-beyonix-status-danger/10 px-4 py-3 text-sm text-beyonix-status-danger">
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
        title={actionLabel}
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
        className={`${className} cursor-pointer disabled:cursor-not-allowed disabled:opacity-50`}
      >
        <Upload className="size-4" aria-hidden="true" />
        {uploading ? "Subiendo..." : actionLabel}
      </button>
      {error && (
        <span className="max-w-52 text-left text-10px font-semibold leading-4 text-beyonix-status-danger sm:text-right">
          {error}
        </span>
      )}
    </span>
  )
}
