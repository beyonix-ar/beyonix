"use client"

import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { AlertTriangle, Download, Loader2, X } from "lucide-react"

interface InvoiceViewerModalProps {
  title: string
  orderId: number
  onClose: () => void
}

/**
 * Visor de PDF en modal, autocontenido: obtiene el PDF real del pedido
 * (mismo endpoint que antes usaba la descarga directa) recién al abrirse,
 * y administra su propio loading/error — un fallo acá nunca afecta al
 * resto del detalle del pedido.
 */
export function InvoiceViewerModal({
  title,
  orderId,
  onClose,
}: InvoiceViewerModalProps) {
  const [mounted, setMounted] = useState(false)
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")
  const [errorMessage, setErrorMessage] = useState("")
  const [fileUrl, setFileUrl] = useState<string | null>(null)
  const [fileName, setFileName] = useState(`Factura-${orderId}.pdf`)

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [onClose])

  useEffect(() => {
    let active = true
    let objectUrl: string | null = null

    async function loadInvoice() {
      setStatus("loading")
      setErrorMessage("")

      try {
        const response = await fetch(`/api/orders/${orderId}/invoice`)

        if (!response.ok) {
          const data = (await response.json().catch(() => null)) as
            | { error?: string }
            | null
          throw new Error(data?.error || "No se pudo obtener la factura.")
        }

        const blob = await response.blob()
        if (!active) return

        const disposition = response.headers.get("Content-Disposition")
        const responseFileName = disposition?.match(/filename="?([^";]+)"?/i)?.[1]
        if (responseFileName) setFileName(responseFileName)
        objectUrl = URL.createObjectURL(blob)
        setFileUrl(objectUrl)
        setStatus("ready")
      } catch (loadError) {
        if (!active) return
        setErrorMessage(
          loadError instanceof Error
            ? loadError.message
            : "No se pudo obtener la factura.",
        )
        setStatus("error")
      }
    }

    void loadInvoice()

    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [orderId])

  if (!mounted) return null

  const handleDownload = () => {
    if (!fileUrl) return
    const anchor = document.createElement("a")
    anchor.href = fileUrl
    anchor.download = fileName
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 px-4 py-5 backdrop-blur-sm">
      <button
        type="button"
        aria-label="Cerrar"
        onClick={onClose}
        className="absolute inset-0 cursor-pointer"
      />

      <div className="relative z-10 flex h-[min(88vh,900px)] w-[min(920px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl border border-beyonix-blue-500/40 bg-[#0B1118] shadow-[0_28px_90px_rgba(0,0,0,0.72)]">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/8 px-4 py-3">
          <h2 className="truncate text-sm font-bold text-white">{title}</h2>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={handleDownload}
              disabled={status !== "ready" || !fileUrl}
              className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-lg border border-white/10 px-3 text-xs font-bold text-white transition-colors hover:bg-white/8 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Download className="size-3.5" />
              Descargar factura
            </button>
            <button
              type="button"
              aria-label="Cerrar"
              onClick={onClose}
              className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-white/50 transition-colors hover:bg-white/8 hover:text-white"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        <div className="relative min-h-0 flex-1 bg-[#1a1a1a]">
          {status === "loading" && (
            <div className="flex size-full flex-col items-center justify-center gap-2 text-white/60">
              <Loader2 className="size-6 animate-spin" />
              <p className="text-xs font-medium">Cargando factura...</p>
            </div>
          )}

          {status === "error" && (
            <div className="flex size-full flex-col items-center justify-center gap-2 px-6 text-center text-red-200">
              <AlertTriangle className="size-6" />
              <p className="text-xs font-medium">{errorMessage}</p>
            </div>
          )}

          {status === "ready" && fileUrl && (
            <iframe src={fileUrl} title={title} className="size-full border-0" />
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
