"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import Link from "next/link"
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Loader2,
  LogIn,
} from "lucide-react"

import { BeyonixButton } from "@/components/beyonix-ui"
import { CheckoutStatusCard } from "@/components/checkout/checkout-status-layout"
import { CustomerPaymentProof } from "@/components/customer-payment-proof"
import { PaymentProofUploader } from "@/components/payment-proof-uploader"
import { getGuestOrderToken } from "@/lib/orders/guest-order-token-client"
import { canUploadTransferProof } from "@/lib/orders/transfer-verification-reasons"
import { formatPublicOrderId } from "@/lib/account/account-formatters"
import { BEYONIX_SUPPORT_HOURS_DETAIL } from "@/lib/legal-contact"
import {
  TRANSFER_ACCOUNT_HOLDER,
  TRANSFER_ALIAS,
  TRANSFER_CVU,
} from "@/lib/payments/transfer"
import {
  TRANSFER_HOLDER_NAME_MAX_LENGTH,
  validateTransferDeclaration,
  type TransferDeclarationField,
} from "@/lib/payments/transfer-declaration"
import type { SupabasePedido } from "@/lib/supabase/types"

const TRANSFER_ELIGIBLE_PAYMENT_STATUSES = ["pendiente_comprobante", "en_revision"]

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

function TransferStepIndicator({ step }: { step: 1 | 2 | 3 }) {
  const stepLabel = step === 1 ? "Transferencia" : step === 2 ? "Validación" : "Resultado"

  return (
    <div
      role="status"
      aria-label={`Paso ${step} de 3: ${stepLabel}`}
      className="mb-4 flex flex-col items-center gap-1.5"
    >
      <div className="flex items-center gap-1.5" aria-hidden="true">
        {[1, 2, 3].map((dot) => (
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
        Paso {step} de 3 · {stepLabel}
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
  hint,
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
  hint: string
  value: string
  onChange: (value: string) => void
  error?: string
  inputMode?: "numeric" | "decimal"
  maxLength?: number
  autoComplete?: string
  disabled: boolean
}) {
  const hintId = `${id}-hint`
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
        aria-describedby={error ? `${hintId} ${errorId}` : hintId}
        inputMode={inputMode}
        maxLength={maxLength}
        autoComplete={autoComplete}
        disabled={disabled}
      />
      <p id={hintId} className="mt-1 text-xs leading-4 text-[var(--account-text-secondary)]">
        {hint}
      </p>
      {error && (
        <p id={errorId} role="alert" className="mt-1 text-xs font-medium text-[var(--account-danger)]">
          {error}
        </p>
      )}
    </div>
  )
}

function TransferInstructionsStep({
  order,
  onContinue,
}: {
  order: SupabasePedido
  onContinue: () => void
}) {
  const [copiedField, setCopiedField] = useState<"alias" | "cvu" | null>(null)
  const copyTimerRef = useRef<number | null>(null)

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

  return (
    <StepCard>
      <TransferStepIndicator step={1} />

      <h1 className="text-center text-xl font-bold text-[var(--account-text-primary)] sm:text-2xl">
        Realizá la transferencia
      </h1>
      <p className="mx-auto mt-1.5 max-w-xs text-center text-sm leading-5 text-[var(--account-text-secondary)]">
        Para continuar, transferí el monto indicado a la cuenta de BEYONIX.
      </p>

      <div className="mt-5 flex flex-col items-center gap-1 rounded-xl border border-[var(--account-success-border)] bg-[var(--account-success-bg)] px-4 py-4 text-center">
        <p className="text-11px font-bold uppercase tracking-wider text-[var(--account-success)]">
          Monto a transferir
        </p>
        <p className="flex items-baseline gap-1 text-[var(--account-success)]">
          <span className="text-xl font-bold">$</span>
          <span className="text-3xl font-extrabold tracking-tight tabular-nums sm:text-4xl">
            {formatPriceNumber(Number(order.total))}
          </span>
        </p>
      </div>

      <div className="mt-4 divide-y divide-[var(--account-border-subtle)] rounded-xl border border-[var(--account-border-subtle)] px-4">
        <CopyableField
          label="Alias"
          value={TRANSFER_ALIAS.toUpperCase()}
          copied={copiedField === "alias"}
          onCopy={() => void handleCopy("alias", TRANSFER_ALIAS.toUpperCase())}
        />
        <div className="py-3">
          <p className={labelClassName}>A nombre de</p>
          <p className="mt-1 text-base font-bold text-[var(--account-text-primary)]">
            {TRANSFER_ACCOUNT_HOLDER}
          </p>
        </div>
        <CopyableField
          label="CVU"
          value={TRANSFER_CVU}
          copied={copiedField === "cvu"}
          onCopy={() => void handleCopy("cvu", TRANSFER_CVU)}
        />
      </div>

      <BeyonixButton type="button" onClick={onContinue} className="mt-5 h-11 w-full">
        Ya realicé la transferencia
      </BeyonixButton>
      <p className="mt-2 text-center text-xs leading-5 text-[var(--account-text-secondary)]">
        Cuando hayas realizado la transferencia, continuá para validar el pago.
      </p>
    </StepCard>
  )
}

function TransferVerificationStep({
  order,
  onBack,
  onUpdated,
  onManualReview,
}: {
  order: SupabasePedido
  onBack: () => void
  onUpdated: (order: SupabasePedido) => void
  onManualReview: () => void
}) {
  const [firstName, setFirstName] = useState(order.transfer_payer_first_name ?? "")
  const [lastName, setLastName] = useState(order.transfer_payer_last_name ?? "")
  const [dni, setDni] = useState(order.transfer_payer_dni ?? "")
  const [amount, setAmount] = useState(
    String(order.transfer_amount_declared ?? order.total ?? ""),
  )
  const [phase, setPhase] = useState<"idle" | "submitting" | "confirming">("idle")
  const [errorMessage, setErrorMessage] = useState("")
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<TransferDeclarationField, string>>
  >({})

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (phase !== "idle") return

    // Misma validación que el servidor (lib/payments/transfer-declaration.ts):
    // los 4 datos del titular son obligatorios.
    const declaration = validateTransferDeclaration({
      nombre: firstName,
      apellido: lastName,
      dni,
      monto: amount,
    })
    if (!declaration.ok) {
      setFieldErrors(declaration.errors)
      setErrorMessage("")
      return
    }

    setFieldErrors({})
    setPhase("submitting")
    setErrorMessage("")

    try {
      const guestToken = getGuestOrderToken(order.id)
      const response = await fetch(`/api/transferencia/${order.id}/verificar`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(guestToken ? { "x-guest-order-token": guestToken } : {}),
        },
        // Valores ya normalizados; el monto viaja como texto para que el
        // servidor lo lea con el mismo parser es-AR ("1.500,50").
        body: JSON.stringify({
          nombre: declaration.value.firstName,
          apellido: declaration.value.lastName,
          dni: declaration.value.document,
          monto: amount,
        }),
      })

      const data = (await response.json()) as {
        status?: "verified" | "manual_review"
        error?: string
        fieldErrors?: Partial<Record<TransferDeclarationField, string>>
        proofUploadAvailable?: boolean
      }

      if (!response.ok) {
        // Error de validación del servidor: el cliente corrige en el mismo
        // formulario (no es un fallo técnico).
        if (response.status === 400 && data.fieldErrors && Object.keys(data.fieldErrors).length > 0) {
          setFieldErrors(data.fieldErrors)
          setPhase("idle")
          return
        }
        setErrorMessage(data.error || "No pudimos verificar tu transferencia.")
        // Un fallo técnico (rate limit, verificación en curso, error
        // inesperado del backend o de Mercado Pago) nunca debe dejar al
        // cliente sin salida: mientras el pago no esté confirmado, el
        // comprobante sigue disponible como alternativa segura.
        if (data.proofUploadAvailable) {
          onUpdated(order)
          onManualReview()
          return
        }
        setPhase("idle")
        return
      }

      if (data.status === "verified") {
        setPhase("confirming")
        // La respuesta del backend es mínima a propósito -- el padre
        // refresca el pedido desde su propio endpoint seguro.
        onUpdated(order)
        return
      }

      onUpdated(order)
      onManualReview()
    } catch {
      // Fallo de red / excepción inesperada: mismo criterio, nunca bloquea.
      onUpdated(order)
      onManualReview()
    }
  }

  if (phase === "confirming") {
    return (
      <StepCard>
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <Loader2 className="size-7 animate-spin text-[var(--account-accent)]" aria-hidden="true" />
          <p className="text-sm font-semibold text-[var(--account-text-primary)]">
            Confirmando tu pago...
          </p>
        </div>
      </StepCard>
    )
  }

  const submitting = phase === "submitting"

  return (
    <StepCard>
      <TransferStepIndicator step={2} />

      <h1 className="text-center text-xl font-bold text-[var(--account-text-primary)] sm:text-2xl">
        Validá tu transferencia
      </h1>
      <p className="mx-auto mt-1.5 max-w-sm text-center text-sm leading-5 text-[var(--account-text-secondary)]">
        Completá los datos del <strong className="font-semibold text-[var(--account-text-primary)]">titular de la cuenta desde donde salió el dinero</strong>{" "}
        para que podamos verificar el pago.
      </p>

      <div
        data-transfer-holder-notice
        className="mt-4 flex items-start gap-2.5 rounded-xl border border-[var(--account-info-border)] bg-[var(--account-info-bg)] px-3.5 py-3 text-left"
      >
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--account-info-text)]" aria-hidden="true" />
        <p className="text-xs leading-5 text-[var(--account-info-text)]">
          <strong className="font-bold">Estos datos pueden ser distintos a los de la persona que realizó la compra.</strong>{" "}
          Si otra persona transfirió desde su cuenta, ingresá los datos de esa persona.
        </p>
      </div>

      <form onSubmit={handleSubmit} noValidate className="mt-4 flex flex-col gap-3.5">
        <TransferDeclarationInput
          id="transfer-verify-nombre"
          label="Nombre/s del titular"
          hint="Podés ingresar uno o todos sus nombres, como figuran en la cuenta desde donde transferiste (ej.: Romina Ayelen)."
          value={firstName}
          onChange={setFirstName}
          error={fieldErrors.firstName}
          autoComplete="off"
          maxLength={TRANSFER_HOLDER_NAME_MAX_LENGTH}
          disabled={submitting}
        />
        <TransferDeclarationInput
          id="transfer-verify-apellido"
          label="Apellido/s del titular"
          hint="Apellido/s de la persona titular de esa cuenta (ej.: Pérez)."
          value={lastName}
          onChange={setLastName}
          error={fieldErrors.lastName}
          autoComplete="off"
          maxLength={TRANSFER_HOLDER_NAME_MAX_LENGTH}
          disabled={submitting}
        />
        <TransferDeclarationInput
          id="transfer-verify-dni"
          label="DNI/CUIT del titular"
          hint="Ingresá el documento del titular de la cuenta desde donde se realizó la transferencia."
          value={dni}
          onChange={setDni}
          error={fieldErrors.document}
          inputMode="numeric"
          maxLength={13}
          disabled={submitting}
        />
        <TransferDeclarationInput
          id="transfer-verify-monto"
          label="Monto exacto transferido"
          hint="Ingresá exactamente el importe enviado."
          value={amount}
          onChange={setAmount}
          error={fieldErrors.amount}
          inputMode="decimal"
          disabled={submitting}
        />

        {errorMessage && (
          <p className="text-xs font-medium text-[var(--account-danger)]">{errorMessage}</p>
        )}

        <div className="mt-1 flex flex-col-reverse gap-2 sm:flex-row">
          <BeyonixButton
            type="button"
            variant="outline"
            onClick={onBack}
            disabled={submitting}
            className="h-11 sm:flex-1"
          >
            Volver
          </BeyonixButton>
          <BeyonixButton type="submit" disabled={submitting} className="h-11 sm:flex-[2]">
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Verificando transferencia...
              </>
            ) : (
              "Verificar transferencia"
            )}
          </BeyonixButton>
        </div>
      </form>
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
              No pudimos validar el pago automáticamente
            </h1>
            <p className="mt-1.5 max-w-sm text-sm leading-5 text-[var(--account-text-secondary)]">
              Podés enviarnos el comprobante de la transferencia para que nuestro equipo lo revise.
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

function TransferStepFlow({
  order,
  onUpdated,
  ordersHref,
  homeHref,
}: {
  order: SupabasePedido
  onUpdated: (order: SupabasePedido) => void
  ordersHref: string
  homeHref: string
}) {
  const hasProof = Boolean(order.payment_proof_url || order.payment_proof_uploaded_at)
  const alreadyResolved = !TRANSFER_ELIGIBLE_PAYMENT_STATUSES.includes(
    order.payment_status ?? "pendiente_comprobante",
  )
  const previousAttemptFailed = order.transfer_verification_status === "manual_review"

  const [step, setStep] = useState<"instructions" | "verify" | "review">(() =>
    hasProof || alreadyResolved || previousAttemptFailed ? "review" : "instructions",
  )

  const effectiveStep = hasProof || alreadyResolved ? "review" : step

  if (effectiveStep === "review") {
    const canRetry = !hasProof && !alreadyResolved

    return (
      <TransferManualReviewStep
        order={order}
        onUpdated={onUpdated}
        onRetry={canRetry ? () => setStep("verify") : undefined}
        ordersHref={ordersHref}
        homeHref={homeHref}
      />
    )
  }

  if (effectiveStep === "verify") {
    return (
      <TransferVerificationStep
        order={order}
        onBack={() => setStep("instructions")}
        onUpdated={onUpdated}
        onManualReview={() => setStep("review")}
      />
    )
  }

  return (
    <TransferInstructionsStep
      order={order}
      onContinue={() => setStep("verify")}
    />
  )
}

export function TransferFlow({
  orderLoading,
  sessionExpired,
  orderError,
  order,
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
          onUpdated={onUpdated}
          ordersHref={ordersHref}
          homeHref={homeHref}
        />
      )}
    </div>
  )
}
