"use client"

import { useEffect, useRef, useState, type FormEvent } from "react"
import { createPortal } from "react-dom"
import { AlertTriangle, CheckCircle2, X, XCircle } from "lucide-react"

import { AdminButton, AdminPrimaryButton } from "@/app/admin/components/admin-controls"
import { createBarcodeReader, type BarcodeReader } from "@/lib/admin/barcode-reader"
import { createCameraGate, normalizeScannedCode } from "@/lib/admin/dispatch-scan"

// Intervalo entre cuadros: el nativo es barato; ZXing (iPhone) corre en el hilo principal.
const FRAME_INTERVAL_MS = { native: 120, fallback: 200 } as const

type CameraState =
  | { kind: "starting" }
  | { kind: "scanning"; reader: BarcodeReader["kind"] }
  | { kind: "insecure" }
  | { kind: "unsupported" }
  | { kind: "denied" }
  | { kind: "unavailable" }
  | { kind: "busy" }
  | { kind: "unknown" }

export type CameraFeedback = { tone: "success" | "warning" | "error"; message: string } | null

const FALLBACK_MESSAGES: Record<Exclude<CameraState["kind"], "starting" | "scanning">, string> = {
  insecure: "La cámara requiere una conexión segura (HTTPS).",
  unsupported: "Este navegador no permite usar la cámara.",
  denied: "Permiso de cámara denegado. Tocá el ícono junto a la dirección del sitio, entrá a Permisos → Cámara → Permitir y después tocá «Reintentar cámara».",
  unavailable: "No se encontró una cámara disponible.",
  busy: "La cámara está ocupada por otra aplicación.",
  unknown: "No pudimos abrir la cámara.",
}

function cameraErrorState(cause: unknown): CameraState {
  const name = cause instanceof DOMException || cause instanceof Error ? cause.name : ""
  if (name === "NotAllowedError" || name === "PermissionDeniedError") return { kind: "denied" }
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") return { kind: "busy" }
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return { kind: "unavailable" }
  if (name === "NotSupportedError" || name === "TypeError" || name === "SecurityError") return { kind: "unsupported" }
  return { kind: "unknown" }
}

export function CameraScanner({ open, title, hint, continuous = false, paused = false, feedback = null, onDetected, onClose, createReader = createBarcodeReader }: {
  open: boolean
  title: string
  /** Qué tiene que encuadrar el operador (producto, bulto, pedido, lote). */
  hint: string
  /** Armado y lote: la cámara queda abierta para la siguiente lectura. */
  continuous?: boolean
  /** Mientras se procesa la lectura anterior no se toma otra. */
  paused?: boolean
  feedback?: CameraFeedback
  /** source: lectura de la cámara o código ingresado a mano en el visor. */
  onDetected: (code: string, source: "camera" | "manual") => void
  onClose: () => void
  /** Motor de lectura (nativo o ZXing). Se inyecta sólo en tests. */
  createReader?: () => Promise<BarcodeReader>
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const pausedRef = useRef(paused)
  const onDetectedRef = useRef(onDetected)
  const createReaderRef = useRef(createReader)
  const [state, setState] = useState<CameraState>({ kind: "starting" })
  const [manual, setManual] = useState("")
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => { pausedRef.current = paused }, [paused])
  useEffect(() => { onDetectedRef.current = onDetected }, [onDetected])

  useEffect(() => {
    if (!open) return
    setState({ kind: "starting" }); setManual("")
    closeRef.current?.focus()
    let cancelled = false
    let stream: MediaStream | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    const gate = createCameraGate()
    void (async () => {
      if (typeof window !== "undefined" && window.isSecureContext === false) { setState({ kind: "insecure" }); return }
      if (!navigator.mediaDevices?.getUserMedia) { setState({ kind: "unsupported" }); return }
      // Sólo "denied" corta antes de pedir la cámara; "prompt" y "granted" siguen
      // a getUserMedia, que es la fuente de verdad y muestra el pedido nativo.
      // Safari puede no implementar Permissions API para camera.
      try {
        const permission = await navigator.permissions?.query({ name: "camera" as PermissionName })
        if (cancelled) return
        if (permission?.state === "denied") { setState({ kind: "denied" }); return }
      } catch { /* Consulta no soportada: getUserMedia gestiona el permiso. */ }
      // Safari pide el permiso en esta llamada: siempre después del toque del operador.
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false })
      } catch (cause) {
        if (!cancelled) setState(cameraErrorState(cause))
        return
      }
      const video = videoRef.current
      if (cancelled || !video) { stream.getTracks().forEach((track) => track.stop()); return }
      video.srcObject = stream
      try { await video.play() }
      catch { if (!cancelled) setState({ kind: "unknown" }); stream.getTracks().forEach((track) => track.stop()); return }
      let reader: BarcodeReader
      try { reader = await createReaderRef.current() }
      catch { if (!cancelled) setState({ kind: "unsupported" }); stream.getTracks().forEach((track) => track.stop()); return }
      if (cancelled) return
      setState({ kind: "scanning", reader: reader.kind })
      const tick = async () => {
        if (cancelled) return
        if (!pausedRef.current && video.readyState >= 2) {
          let detected: string | null
          try { detected = await reader.detect(video) }
          catch { if (!cancelled) setState({ kind: "unknown" }); stream?.getTracks().forEach((track) => track.stop()); return }
          const code = gate(normalizeScannedCode(detected ?? ""))
          if (code && !cancelled) {
            onDetectedRef.current(code, "camera")
            if (!continuous) return
          }
        }
        timer = setTimeout(() => void tick(), FRAME_INTERVAL_MS[reader.kind])
      }
      void tick()
    })()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      stream?.getTracks().forEach((track) => track.stop())
    }
  }, [open, continuous, retryKey])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])

  if (!open) return null

  function submitManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const code = normalizeScannedCode(manual)
    if (!code) return
    setManual("")
    onDetected(code, "manual")
  }

  const fallback = state.kind !== "starting" && state.kind !== "scanning"

  // Portal fuera del layout de Admin: el visor es siempre oscuro (cámara) y no
  // hereda los ajustes del tema claro.
  return createPortal(<div role="dialog" aria-modal="true" aria-label={title} data-camera-state={state.kind} data-reader={state.kind === "scanning" ? state.reader : undefined} className="dispatch-camera fixed inset-0 z-[90] flex flex-col bg-[#03080e] text-white">
    <header className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-2.5">
      <h2 className="min-w-0 truncate text-base font-black">{title}</h2>
      <button ref={closeRef} type="button" onClick={onClose} aria-label="Cerrar cámara" className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-xl border border-white/15 bg-white/5"><X className="size-5" /></button>
    </header>

    <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black">
      <video ref={videoRef} muted playsInline autoPlay className={`absolute inset-0 size-full object-cover ${fallback ? "invisible" : ""}`} />
      {!fallback && <div aria-hidden="true" className="dispatch-camera-frame pointer-events-none relative z-10 aspect-[16/9] w-[82%] max-w-md rounded-2xl">
        {state.kind === "scanning" && !paused && <span className="dispatch-camera-line absolute inset-x-4 top-1/2 h-0.5 rounded-full bg-beyonix-sky" />}
      </div>}
      {fallback && <div role="alert" className="z-10 mx-4 w-full max-w-sm rounded-xl border border-amber-400/35 bg-[#18202a] p-3 text-sm text-white">
        <p className="flex items-start gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-300" /><span>{FALLBACK_MESSAGES[state.kind]}</span></p>
        <AdminButton className="mt-3 h-10 w-full" onClick={() => setRetryKey((key) => key + 1)}>Reintentar cámara</AdminButton>
      </div>}
      {!fallback && <p role="status" className="absolute inset-x-3 top-3 z-10 mx-auto w-fit max-w-full rounded-full bg-black/75 px-3 py-1.5 text-center text-xs font-bold">
        {state.kind === "starting" ? "Abriendo cámara…" : paused ? "Procesando lectura…" : hint}
      </p>}
    </div>

    <footer className="space-y-2 border-t border-white/10 px-4 pt-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      {feedback && <p role="status" className={`flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-bold ${feedback.tone === "success" ? "bg-emerald-950 text-emerald-200" : feedback.tone === "warning" ? "bg-amber-950 text-amber-200" : "bg-red-950 text-red-200"}`}>
        {feedback.tone === "error" ? <XCircle className="size-5 shrink-0" /> : <CheckCircle2 className="size-5 shrink-0" />}<span className="min-w-0">{feedback.message}</span>
      </p>}
      <form onSubmit={submitManual} className="space-y-1">
        <label htmlFor="dispatch-camera-manual" className="block text-xs font-bold text-white/80">Código manual</label>
        <div className="flex min-w-0 gap-2">
          <input id="dispatch-camera-manual" aria-label="Ingresar código a mano" value={manual} onChange={(event) => setManual(event.target.value)} placeholder="Ingresá el código" autoComplete="off" autoCapitalize="characters" className="admin-control-input admin-ds-control h-11 min-w-0 flex-1 px-3 text-base text-white outline-none" />
          <AdminPrimaryButton type="submit" className="h-11 shrink-0 px-4" disabled={!manual.trim() || paused}>Enviar</AdminPrimaryButton>
        </div>
      </form>
      <AdminButton className="h-11 w-full" onClick={onClose}>Cerrar cámara</AdminButton>
    </footer>
  </div>, document.body)
}
