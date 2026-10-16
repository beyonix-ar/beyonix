"use client"

import { useEffect, useRef, useState, type FormEvent } from "react"
import { Camera, ScanLine } from "lucide-react"

import { AdminButton, AdminPrimaryButton } from "@/app/admin/components/admin-controls"
import { normalizeScannedCode } from "@/lib/admin/dispatch-scan"
import { CameraScanner, type CameraFeedback } from "./camera-scanner"

/**
 * Un solo punto de lectura para Despachos: el lector USB (teclado + Enter) y
 * la cámara del celular llaman al mismo `onScan`. El campo queda listo para la
 * siguiente lectura (foco) apenas termina la anterior.
 */
export function ScanField({ label, placeholder, submitLabel, value, onChange, onScan, busy = false, disabled = false, autoFocus = false, cameraTitle, cameraHint, continuousCamera = false, feedback = null }: {
  label: string
  placeholder: string
  submitLabel: string
  value: string
  onChange: (value: string) => void
  onScan: (code: string) => void
  busy?: boolean
  disabled?: boolean
  autoFocus?: boolean
  cameraTitle: string
  cameraHint: string
  /** Armado/lote: la cámara sigue abierta para leer varias etiquetas seguidas. */
  continuousCamera?: boolean
  feedback?: CameraFeedback
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [cameraOpen, setCameraOpen] = useState(false)

  // Al terminar una lectura el foco vuelve al campo, salvo que el operador
  // esté usando otro control (modal, cámara, otro input).
  useEffect(() => {
    if (busy || disabled || cameraOpen || !autoFocus) return
    const active = document.activeElement
    if (!active || active === document.body || active === inputRef.current) inputRef.current?.focus()
  }, [busy, disabled, cameraOpen, autoFocus])

  function emit(raw: string) {
    const code = normalizeScannedCode(raw)
    if (!code || busy || disabled) return
    onScan(code)
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    emit(value)
  }

  const submitDisabled = busy || disabled || !value.trim()
  const submitText = busy ? "Verificando…" : submitLabel
  return <div className="dispatch-scan-field space-y-2">
    <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
      <label className="dispatch-scan-input relative min-w-0 flex-1">
        <span className="sr-only">{label}</span>
        <ScanLine className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-beyonix-sky" />
        <input ref={inputRef} aria-label={label} autoFocus={autoFocus} autoComplete="off" autoCapitalize="characters" spellCheck={false} enterKeyHint="send"
          value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} disabled={disabled}
          className="admin-control-input admin-ds-control h-14 w-full min-w-0 pl-12 pr-3 text-base text-white outline-none sm:pr-4" />
      </label>
      <AdminPrimaryButton type="submit" className="h-12 w-full shrink-0 px-5 text-sm sm:h-14 sm:w-auto" disabled={submitDisabled}>{submitText}</AdminPrimaryButton>
    </form>
    <AdminButton className="h-12 w-full text-sm sm:h-11" icon={<Camera className="size-5" />} disabled={disabled} onClick={() => setCameraOpen(true)}>Escanear con cámara</AdminButton>
    <CameraScanner open={cameraOpen} title={cameraTitle} hint={cameraHint} continuous={continuousCamera} paused={busy} feedback={feedback}
      onDetected={(code) => { emit(code); if (!continuousCamera) setCameraOpen(false) }} onClose={() => setCameraOpen(false)} />
  </div>
}
