"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Loader2,
  LogIn,
  RefreshCw,
  Upload,
  UserPen,
  X,
} from "lucide-react"

import { BeyonixButton } from "@/components/beyonix-ui"
import { CheckoutStatusCard } from "@/components/checkout/checkout-status-layout"
import { CustomerPaymentProof } from "@/components/customer-payment-proof"
import { PaymentProofUploader } from "@/components/payment-proof-uploader"
import { getGuestOrderToken } from "@/lib/orders/guest-order-token-client"
import {
  canUploadTransferProof,
  isAwaitingTransferPayment,
  TRANSFER_STOCK_CONFLICT_CUSTOMER_MESSAGE,
  TRANSFER_STOCK_CONFLICT_PAYMENT_STATUS,
  TRANSFER_VERIFICATION_OUTCOME_MESSAGES,
  type TransferVerificationCustomerOutcome,
} from "@/lib/orders/transfer-verification-reasons"
import {
  formatReservationCountdown,
  reservationSecondsLeft,
} from "@/lib/cart/checkout-step-reservation"
import { formatPublicOrderId } from "@/lib/account/account-formatters"
import { BEYONIX_SUPPORT_HOURS_DETAIL } from "@/lib/legal-contact"
import type { TransferBankDetails } from "@/lib/payments/transfer-bank-details"
import {
  TRANSFER_HOLDER_NAME_MAX_LENGTH,
  validateTransferDeclaration,
  type TransferDeclarationField,
} from "@/lib/payments/transfer-declaration"
import type { SupabasePedido } from "@/lib/supabase/types"

const TRANSFER_ELIGIBLE_PAYMENT_STATUSES = ["pendiente_comprobante", "en_revision"]
const RESERVATION_EXPIRED_REDIRECT_MS = 2800

/** Reloj de la reserva del Paso 3 tal como lo informó el servidor (nunca un timer local propio). */
export interface TransferReservationClock {
  expiresAt: string | null
  serverNow: string
  /** performance.now() al recibir la respuesta: descuenta el tiempo transcurrido sin depender del reloj del dispositivo. */
  receivedAt: number
}

function transferReservationSecondsLeft(reservation: TransferReservationClock | null, now: number) {
  if (!reservation?.expiresAt) return 0
  return reservationSecondsLeft(reservation.expiresAt, reservation.serverNow, reservation.receivedAt, now)
}

/** Importe a transferir calculado por el servidor (descuenta el saldo a favor aplicado). */
function transferAmountDue(order: SupabasePedido) {
  return Number(order.external_amount_due ?? order.total)
}

const formatPriceNumber = (price: number) =>
  new Intl.NumberFormat("es-AR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(Number.isFinite(price) ? price : 0)

const inputClassName =
  "h-10 w-full rounded-lg border border-[var(--account-border)] bg-[var(--account-surface)] px-3 text-sm text-[var(--account-text-primary)] outline-none transition-colors placeholder:text-[var(--account-text-muted)] focus:border-[var(--account-accent)]"
const labelClassName =
  "text-11px font-semibold uppercase tracking-wider text-[var(--account-text-secondary)]"

function StepCard({
  children,
  className = "",
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={`w-full rounded-2xl border border-[var(--account-border-subtle)] bg-[var(--account-surface)] p-5 shadow-sm sm:p-6 ${className}`}
    >
      {children}
    </div>
  )
}

// La validación ocurre al confirmar la transferencia (paso 2): no hay un paso
// propio que vuelva a pedir los datos del titular.
const TRANSFER_STEP_LABELS = ["Titular", "Transferencia", "Resultado"] as const

/** Titular declarado en el paso 1: se reutiliza al validar, sin volver a pedirlo. */
interface TransferHolder {
  firstName: string
  lastName: string
  document: string
}

function TransferStepIndicator({ step }: { step: 1 | 2 | 3 }) {
  const stepLabel = TRANSFER_STEP_LABELS[step - 1]
  const totalSteps = TRANSFER_STEP_LABELS.length

  return (
    <div
      role="status"
      aria-label={`Paso ${step} de ${totalSteps}: ${stepLabel}`}
      className="mb-4 flex flex-col items-center gap-1.5"
    >
      <div className="flex items-center gap-1.5" aria-hidden="true">
        {TRANSFER_STEP_LABELS.map((_, index) => index + 1).map((dot) => (
          <span
            key={dot}
            className={`h-1.5 rounded-full transition-all ${
              dot === step
                ? "w-5 bg-[var(--account-accent)]"
                : dot < step
                  ? "w-1.5 bg-[var(--account-success)]"
                  : "w-1.5 bg-[var(--account-border)]"
            }`}
          />
        ))}
      </div>
      <p className="text-10px font-semibold uppercase tracking-widest text-[var(--account-text-secondary)]">
        Paso {step} de {totalSteps} · {stepLabel}
      </p>
    </div>
  )
}

function CopyableField({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string
  value: string
  copied: boolean
  onCopy: () => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className={labelClassName}>{label}</p>
        <p className="mt-1 break-all text-base font-bold text-[var(--account-text-primary)]">
          {value}
        </p>
      </div>
      <button
        type="button"
        aria-label={`Copiar ${label.toLowerCase()}`}
        title={`Copiar ${label.toLowerCase()}`}
        onClick={onCopy}
        className="flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-[var(--account-accent)] px-3 text-xs font-semibold text-white transition-colors duration-200 hover:bg-[var(--account-accent-hover)]"
      >
        {copied ? (
          <Check className="size-4" aria-hidden="true" />
        ) : (
          <Copy className="size-4" aria-hidden="true" />
        )}
        <span className="hidden sm:inline">{copied ? "Copiado" : "Copiar"}</span>
      </button>
    </div>
  )
}

function TransferDeclarationInput({
  id,
  label,
  value,
  onChange,
  error,
  inputMode,
  maxLength,
  autoComplete,
  disabled,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  error?: string
  inputMode?: "numeric"
  maxLength?: number
  autoComplete?: string
  disabled: boolean
}) {
  const errorId = `${id}-error`

  return (
    <div>
      <label className={labelClassName} htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className={`${inputClassName} mt-1 ${error ? "border-[var(--account-danger)]" : ""}`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required
        aria-required="true"
        aria-invalid={error ? "true" : "false"}
        aria-describedby={error ? errorId : undefined}
        inputMode={inputMode}
        maxLength={maxLength}
        autoComplete={autoComplete}
        disabled={disabled}
      />
      {error && (
        <p id={errorId} role="alert" className="mt-1 text-xs font-medium text-[var(--account-danger)]">
          {error}
        </p>
      )}
    </div>
  )
}

function TransferAmountBox({ amount }: { amount: number }) {
  return (
    <div className="mt-5 flex flex-col items-center gap-1 rounded-xl border border-[var(--account-success-border)] bg-[var(--account-success-bg)] px-4 py-4 text-center">
      <p className="text-11px font-bold uppercase tracking-wider text-[var(--account-success)]">
        Monto a transferir
      </p>
      <p className="flex items-baseline gap-1 text-[var(--account-success)]">
        <span className="text-xl font-bold">$</span>
        <span className="text-3xl font-extrabold tracking-tight tabular-nums sm:text-4xl">
          {formatPriceNumber(amount)}
        </span>
      </p>
    </div>
  )
}

/**
 * Paso previo a los datos bancarios: el titular de la cuenta que va a
 * transferir. El servidor los valida y guarda y RECIÉN ENTONCES devuelve
 * alias/CVU -- así cualquier transferencia (incluso tardía) puede atribuirse
 * al pedido. El monto no se pide: lo calculó el servidor.
 */
function TransferHolderStep({
  order,
  onSaved,
  onReservationExpired,
}: {
  order: SupabasePedido
  onSaved: (bankDetails: TransferBankDetails, holder: TransferHolder) => void
  onReservationExpired: () => void
}) {
  const [firstName, setFirstName] = useState(order.transfer_payer_first_name ?? "")
  const [lastName, setLastName] = useState(order.transfer_payer_last_name ?? "")
  const [dni, setDni] = useState(order.transfer_payer_dni ?? "")
  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState("")
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<TransferDeclarationField, string>>
  >({})
  const amount = transferAmountDue(order)

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (submitting) return

    const declaration = validateTransferDeclaration({ nombre: firstName, apellido: lastName, dni, monto: amount })
    if (!declaration.ok) {
      setFieldErrors(declaration.errors)
      setErrorMessage(declaration.errors.amount ? "No pudimos calcular el importe a transferir." : "")
      return
    }

    setFieldErrors({})
    setErrorMessage("")
    setSubmitting(true)
    try {
      const guestToken = getGuestOrderToken(order.id)
      const response = await fetch(`/api/transferencia/${order.id}/titular`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(guestToken ? { "x-guest-order-token": guestToken } : {}),
        },
        body: JSON.stringify({
          nombre: declaration.value.firstName,
          apellido: declaration.value.lastName,
          dni: declaration.value.document,
        }),
      })
      const data = (await response.json()) as {
        code?: string
        error?: string
        fieldErrors?: Partial<Record<TransferDeclarationField, string>>
        bankTransfer?: TransferBankDetails
      }

      if (!response.ok || !data.bankTransfer) {
        if (data.code === "RESERVATION_EXPIRED") {
          onReservationExpired()
          return
        }
        if (data.fieldErrors && Object.keys(data.fieldErrors).length > 0) {
          setFieldErrors(data.fieldErrors)
        } else {
          setErrorMessage(data.error || "No pudimos guardar los datos del titular. Intentá nuevamente.")
        }
        return
      }

      onSaved(data.bankTransfer, {
        firstName: declaration.value.firstName,
        lastName: declaration.value.lastName,
        document: declaration.value.document,
      })
    } catch {
      setErrorMessage("No pudimos conectarnos. Intentá nuevamente.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <StepCard>
      <TransferStepIndicator step={1} />

      <h1 className="text-center text-xl font-bold text-[var(--account-text-primary)] sm:text-2xl">
        ¿Desde qué cuenta vas a transferir?
      </h1>
      <p className="mx-auto mt-1.5 max-w-sm text-center text-sm leading-5 text-[var(--account-text-secondary)]">
        Completá los datos del <strong className="font-semibold text-[var(--account-text-primary)]">titular de la cuenta desde donde vas a transferir</strong>{" "}
        para que podamos identificar tu pago.
      </p>

      <TransferAmountBox amount={amount} />

      <form onSubmit={handleSubmit} noValidate className="mt-4 flex flex-col gap-3.5">
        <TransferDeclarationInput
          id="transfer-holder-nombre"
          label="Nombre/s del titular"
          value={firstName}
          onChange={setFirstName}
          error={fieldErrors.firstName}
          autoComplete="off"
          maxLength={TRANSFER_HOLDER_NAME_MAX_LENGTH}
          disabled={submitting}
        />
        <TransferDeclarationInput
          id="transfer-holder-apellido"
          label="Apellido/s del titular"
          value={lastName}
          onChange={setLastName}
          error={fieldErrors.lastName}
          autoComplete="off"
          maxLength={TRANSFER_HOLDER_NAME_MAX_LENGTH}
          disabled={submitting}
        />
        <TransferDeclarationInput
          id="transfer-holder-dni"
          label="DNI/CUIT del titular"
          value={dni}
          onChange={setDni}
          error={fieldErrors.document}
          inputMode="numeric"
          maxLength={13}
          disabled={submitting}
        />

        {errorMessage && (
          <p role="alert" className="text-xs font-medium text-[var(--account-danger)]">{errorMessage}</p>
        )}

        <BeyonixButton type="submit" disabled={submitting} className="mt-1 h-11 w-full">
          {submitting ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Guardando datos...
            </>
          ) : (
            "Continuar a los datos de transferencia"
          )}
        </BeyonixButton>
      </form>
    </StepCard>
  )
}

/** Resultado de /api/transferencia/[orderId]/verificar (respuesta mínima allowlisteada). */
interface TransferVerifyResponse {
  status?: "verified" | "manual_review" | "awaiting_transfer"
  code?: string
  error?: string
  message?: string
  fieldErrors?: Partial<Record<TransferDeclarationField, string>>
  proofUploadAvailable?: boolean
  retryable?: boolean
  retryAfterSeconds?: number
  outcome?: TransferVerificationCustomerOutcome
}

/**
 * Por qué no se validó, para elegir mensaje y la acción principal:
 * not_found (todavía no apareció), not_matching (apareció pero no coincide
 * con el titular), confirming (encontrada, falta confirmar), manual_review,
 * invalid_holder (datos del paso 1 inválidos) o error técnico.
 */
type TransferVerificationFailureKind =
  | Exclude<TransferVerificationCustomerOutcome, "verified" | "stock_conflict">
  | "invalid_holder"
  | "error"

interface TransferVerificationFailure {
  kind: TransferVerificationFailureKind
  message: string
  /** El comprobante sigue disponible como salida (sólo el servidor puede negarlo). */
  proofUploadAvailable: boolean
}

type TransferFailureAction = "retry" | "upload" | "edit"

/** Acción principal primero: reintentar si todavía no apareció, corregir el titular si no coincide. */
function getTransferFailureActions(kind: TransferVerificationFailureKind): TransferFailureAction[] {
  switch (kind) {
    case "not_matching":
    case "invalid_holder":
      return ["edit", "retry", "upload"]
    case "manual_review":
      return ["upload", "retry", "edit"]
    default:
      return ["retry", "upload", "edit"]
  }
}

/**
 * "Ya realicé la transferencia" valida directamente con el titular del paso 1
 * y el importe que calculó el servidor: nunca se vuelven a pedir esos datos.
 * El servidor repite la misma validación (validateTransferDeclaration).
 */
function useTransferVerification({
  order,
  holder,
  onVerified,
  onStockConflict,
  onReservationExpired,
}: {
  order: SupabasePedido
  holder: TransferHolder | null
  onVerified: () => void
  onStockConflict: () => void
  onReservationExpired: () => void
}) {
  const [phase, setPhase] = useState<"idle" | "verifying" | "confirming">("idle")
  const [failure, setFailure] = useState<TransferVerificationFailure | null>(null)
  const [cooldownSeconds, setCooldownSeconds] = useState(0)

  useEffect(() => {
    if (cooldownSeconds <= 0) return
    const timeout = window.setTimeout(() => setCooldownSeconds((seconds) => seconds - 1), 1000)
    return () => window.clearTimeout(timeout)
  }, [cooldownSeconds])

  const fail = (
    kind: TransferVerificationFailureKind,
    message: string,
    data?: Pick<TransferVerifyResponse, "proofUploadAvailable" | "retryAfterSeconds">,
  ) => {
    setFailure({ kind, message, proofUploadAvailable: data?.proofUploadAvailable !== false })
    const wait = Number(data?.retryAfterSeconds)
    setCooldownSeconds(Number.isFinite(wait) ? Math.max(0, Math.ceil(wait)) : 0)
    setPhase("idle")
  }

  const verify = async () => {
    if (phase !== "idle" || cooldownSeconds > 0) return

    const declaration = validateTransferDeclaration({
      nombre: holder?.firstName,
      apellido: holder?.lastName,
      dni: holder?.document,
      monto: transferAmountDue(order),
    })
    if (!declaration.ok) {
      fail("invalid_holder", "Revisá los datos del titular de la cuenta desde donde transferiste.")
      return
    }

    setPhase("verifying")
    try {
      const guestToken = getGuestOrderToken(order.id)
      const response = await fetch(`/api/transferencia/${order.id}/verificar`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(guestToken ? { "x-guest-order-token": guestToken } : {}),
        },
        body: JSON.stringify({
          nombre: declaration.value.firstName,
          apellido: declaration.value.lastName,
          dni: declaration.value.document,
          monto: declaration.value.amount,
        }),
      })
      const data = (await response.json()) as TransferVerifyResponse

      // Pestaña vieja o reloj desfasado: la reserva ya venció en el servidor.
      if (data.code === "RESERVATION_EXPIRED") {
        onReservationExpired()
        return
      }
      if (response.ok && data.status === "verified") {
        setFailure(null)
        setPhase("confirming")
        // La respuesta es mínima a propósito: el padre refresca el pedido.
        onVerified()
        return
      }
      // El pago apareció pero el stock ya no alcanza: no es "no encontramos
      // tu transferencia", lo explica el paso de resultado.
      if (response.ok && data.outcome === "stock_conflict") {
        onStockConflict()
        return
      }
      if (response.status === 400 && data.fieldErrors && Object.keys(data.fieldErrors).length > 0) {
        fail("invalid_holder", Object.values(data.fieldErrors)[0] ?? "Revisá los datos del titular.", data)
        return
      }
      if (response.ok && data.outcome && data.outcome !== "verified" && data.outcome !== "stock_conflict") {
        fail(data.outcome, data.message || TRANSFER_VERIFICATION_OUTCOME_MESSAGES[data.outcome], data)
        return
      }
      fail("error", data.error || data.message || "No pudimos validar tu transferencia.", data)
    } catch {
      // La red puede fallar sin que exista ningún problema con el pago.
      fail("error", "No pudimos conectarnos para verificar tu transferencia.")
    }
  }

  return {
    verify,
    verifying: phase === "verifying",
    confirming: phase === "confirming",
    failure,
    cooldownSeconds,
    dismissFailure: () => setFailure(null),
  }
}

function TransferVerificationFailedModal({
  holder,
  failure,
  verifying,
  cooldownSeconds,
  onUploadProof,
  onRetry,
  onEditHolder,
  onClose,
}: {
  holder: TransferHolder | null
  failure: TransferVerificationFailure
  verifying: boolean
  cooldownSeconds: number
  onUploadProof: () => void
  onRetry: () => void
  onEditHolder: () => void
  onClose: () => void
}) {
  const [mounted, setMounted] = useState(false)
  const firstActionRef = useRef<HTMLButtonElement>(null)
  // Sin comprobante disponible (lo decide el servidor), esa acción no se ofrece.
  const actions = getTransferFailureActions(failure.kind).filter(
    (action) => action !== "upload" || failure.proofUploadAvailable,
  )

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    if (mounted) firstActionRef.current?.focus()
  }, [mounted])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !verifying) onClose()
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [onClose, verifying])

  if (!mounted) return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4 py-5 backdrop-blur-sm">
      <button
        type="button"
        aria-label="Cerrar"
        onClick={onClose}
        disabled={verifying}
        className="absolute inset-0 cursor-pointer disabled:cursor-default"
      />

      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="transfer-verification-failed-title"
        aria-describedby="transfer-verification-failed-message"
        data-transfer-verification-failed
        className="relative z-10 w-[min(420px,calc(100vw-32px))] rounded-2xl border border-[var(--account-warning-border)] bg-[var(--account-surface)] p-5 shadow-[0_28px_90px_rgba(0,0,0,0.6)]"
      >
        <button
          type="button"
          aria-label="Cerrar"
          onClick={onClose}
          disabled={verifying}
          className="absolute right-3 top-3 flex size-8 cursor-pointer items-center justify-center rounded-full text-[var(--account-text-secondary)] transition-colors hover:bg-[var(--account-warning-bg)] hover:text-[var(--account-text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <X className="size-4" aria-hidden="true" />
        </button>

        <div className="flex flex-col items-center text-center">
          <span className="flex size-12 items-center justify-center rounded-full border border-[var(--account-warning-border)] bg-[var(--account-warning-bg)] text-[var(--account-warning)]">
            <AlertTriangle className="size-6" aria-hidden="true" />
          </span>
          <h2
            id="transfer-verification-failed-title"
            className="mt-3 text-lg font-bold text-[var(--account-text-primary)]"
          >
            {failure.kind === "confirming" ? "Estamos confirmando tu pago" : "No pudimos validar tu transferencia"}
          </h2>
          <p
            id="transfer-verification-failed-message"
            className="mt-1.5 text-sm leading-5 text-[var(--account-text-secondary)]"
          >
            {failure.message}
          </p>
        </div>

        {holder && (
          <div className="mt-4 rounded-xl border border-[var(--account-warning-border)] bg-[var(--account-warning-bg)] px-3.5 py-2.5 text-xs leading-5 text-[var(--account-text-primary)]">
            <p className="font-bold text-[var(--account-warning)]">Titular informado</p>
            <p>
              {holder.firstName} {holder.lastName} · DNI/CUIT {holder.document}
            </p>
          </div>
        )}

        <div className="mt-5 flex flex-col gap-2.5" data-transfer-failure-kind={failure.kind}>
          {actions.map((action, index) => {
            // La primera acción es la principal; el resto, secundarias.
            const variant = index === 0 ? "primary" : index === 1 ? "outline" : "ghost"
            const ref = index === 0 ? firstActionRef : undefined
            if (action === "upload") {
              return (
                <BeyonixButton key={action} ref={ref} type="button" variant={variant} onClick={onUploadProof}
                  disabled={verifying} className="h-11 w-full">
                  <Upload className="size-4" aria-hidden="true" />
                  Subir el comprobante de pago
                </BeyonixButton>
              )
            }
            if (action === "edit") {
              return (
                <BeyonixButton key={action} ref={ref} type="button" variant={variant} onClick={onEditHolder}
                  disabled={verifying} className="h-11 w-full">
                  <UserPen className="size-4" aria-hidden="true" />
                  Cambiar datos del titular
                </BeyonixButton>
              )
            }
            return (
              <BeyonixButton key={action} ref={ref} type="button" variant={variant} onClick={onRetry}
                disabled={verifying || cooldownSeconds > 0} className="h-11 w-full">
                {verifying ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    Verificando transferencia...
                  </>
                ) : cooldownSeconds > 0 ? (
                  `Podés volver a verificar en ${cooldownSeconds} s`
                ) : (
                  <>
                    <RefreshCw className="size-4" aria-hidden="true" />
                    Volver a verificar
                  </>
                )}
              </BeyonixButton>
            )
          })}
        </div>
      </div>
    </div>,
    document.body,
  )
}

function TransferInstructionsStep({
  order,
  bankDetails,
  holder,
  onVerified,
  onStockConflict,
  onUploadProof,
  onEditHolder,
  onReservationExpired,
}: {
  order: SupabasePedido
  bankDetails: TransferBankDetails
  holder: TransferHolder | null
  onVerified: () => void
  onStockConflict: () => void
  onUploadProof: () => void
  onEditHolder: () => void
  onReservationExpired: () => void
}) {
  const [copiedField, setCopiedField] = useState<"alias" | "cvu" | null>(null)
  const copyTimerRef = useRef<number | null>(null)
  const verification = useTransferVerification({
    order,
    holder,
    onVerified,
    onStockConflict,
    onReservationExpired,
  })

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current)
    }
  }, [])

  const handleCopy = async (field: "alias" | "cvu", value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedField(field)
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current)
      copyTimerRef.current = window.setTimeout(() => setCopiedField(null), 2000)
    } catch {
      setCopiedField(null)
    }
  }

  const busy = verification.verifying || verification.confirming

  return (
    <StepCard>
      <TransferStepIndicator step={2} />

      <h1 className="text-center text-xl font-bold text-[var(--account-text-primary)] sm:text-2xl">
        Realizá la transferencia
      </h1>
      <p className="mx-auto mt-1.5 max-w-xs text-center text-sm leading-5 text-[var(--account-text-secondary)]">
        Para continuar, transferí el monto indicado a la cuenta de BEYONIX.
      </p>

      <TransferAmountBox amount={transferAmountDue(order)} />

      <div className="mt-4 divide-y divide-[var(--account-border-subtle)] rounded-xl border border-[var(--account-border-subtle)] px-4">
        <CopyableField
          label="Alias"
          value={bankDetails.alias}
          copied={copiedField === "alias"}
          onCopy={() => void handleCopy("alias", bankDetails.alias)}
        />
        <div className="py-3">
          <p className={labelClassName}>A nombre de</p>
          <p className="mt-1 text-base font-bold text-[var(--account-text-primary)]">
            {bankDetails.accountHolder}
          </p>
        </div>
        <CopyableField
          label="CVU"
          value={bankDetails.cvu}
          copied={copiedField === "cvu"}
          onCopy={() => void handleCopy("cvu", bankDetails.cvu)}
        />
      </div>

      <BeyonixButton
        type="button"
        onClick={() => void verification.verify()}
        disabled={busy || verification.cooldownSeconds > 0}
        className="mt-5 h-11 w-full"
      >
        {verification.confirming ? (
          <>
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Confirmando tu pago...
          </>
        ) : verification.verifying ? (
          <>
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Verificando transferencia...
          </>
        ) : (
          "Ya realicé la transferencia"
        )}
      </BeyonixButton>
      <p className="mt-2 text-center text-xs leading-5 text-[var(--account-text-secondary)]">
        Cuando hayas realizado la transferencia, continuá para validar el pago.{" "}
        <button
          type="button"
          onClick={onEditHolder}
          disabled={busy}
          className="cursor-pointer font-semibold underline underline-offset-2 hover:text-[var(--account-text-primary)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          Cambiar datos del titular
        </button>
      </p>

      {verification.failure && (
        <TransferVerificationFailedModal
          holder={holder}
          failure={verification.failure}
          verifying={verification.verifying}
          cooldownSeconds={verification.cooldownSeconds}
          onUploadProof={onUploadProof}
          onRetry={() => void verification.verify()}
          onEditHolder={onEditHolder}
          onClose={verification.dismissFailure}
        />
      )}
    </StepCard>
  )
}

function TransferManualReviewStep({
  order,
  onUpdated,
  onRetry,
  ordersHref,
  homeHref,
}: {
  order: SupabasePedido
  onUpdated: (order: SupabasePedido) => void
  onRetry?: () => void
  ordersHref: string
  homeHref: string
}) {
  const hasProof = Boolean(order.payment_proof_url || order.payment_proof_uploaded_at)
  const canUpload = canUploadTransferProof(order.payment_status)
  // Pago real, pero el stock ya no estaba disponible: nunca "pago rechazado".
  const stockConflict = order.payment_status === TRANSFER_STOCK_CONFLICT_PAYMENT_STATUS

  return (
    <StepCard>
      <TransferStepIndicator step={3} />

      {!hasProof ? (
        <>
          <div className="flex flex-col items-center text-center">
            <span className="flex size-12 items-center justify-center rounded-xl border border-[var(--account-warning-border)] bg-[var(--account-warning-bg)] text-[var(--account-warning)]">
              <AlertTriangle className="size-6" aria-hidden="true" />
            </span>
            <h1 className="mt-3 text-xl font-bold text-[var(--account-text-primary)]">
              {stockConflict
                ? "Recibimos tu transferencia"
                : "No pudimos validar el pago automáticamente"}
            </h1>
            <p className="mt-1.5 max-w-sm text-sm leading-5 text-[var(--account-text-secondary)]">
              {stockConflict
                ? TRANSFER_STOCK_CONFLICT_CUSTOMER_MESSAGE
                : "Podés enviarnos el comprobante de la transferencia para que nuestro equipo lo revise."}
            </p>
          </div>

          <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-[var(--account-info-border)] bg-[var(--account-info-bg)] px-3.5 py-3 text-left">
            <Clock className="mt-0.5 size-4 shrink-0 text-[var(--account-info-text)]" aria-hidden="true" />
            <p className="text-xs leading-5 text-[var(--account-info-text)]">
              <strong className="font-bold">Validamos comprobantes en horario comercial.</strong>{" "}
              Nuestro equipo revisa los pagos {BEYONIX_SUPPORT_HOURS_DETAIL.toLowerCase()}. Podés
              cargar el comprobante en cualquier momento; si lo hacés fuera de ese horario, lo
              revisamos apenas retomamos la atención.
            </p>
          </div>

          {canUpload && (
            <div className="mt-5">
              <p className="text-11px font-bold uppercase tracking-widest text-[var(--account-text-secondary)]">
                Adjuntar comprobante
              </p>
              <PaymentProofUploader orderId={order.id} onUploaded={onUpdated} expand />
            </div>
          )}

          {/* Secundario real (borde + texto con contraste en light y dark);
              antes era un link de texto casi invisible en dark. */}
          {onRetry && (
            <BeyonixButton
              type="button"
              variant="outline"
              onClick={onRetry}
              data-transfer-retry
              className="transfer-retry-button mt-4 h-11 w-full"
            >
              Corregir datos de la transferencia
            </BeyonixButton>
          )}
        </>
      ) : (
        <>
          <CustomerPaymentProof order={order} onUploaded={onUpdated} showHeading={false} expandUploader />

          {order.payment_status === "en_revision" && (
            <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-[var(--account-info-border)] bg-[var(--account-info-bg)] px-3.5 py-3 text-left">
              <Clock className="mt-0.5 size-4 shrink-0 text-[var(--account-info-text)]" aria-hidden="true" />
              <p className="text-xs leading-5 text-[var(--account-info-text)]">
                <strong className="font-bold">Validamos comprobantes en horario comercial.</strong>{" "}
                Nuestro equipo revisará el pago {BEYONIX_SUPPORT_HOURS_DETAIL.toLowerCase()}. Si
                necesitamos información adicional, nos contactaremos con vos.
              </p>
            </div>
          )}

          <div className="mt-5 grid gap-2.5 sm:grid-cols-2">
            <BeyonixButton asChild variant="outline" className="h-10">
              <Link href={homeHref}>Volver al inicio</Link>
            </BeyonixButton>
            <BeyonixButton asChild className="h-10">
              <Link href={ordersHref}>Ver estado del pedido</Link>
            </BeyonixButton>
          </div>
        </>
      )}
    </StepCard>
  )
}

function TransferVerificationSuccess({
  order,
  ordersHref,
  homeHref,
}: {
  order: SupabasePedido
  ordersHref: string
  homeHref: string
}) {
  return (
    <CheckoutStatusCard
      tone="success"
      icon={CheckCircle2}
      eyebrow="Pago confirmado"
      title="Pago verificado correctamente"
      description="Tu transferencia fue confirmada."
      compact
      footer={
        <div className="grid gap-2.5 sm:grid-cols-2">
          <BeyonixButton asChild variant="outline" className="h-10">
            <Link href={homeHref}>Volver al inicio</Link>
          </BeyonixButton>
          <BeyonixButton asChild className="h-10">
            <Link href={ordersHref}>Ir a mis compras</Link>
          </BeyonixButton>
        </div>
      }
    >
      <p className="py-2 text-center text-sm font-bold text-[var(--account-text-primary)]">
        Pedido {formatPublicOrderId(order.id)}
      </p>
      <p className="text-center text-xs text-[var(--account-text-secondary)]">
        Ya podés seguir el estado de tu compra desde tu cuenta.
      </p>
    </CheckoutStatusCard>
  )
}

function TransferFlowLoading() {
  return (
    <StepCard>
      <div className="flex flex-col items-center gap-3 py-10">
        <Loader2 className="size-6 animate-spin text-[var(--account-accent)]" aria-hidden="true" />
        <p className="text-sm font-semibold text-[var(--account-text-secondary)]">
          Cargando tu pedido...
        </p>
      </div>
    </StepCard>
  )
}

function TransferFlowMessage({
  tone,
  icon: Icon,
  title,
  description,
  action,
}: {
  tone: "failure" | "info"
  icon: typeof AlertTriangle
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <StepCard>
      <div className="flex flex-col items-center gap-2 py-6 text-center">
        <span
          className={`flex size-11 items-center justify-center rounded-xl border ${
            tone === "failure"
              ? "border-[var(--account-danger-border)] bg-[var(--account-danger-bg)] text-[var(--account-danger)]"
              : "border-[var(--account-accent)] bg-[var(--account-accent)] text-white"
          }`}
        >
          <Icon className="size-5" aria-hidden="true" />
        </span>
        <h2 className="text-base font-bold text-[var(--account-text-primary)]">{title}</h2>
        <p className="max-w-sm text-sm leading-5 text-[var(--account-text-secondary)]">
          {description}
        </p>
        {action}
      </div>
    </StepCard>
  )
}

function TransferReservationCountdown({ seconds }: { seconds: number }) {
  return (
    <div
      data-transfer-reservation-countdown
      className="mb-3 flex items-center gap-3 rounded-xl border border-[var(--account-info-border)] bg-[var(--account-info-bg)] px-3.5 py-3 text-left"
    >
      <Clock className="size-5 shrink-0 text-[var(--account-info-text)]" aria-hidden="true" />
      <div className="min-w-0 flex-1 text-xs leading-5 text-[var(--account-info-text)]">
        <p className="font-bold">Tus productos están reservados durante este tiempo.</p>
        <p>Realizá la transferencia antes de que finalice el contador.</p>
      </div>
      <span
        role="timer"
        aria-label={`Tiempo restante de la reserva: ${formatReservationCountdown(seconds)}`}
        className="shrink-0 text-xl font-extrabold tabular-nums text-[var(--account-info-text)]"
      >
        {formatReservationCountdown(seconds)}
      </span>
    </div>
  )
}

/**
 * La reserva de 20 minutos venció sin un pago confirmado: se bloquea el flujo
 * normal y se vuelve al inicio. El carrito no se toca (el cliente puede
 * iniciar una compra nueva y competir otra vez por el stock).
 */
function TransferReservationExpired({ homeHref }: { homeHref: string }) {
  const router = useRouter()

  useEffect(() => {
    const timer = window.setTimeout(() => router.replace(homeHref), RESERVATION_EXPIRED_REDIRECT_MS)
    return () => window.clearTimeout(timer)
  }, [router, homeHref])

  return (
    <div role="alert" data-transfer-reservation-expired>
      <TransferFlowMessage
        tone="info"
        icon={Clock}
        title="Tu reserva venció."
        description="Pasaron los 20 minutos disponibles para completar la compra y liberamos los productos reservados."
        action={
          <p className="mt-1 text-xs text-[var(--account-text-secondary)]">
            Te estamos llevando al inicio.
          </p>
        }
      />
    </div>
  )
}

function TransferStepFlow({
  order,
  reservation,
  bankTransfer,
  onUpdated,
  ordersHref,
  homeHref,
}: {
  order: SupabasePedido
  reservation: TransferReservationClock | null
  bankTransfer: TransferBankDetails | null
  onUpdated: (order: SupabasePedido) => void
  ordersHref: string
  homeHref: string
}) {
  const hasProof = Boolean(order.payment_proof_url || order.payment_proof_uploaded_at)
  const alreadyResolved = !TRANSFER_ELIGIBLE_PAYMENT_STATUSES.includes(
    order.payment_status ?? "pendiente_comprobante",
  )
  const previousAttemptFailed = order.transfer_verification_status === "manual_review"
  // Sólo el flujo normal (esperando la transferencia) depende de la reserva:
  // un comprobante ya enviado o un pago detectado siguen su propio circuito.
  const awaitingPayment = isAwaitingTransferPayment(order)

  // Alias/CVU sólo llegan del servidor después de guardar los datos del
  // titular (o si ya estaban guardados al recargar la pantalla).
  const [bankDetails, setBankDetails] = useState<TransferBankDetails | null>(bankTransfer)
  // Titular del paso 1 (o el ya guardado al recargar): es lo que se valida al
  // tocar "Ya realicé la transferencia", sin volver a pedirlo.
  const [holder, setHolder] = useState<TransferHolder | null>(() =>
    order.transfer_payer_first_name && order.transfer_payer_last_name && order.transfer_payer_dni
      ? {
          firstName: order.transfer_payer_first_name,
          lastName: order.transfer_payer_last_name,
          document: order.transfer_payer_dni,
        }
      : null,
  )
  const [step, setStep] = useState<"holder" | "instructions" | "review">(() =>
    hasProof || alreadyResolved || previousAttemptFailed
      ? "review"
      : bankTransfer
        ? "instructions"
        : "holder",
  )
  // Mismo expires_at del servidor en cada render, refresh o pestaña: el
  // contador se deriva de él y nunca se reinicia localmente.
  const [reservationSeconds, setReservationSeconds] = useState(() =>
    transferReservationSecondsLeft(reservation, reservation?.receivedAt ?? 0),
  )
  const [rejectedAsExpired, setRejectedAsExpired] = useState(false)

  useEffect(() => {
    if (!awaitingPayment) return
    const tick = () => setReservationSeconds(transferReservationSecondsLeft(reservation, performance.now()))
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [awaitingPayment, reservation])

  if (awaitingPayment && (rejectedAsExpired || reservationSeconds === 0)) {
    return <TransferReservationExpired homeHref={homeHref} />
  }

  const countdown = awaitingPayment ? (
    <TransferReservationCountdown seconds={reservationSeconds} />
  ) : null
  const effectiveStep = hasProof || alreadyResolved ? "review" : step

  if (effectiveStep === "review") {
    const canRetry = !hasProof && !alreadyResolved

    return (
      <>
        {countdown}
        <TransferManualReviewStep
          order={order}
          onUpdated={onUpdated}
          onRetry={canRetry ? () => setStep("holder") : undefined}
          ordersHref={ordersHref}
          homeHref={homeHref}
        />
      </>
    )
  }

  if (effectiveStep === "instructions" && bankDetails) {
    return (
      <>
        {countdown}
        <TransferInstructionsStep
          order={order}
          bankDetails={bankDetails}
          holder={holder}
          // El padre refresca el pedido: confirmado -> pantalla de pago verificado.
          onVerified={() => onUpdated(order)}
          onStockConflict={() => {
            onUpdated(order)
            setStep("review")
          }}
          onUploadProof={() => setStep("review")}
          onEditHolder={() => setStep("holder")}
          onReservationExpired={() => setRejectedAsExpired(true)}
        />
      </>
    )
  }

  return (
    <>
      {countdown}
      <TransferHolderStep
        order={order}
        onSaved={(details, savedHolder) => {
          setBankDetails(details)
          setHolder(savedHolder)
          setStep("instructions")
          // Refresca el pedido (datos del titular guardados en el servidor).
          onUpdated(order)
        }}
        onReservationExpired={() => setRejectedAsExpired(true)}
      />
    </>
  )
}

export function TransferFlow({
  orderLoading,
  sessionExpired,
  orderError,
  order,
  reservation,
  bankTransfer,
  paymentConfirmed,
  onUpdated,
  loginHref,
  ordersHref,
  homeHref,
}: {
  orderLoading: boolean
  sessionExpired: boolean
  orderError: string
  order: SupabasePedido | null
  reservation: TransferReservationClock | null
  bankTransfer: TransferBankDetails | null
  paymentConfirmed: boolean
  onUpdated: (order: SupabasePedido) => void
  loginHref: string
  ordersHref: string
  homeHref: string
}) {
  return (
    <div className="mx-auto w-full max-w-md" id="comprobante-pago">
      {orderLoading ? (
        <TransferFlowLoading />
      ) : sessionExpired ? (
        <TransferFlowMessage
          tone="info"
          icon={LogIn}
          title="Tu sesión expiró"
          description="Para continuar con este pedido, iniciá sesión nuevamente."
          action={
            <BeyonixButton asChild size="sm" className="mt-2 h-9 px-4 text-xs">
              <Link href={loginHref}>
                <LogIn className="size-4" aria-hidden="true" />
                Iniciar sesión y continuar
              </Link>
            </BeyonixButton>
          }
        />
      ) : orderError ? (
        <TransferFlowMessage tone="failure" icon={AlertTriangle} title="No pudimos cargar tu pedido" description={orderError} />
      ) : !order ? (
        <TransferFlowMessage
          tone="failure"
          icon={AlertTriangle}
          title="No pudimos identificar el pedido"
          description="Revisalo desde tu cuenta para continuar con el pago."
        />
      ) : paymentConfirmed ? (
        <TransferVerificationSuccess order={order} ordersHref={ordersHref} homeHref={homeHref} />
      ) : (
        <TransferStepFlow
          order={order}
          reservation={reservation}
          bankTransfer={bankTransfer}
          onUpdated={onUpdated}
          ordersHref={ordersHref}
          homeHref={homeHref}
        />
      )}
    </div>
  )
}
