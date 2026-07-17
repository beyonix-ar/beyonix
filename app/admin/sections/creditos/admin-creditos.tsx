"use client"

import { useState } from "react"
import { ArrowDownCircle, ArrowUpCircle, Loader2, RotateCcw, Search } from "lucide-react"

import { supabase } from "@/lib/supabase/client"
import {
  formatARS,
  normalizeMoney,
  type CustomerCreditMovement,
} from "@/lib/customer-credit"
import { cn } from "@/lib/utils"

interface CreditProfile {
  id: string
  email?: string | null
  username?: string | null
  nombre?: string | null
}

function formatMovementDate(value: string) {
  return new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value))
}

function isPositiveMovement(movement: CustomerCreditMovement) {
  return (
    movement.movement_type === "credit" ||
    movement.movement_type === "reversal" ||
    movement.movement_type === "adjustment"
  )
}

function getMovementLabel(type: CustomerCreditMovement["movement_type"]) {
  const labels: Record<CustomerCreditMovement["movement_type"], string> = {
    credit: "Crédito",
    debit: "Débito",
    reversal: "Reversión",
    adjustment: "Ajuste",
    expiration: "Vencimiento",
  }

  return labels[type] ?? type
}

export function AdminCreditos() {
  const [query, setQuery] = useState("")
  const [profile, setProfile] = useState<CreditProfile | null>(null)
  const [balance, setBalance] = useState(0)
  const [movements, setMovements] = useState<CustomerCreditMovement[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [amount, setAmount] = useState("")
  const [description, setDescription] = useState("")
  const [movementType, setMovementType] = useState<"credit" | "debit">("credit")
  const [orderId, setOrderId] = useState("")
  const [claimId, setClaimId] = useState("")
  const [creditNoteId, setCreditNoteId] = useState("")

  async function getAccessToken() {
    const {
      data: { session },
    } = await supabase.auth.getSession()

    if (!session?.access_token) {
      throw new Error("No se pudo validar la sesión.")
    }

    return session.access_token
  }

  async function loadCustomer(searchQuery = query) {
    const trimmedQuery = searchQuery.trim()

    if (!trimmedQuery) {
      setMessage({ ok: false, text: "Buscá por email, usuario o nombre." })
      return
    }

    setLoading(true)
    setMessage(null)

    try {
      const token = await getAccessToken()
      const response = await fetch(
        `/api/admin/customer-credit?q=${encodeURIComponent(trimmedQuery)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          cache: "no-store",
        }
      )
      const data = (await response.json()) as {
        profile?: CreditProfile | null
        balance?: number
        movements?: CustomerCreditMovement[]
        error?: string
      }

      if (!response.ok) {
        throw new Error(data.error || "No se pudo consultar el saldo.")
      }

      setProfile(data.profile ?? null)
      setBalance(Number(data.balance ?? 0))
      setMovements(data.movements ?? [])
    } catch (error) {
      setMessage({
        ok: false,
        text:
          error instanceof Error
            ? error.message
            : "No se pudo consultar el saldo.",
      })
    } finally {
      setLoading(false)
    }
  }

  async function submitMovement() {
    if (!profile) return

    const parsedAmount = normalizeMoney(amount)

    if (parsedAmount <= 0) {
      setMessage({ ok: false, text: "Ingresá un monto mayor a cero." })
      return
    }

    if (description.trim().length < 3) {
      setMessage({ ok: false, text: "Ingresá una descripción." })
      return
    }

    setSaving(true)
    setMessage(null)

    try {
      const token = await getAccessToken()
      const response = await fetch("/api/admin/customer-credit", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "issue",
          userId: profile.id,
          movementType,
          amount: parsedAmount,
          description,
          orderId: orderId.trim() || null,
          claimId: claimId.trim() || null,
          creditNoteId: creditNoteId.trim() || null,
        }),
      })
      const data = (await response.json()) as {
        balance?: number
        movements?: CustomerCreditMovement[]
        error?: string
      }

      if (!response.ok) {
        throw new Error(data.error || "No se pudo registrar el movimiento.")
      }

      setBalance(Number(data.balance ?? 0))
      setMovements(data.movements ?? [])
      setAmount("")
      setDescription("")
      setOrderId("")
      setClaimId("")
      setCreditNoteId("")
      setMessage({ ok: true, text: "Movimiento registrado." })
    } catch (error) {
      setMessage({
        ok: false,
        text:
          error instanceof Error
            ? error.message
            : "No se pudo registrar el movimiento.",
      })
    } finally {
      setSaving(false)
    }
  }

  async function reverseMovement(movement: CustomerCreditMovement) {
    if (!profile || saving) return

    setSaving(true)
    setMessage(null)

    try {
      const token = await getAccessToken()
      const response = await fetch("/api/admin/customer-credit", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "reverse",
          movementId: movement.id,
        }),
      })
      const data = (await response.json()) as {
        balance?: number
        movements?: CustomerCreditMovement[]
        error?: string
      }

      if (!response.ok) {
        throw new Error(data.error || "No se pudo reversar el movimiento.")
      }

      setBalance(Number(data.balance ?? 0))
      setMovements(data.movements ?? [])
      setMessage({ ok: true, text: "Movimiento reversado." })
    } catch (error) {
      setMessage({
        ok: false,
        text:
          error instanceof Error
            ? error.message
            : "No se pudo reversar el movimiento.",
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5">
      <header className="rounded-2xl border border-beyonix-blue-light/16 bg-[#0B1118] p-5 shadow-2xl shadow-black/35">
        <p className="text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
          Saldos a favor
        </p>
        <h2 className="mt-1 text-2xl font-black text-white">
          Crédito interno de clientes
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-white/58">
          Consultá el libro de movimientos, emití crédito o registrá débitos manuales.
        </p>
      </header>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(320px,0.55fr)]">
        <div className="rounded-2xl border border-beyonix-blue-light/16 bg-[#0B1118] p-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <label className="min-w-0 flex-1">
              <span className="mb-1 block text-10px font-bold uppercase tracking-widest text-white/45">
                Cliente
              </span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void loadCustomer()
                }}
                placeholder="Email, usuario o nombre"
                className="h-11 w-full rounded-xl border border-beyonix-blue-light/18 bg-[#10151C] px-3 text-sm font-semibold text-white outline-none placeholder:text-white/35 focus:border-beyonix-blue-light/65"
              />
            </label>
            <button
              type="button"
              disabled={loading}
              onClick={() => void loadCustomer()}
              className="mt-auto inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border border-beyonix-blue-light/40 bg-[#112A43] px-4 text-sm font-black text-white transition hover:border-beyonix-blue-light/70 hover:bg-[#183B5E] disabled:cursor-not-allowed disabled:opacity-55"
            >
              {loading ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
              Buscar
            </button>
          </div>

          {message && (
            <p
              className={cn(
                "mt-3 rounded-xl border px-3 py-2 text-xs font-bold",
                message.ok
                  ? "border-emerald-300/25 bg-emerald-400/10 text-emerald-100"
                  : "border-red-300/25 bg-red-500/10 text-red-100"
              )}
            >
              {message.text}
            </p>
          )}

          {profile && (
            <div className="mt-4 rounded-2xl border border-beyonix-blue-light/14 bg-[#10151C] p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-black text-white">
                    {profile.nombre ?? profile.username ?? profile.email}
                  </p>
                  <p className="mt-1 text-xs text-white/50">
                    {profile.email ?? profile.username ?? profile.id}
                  </p>
                </div>
                <div className="rounded-xl border border-emerald-300/25 bg-emerald-400/10 px-3.5 py-2 text-right">
                  <p className="text-10px font-black uppercase tracking-widest text-emerald-100/70">
                    Saldo
                  </p>
                  <p className="mt-0.5 text-xl font-black text-white">
                    {formatARS(balance)}
                  </p>
                </div>
              </div>

              <div className="mt-4 space-y-2">
                {movements.length > 0 ? (
                  movements.map((movement) => {
                    const positive = isPositiveMovement(movement)

                    return (
                      <div
                        key={movement.id}
                        className="grid gap-3 rounded-xl border border-white/8 bg-black/20 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center"
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-10px font-black uppercase tracking-widest text-white/60">
                              {getMovementLabel(movement.movement_type)}
                            </span>
                            {movement.order_id && (
                              <span className="text-xs font-semibold text-white/42">
                                BX-{1000 + movement.order_id}
                              </span>
                            )}
                            {movement.claim_id && (
                              <span className="text-xs font-semibold text-white/42">
                                Reclamo #{movement.claim_id}
                              </span>
                            )}
                          </div>
                          <p className="mt-1 truncate text-sm font-semibold text-white">
                            {movement.description}
                          </p>
                          <p className="mt-0.5 text-xs text-white/42">
                            {formatMovementDate(movement.created_at)}
                          </p>
                        </div>
                        <p
                          className={cn(
                            "text-sm font-black",
                            positive ? "text-emerald-300" : "text-white"
                          )}
                        >
                          {positive ? "+" : "-"}
                          {formatARS(Number(movement.amount ?? 0))}
                        </p>
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => void reverseMovement(movement)}
                          className="inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-white/10 px-2.5 text-xs font-bold text-white/60 transition hover:border-beyonix-blue-light/45 hover:text-white disabled:cursor-not-allowed disabled:opacity-45"
                        >
                          <RotateCcw className="size-3.5" />
                          Reversar
                        </button>
                      </div>
                    )
                  })
                ) : (
                  <p className="rounded-xl border border-white/8 bg-black/20 px-3 py-4 text-center text-sm font-semibold text-white/55">
                    No hay movimientos para este cliente.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        <aside className="rounded-2xl border border-beyonix-blue-light/16 bg-[#0B1118] p-4">
          <h3 className="text-sm font-black text-white">
            Registrar movimiento
          </h3>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {[
              { value: "credit" as const, label: "Acreditar", icon: ArrowUpCircle },
              { value: "debit" as const, label: "Debitar", icon: ArrowDownCircle },
            ].map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setMovementType(option.value)}
                className={cn(
                  "inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl border text-xs font-black transition",
                  movementType === option.value
                    ? "border-beyonix-blue-light/65 bg-[#112A43] text-white"
                    : "border-white/10 bg-black/20 text-white/55 hover:border-beyonix-blue-light/35 hover:text-white"
                )}
              >
                <option.icon className="size-4" />
                {option.label}
              </button>
            ))}
          </div>

          <div className="mt-3 space-y-3">
            <label className="block">
              <span className="mb-1 block text-10px font-bold uppercase tracking-widest text-white/45">
                Monto
              </span>
              <input
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                inputMode="decimal"
                placeholder="0"
                className="h-10 w-full rounded-xl border border-beyonix-blue-light/18 bg-[#10151C] px-3 text-sm font-semibold text-white outline-none placeholder:text-white/35 focus:border-beyonix-blue-light/65"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-10px font-bold uppercase tracking-widest text-white/45">
                Descripción
              </span>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={3}
                placeholder="Motivo visible para el cliente"
                className="w-full resize-none rounded-xl border border-beyonix-blue-light/18 bg-[#10151C] px-3 py-2 text-sm font-semibold text-white outline-none placeholder:text-white/35 focus:border-beyonix-blue-light/65"
              />
            </label>
            <div className="grid gap-2 sm:grid-cols-3">
              <input
                value={orderId}
                onChange={(event) => setOrderId(event.target.value)}
                inputMode="numeric"
                placeholder="Pedido ID"
                className="h-9 rounded-lg border border-white/10 bg-black/20 px-2 text-xs font-semibold text-white outline-none placeholder:text-white/32"
              />
              <input
                value={claimId}
                onChange={(event) => setClaimId(event.target.value)}
                inputMode="numeric"
                placeholder="Reclamo ID"
                className="h-9 rounded-lg border border-white/10 bg-black/20 px-2 text-xs font-semibold text-white outline-none placeholder:text-white/32"
              />
              <input
                value={creditNoteId}
                onChange={(event) => setCreditNoteId(event.target.value)}
                placeholder="Nota crédito"
                className="h-9 rounded-lg border border-white/10 bg-black/20 px-2 text-xs font-semibold text-white outline-none placeholder:text-white/32"
              />
            </div>
          </div>

          <button
            type="button"
            disabled={!profile || saving}
            onClick={() => void submitMovement()}
            className="mt-4 inline-flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-beyonix-blue-light/40 bg-[#112A43] px-4 text-sm font-black text-white transition hover:border-beyonix-blue-light/70 hover:bg-[#183B5E] disabled:cursor-not-allowed disabled:opacity-45"
          >
            {saving && <Loader2 className="size-4 animate-spin" />}
            Registrar
          </button>
        </aside>
      </section>
    </div>
  )
}
