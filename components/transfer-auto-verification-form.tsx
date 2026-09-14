"use client"

import { useState } from "react"
import { AlertTriangle, CheckCircle2, Loader2, ShieldCheck } from "lucide-react"

import { BeyonixButton } from "@/components/beyonix-ui"
import { CustomerPaymentProof } from "@/components/customer-payment-proof"
import { getGuestOrderToken } from "@/lib/orders/guest-order-token-client"
import type { SupabasePedido } from "@/lib/supabase/types"

interface VerifyResponse {
  status?: "verified" | "manual_review"
  order?: SupabasePedido
  error?: string
  message?: string
}

const inputClassName =
  "h-10 w-full rounded-lg border border-[var(--account-border)] bg-[var(--account-surface)] px-3 text-sm text-[var(--account-text-primary)] outline-none transition-colors placeholder:text-[var(--account-text-muted)] focus:border-[var(--account-accent)]"
const labelClassName =
  "text-11px font-semibold uppercase tracking-wider text-[var(--account-text-secondary)]"

export function TransferPaymentSection({
  order,
  onUpdated,
}: {
  order: SupabasePedido
  onUpdated: (updatedOrder: SupabasePedido) => void
}) {
  const hasProof = Boolean(order.payment_proof_url || order.payment_proof_uploaded_at)
  const alreadyResolved = !["pendiente_comprobante", "en_revision"].includes(
    order.payment_status ?? "pendiente_comprobante",
  )

  if (hasProof || alreadyResolved) {
    return (
      <CustomerPaymentProof order={order} onUploaded={onUpdated} showHeading={false} expandUploader />
    )
  }

  return <TransferAutoVerificationForm order={order} onUpdated={onUpdated} />
}

function TransferAutoVerificationForm({
  order,
  onUpdated,
}: {
  order: SupabasePedido
  onUpdated: (updatedOrder: SupabasePedido) => void
}) {
  const [firstName, setFirstName] = useState(order.transfer_payer_first_name ?? "")
  const [lastName, setLastName] = useState(order.transfer_payer_last_name ?? "")
  const [dni, setDni] = useState(order.transfer_payer_dni ?? "")
  const [amount, setAmount] = useState(
    String(order.transfer_amount_declared ?? order.total ?? ""),
  )
  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState("")
  const [manualReviewActive, setManualReviewActive] = useState(
    order.transfer_verification_status === "manual_review",
  )

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (submitting) return

    setSubmitting(true)
    setErrorMessage("")

    try {
      const guestToken = getGuestOrderToken(order.id)
      const response = await fetch(`/api/transferencia/${order.id}/verificar`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(guestToken ? { "x-guest-order-token": guestToken } : {}),
        },
        body: JSON.stringify({
          nombre: firstName,
          apellido: lastName,
          dni,
          monto: Number(amount),
        }),
      })

      const data = (await response.json()) as VerifyResponse

      if (!response.ok) {
        setErrorMessage(data.error || "No pudimos verificar tu transferencia.")
        return
      }

      if (data.status === "verified" && data.order) {
        onUpdated(data.order)
        return
      }

      if (data.status === "manual_review") {
        setManualReviewActive(true)
        if (data.order) onUpdated(data.order)
        return
      }

      setErrorMessage("No pudimos verificar tu transferencia.")
    } catch {
      setErrorMessage("No pudimos verificar tu transferencia. Intentá nuevamente.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-[var(--account-accent)]" aria-hidden="true" />
          <p className="text-sm font-bold text-[var(--account-text-primary)]">
            Verificar transferencia
          </p>
        </div>
        <p className="text-xs leading-5 text-[var(--account-text-secondary)]">
          Completá estos datos con los que usaste al transferir y confirmamos tu pago automáticamente.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelClassName} htmlFor="transfer-verify-nombre">
              Nombre
            </label>
            <input
              id="transfer-verify-nombre"
              className={`${inputClassName} mt-1`}
              value={firstName}
              onChange={(event) => setFirstName(event.target.value)}
              required
              maxLength={200}
              disabled={submitting}
            />
          </div>
          <div>
            <label className={labelClassName} htmlFor="transfer-verify-apellido">
              Apellido
            </label>
            <input
              id="transfer-verify-apellido"
              className={`${inputClassName} mt-1`}
              value={lastName}
              onChange={(event) => setLastName(event.target.value)}
              required
              maxLength={200}
              disabled={submitting}
            />
          </div>
          <div>
            <label className={labelClassName} htmlFor="transfer-verify-dni">
              DNI
            </label>
            <input
              id="transfer-verify-dni"
              className={`${inputClassName} mt-1`}
              value={dni}
              onChange={(event) => setDni(event.target.value)}
              required
              inputMode="numeric"
              maxLength={10}
              disabled={submitting}
            />
          </div>
          <div>
            <label className={labelClassName} htmlFor="transfer-verify-monto">
              Monto transferido
            </label>
            <input
              id="transfer-verify-monto"
              className={`${inputClassName} mt-1`}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              required
              inputMode="decimal"
              disabled={submitting}
            />
          </div>
        </div>

        {errorMessage && (
          <p className="text-xs font-medium text-[var(--account-danger)]">{errorMessage}</p>
        )}

        <BeyonixButton type="submit" size="sm" className="h-10" disabled={submitting}>
          {submitting ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Estamos verificando tu transferencia...
            </>
          ) : (
            <>
              <CheckCircle2 className="size-4" aria-hidden="true" />
              Verificar transferencia
            </>
          )}
        </BeyonixButton>
      </form>

      {manualReviewActive && (
        <div className="flex flex-col gap-3 border-t border-[var(--account-border-subtle)] pt-3">
          <div className="flex items-start gap-2 rounded-lg border border-[var(--account-warning-border)] bg-[var(--account-warning-bg)] px-3 py-2.5">
            <AlertTriangle
              className="mt-0.5 size-4 shrink-0 text-[var(--account-warning)]"
              aria-hidden="true"
            />
            <div>
              <p className="text-xs font-bold text-[var(--account-text-primary)]">
                No pudimos validar tu transferencia automáticamente.
              </p>
              <p className="mt-0.5 text-xs leading-5 text-[var(--account-text-secondary)]">
                Podés adjuntar el comprobante para que nuestro equipo lo revise.
              </p>
            </div>
          </div>

          <CustomerPaymentProof order={order} onUploaded={onUpdated} showHeading={false} />
        </div>
      )}
    </div>
  )
}
