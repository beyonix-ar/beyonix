"use client"

import { useCallback, useEffect, useState } from "react"
import {
  ArrowRightLeft,
  Eye,
  Loader2,
  MailCheck,
  RefreshCw,
  RotateCcw,
  Search,
  X,
} from "lucide-react"

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
  dni?: string | null
  telefono?: string | null
}

type GiftCardAction = "credit" | "debit" | "transfer"

type GiftCardListItem = {
  id: string
  kind: "topup" | "giftcard"
  movement_type?: "credit" | "debit" | null
  created_at: string
  origin: CreditProfile | null
  destination: CreditProfile | null
  amount: number
  status: string
  expires_at?: string | null
  message?: string | null
  proof_file_name?: string | null
  proof_signed_url?: string | null
  submitted_name?: string | null
  submitted_dni?: string | null
  email_status?: "pending" | "sending" | "sent" | "error" | null
  email_sent_at?: string | null
  email_last_attempt_at?: string | null
  email_attempts?: number
  email_last_error?: string | null
}

function getClientLabel(profile: CreditProfile | null) {
  if (!profile) return "Sin cliente"

  return profile.nombre || profile.username || profile.email || profile.id
}

function getClientDetail(profile: CreditProfile | null) {
  if (!profile) return ""

  return [
    profile.email,
    profile.username,
    profile.dni ? `DNI ${profile.dni}` : null,
    profile.telefono ? `Tel ${profile.telefono}` : null,
  ]
    .filter(Boolean)
    .join(" · ")
}

function formatMovementDate(value: string) {
  return new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value))
}

function formatExpirationDate(value?: string | null) {
  if (!value) return "Sin vencimiento"

  return new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(value))
}

function movementSign(movement: CustomerCreditMovement) {
  return movement.movement_type === "debit" || movement.movement_type === "expiration"
    ? "-"
    : "+"
}

export function AdminCreditos() {
  const [query, setQuery] = useState("")
  const [destinationQuery, setDestinationQuery] = useState("")
  const [profile, setProfile] = useState<CreditProfile | null>(null)
  const [destinationProfile, setDestinationProfile] =
    useState<CreditProfile | null>(null)
  const [balance, setBalance] = useState(0)
  const [movements, setMovements] = useState<CustomerCreditMovement[]>([])
  const [action, setAction] = useState<GiftCardAction>("transfer")
  const [amount, setAmount] = useState("")
  const [messageText, setMessageText] = useState("")
  const [loading, setLoading] = useState<"source" | "destination" | null>(null)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [giftCards, setGiftCards] = useState<GiftCardListItem[]>([])
  const [giftCardsLoading, setGiftCardsLoading] = useState(true)
  const [selectedGiftCard, setSelectedGiftCard] = useState<GiftCardListItem | null>(null)
  const [reactivatingGiftCard, setReactivatingGiftCard] = useState(false)
  const [emailActionLoading, setEmailActionLoading] = useState<"preview" | "retry" | null>(null)
  const [emailPreviewHtml, setEmailPreviewHtml] = useState("")

  async function getAccessToken() {
    const {
      data: { session },
    } = await supabase.auth.getSession()

    if (!session?.access_token) {
      throw new Error("No se pudo validar la sesión.")
    }

    return session.access_token
  }

  const loadGiftCards = useCallback(async () => {
    setGiftCardsLoading(true)

    try {
      const token = await getAccessToken()
      const response = await fetch("/api/admin/customer-credit/giftcards", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      })
      const data = (await response.json()) as {
        giftcards?: GiftCardListItem[]
        error?: string
      }

      if (!response.ok) {
        throw new Error(data.error || "No se pudo cargar el listado de GiftCard.")
      }

      setGiftCards(data.giftcards ?? [])
    } catch (error) {
      setNotice({
        ok: false,
        text: error instanceof Error ? error.message : "No se pudo cargar GiftCard.",
      })
    } finally {
      setGiftCardsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadGiftCards()
  }, [loadGiftCards])

  async function loadCustomer(kind: "source" | "destination") {
    const searchQuery = kind === "source" ? query.trim() : destinationQuery.trim()

    if (!searchQuery) {
      setNotice({ ok: false, text: "Buscá por email, usuario, nombre o DNI." })
      return
    }

    setLoading(kind)
    setNotice(null)

    try {
      const token = await getAccessToken()
      const response = await fetch(
        `/api/admin/customer-credit?q=${encodeURIComponent(searchQuery)}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        },
      )
      const data = (await response.json()) as {
        profile?: CreditProfile | null
        balance?: number
        movements?: CustomerCreditMovement[]
        error?: string
      }

      if (!response.ok || !data.profile) {
        throw new Error(data.error || "No encontramos ese cliente.")
      }

      if (kind === "source") {
        setProfile(data.profile)
        setBalance(Number(data.balance ?? 0))
        setMovements(data.movements ?? [])
      } else {
        setDestinationProfile(data.profile)
      }
    } catch (error) {
      setNotice({
        ok: false,
        text: error instanceof Error ? error.message : "No se pudo buscar el cliente.",
      })
    } finally {
      setLoading(null)
    }
  }

  async function reloadSource() {
    if (!profile) return

    const token = await getAccessToken()
    const response = await fetch(`/api/admin/customer-credit?userId=${profile.id}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    })
    const data = (await response.json()) as {
      balance?: number
      movements?: CustomerCreditMovement[]
    }

    setBalance(Number(data.balance ?? 0))
    setMovements(data.movements ?? [])
  }

  async function submitGiftCard() {
    const parsedAmount = normalizeMoney(amount)
    const cleanMessage = messageText.trim()

    if (!profile) {
      setNotice({ ok: false, text: "Elegí un cliente." })
      return
    }

    if (parsedAmount <= 0) {
      setNotice({ ok: false, text: "Ingresá un monto mayor a cero." })
      return
    }

    if (cleanMessage.length < 3) {
      setNotice({ ok: false, text: "Ingresá un mensaje." })
      return
    }

    if (action === "transfer" && !destinationProfile) {
      setNotice({ ok: false, text: "Elegí el cliente destino." })
      return
    }

    setSaving(true)
    setNotice(null)

    try {
      const token = await getAccessToken()
      const response = await fetch("/api/admin/customer-credit", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          action === "transfer"
            ? {
                action: "transfer",
                userId: profile.id,
                destinationUserId: destinationProfile?.id,
                amount: parsedAmount,
                description: cleanMessage,
              }
            : {
                action: "issue",
                userId: profile.id,
                movementType: action,
                amount: parsedAmount,
                description: cleanMessage,
              },
        ),
      })
      const data = (await response.json()) as {
        balance?: number
        movements?: CustomerCreditMovement[]
        error?: string
      }

      if (!response.ok) {
        throw new Error(data.error || "No se pudo guardar la GiftCard.")
      }

      setBalance(Number(data.balance ?? 0))
      setMovements(data.movements ?? [])
      setAmount("")
      setMessageText("")
      setNotice({ ok: true, text: "GiftCard actualizada." })
      if (action === "transfer") await reloadSource()
      await loadGiftCards()
    } catch (error) {
      setNotice({
        ok: false,
        text: error instanceof Error ? error.message : "No se pudo guardar.",
      })
    } finally {
      setSaving(false)
    }
  }

  async function reactivateGiftCard(giftCard: GiftCardListItem) {
    if (giftCard.movement_type !== "credit") {
      setNotice({ ok: false, text: "Solo podés reactivar GiftCards acreditadas." })
      return
    }

    setReactivatingGiftCard(true)
    setNotice(null)

    try {
      const token = await getAccessToken()
      const response = await fetch("/api/admin/customer-credit/giftcards", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ movementId: giftCard.id }),
      })
      const data = (await response.json()) as {
        expires_at?: string
        error?: string
      }

      if (!response.ok || !data.expires_at) {
        throw new Error(data.error || "No se pudo reactivar la GiftCard.")
      }

      const nextGiftCard = {
        ...giftCard,
        status: "acreditado",
        expires_at: data.expires_at,
      }

      setSelectedGiftCard(nextGiftCard)
      setGiftCards((current) =>
        current.map((item) => (item.id === giftCard.id ? nextGiftCard : item)),
      )
      setNotice({ ok: true, text: "GiftCard reactivada por 12 meses." })
      if (profile?.id === giftCard.destination?.id) await reloadSource()
    } catch (error) {
      setNotice({
        ok: false,
        text:
          error instanceof Error
            ? error.message
            : "No se pudo reactivar la GiftCard.",
      })
    } finally {
      setReactivatingGiftCard(false)
    }
  }

  async function runGiftCardEmailAction(giftCard: GiftCardListItem, action: "preview" | "retry") {
    setEmailActionLoading(action)
    setNotice(null)
    try {
      const token = await getAccessToken()
      const response = await fetch("/api/admin/customer-credit/giftcards", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ giftCardId: giftCard.id, action }),
      })
      const data = (await response.json()) as { html?: string; message?: string; error?: string; status?: GiftCardListItem["email_status"] }
      if (!response.ok) throw new Error(data.error || data.message || "No se pudo procesar el correo.")

      if (action === "preview" && data.html) {
        setEmailPreviewHtml(data.html)
      } else {
        setNotice({ ok: true, text: data.message || "Correo enviado correctamente." })
        await loadGiftCards()
        setSelectedGiftCard((current) => current ? { ...current, email_status: "sent", email_sent_at: new Date().toISOString(), email_last_error: null } : current)
      }
    } catch (error) {
      setNotice({ ok: false, text: error instanceof Error ? error.message : "No se pudo procesar el correo." })
    } finally {
      setEmailActionLoading(null)
    }
  }

  return (
    <div className="space-y-4">
      <header className="rounded-2xl border border-beyonix-blue-light/16 bg-[#0B1118] p-5">
        <p className="text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
          GiftCards
        </p>
        <h2 className="mt-1 text-2xl font-black text-white">GiftCard</h2>
        <p className="mt-2 text-sm leading-6 text-white/58">
          Transferí Gift Cards entre clientes y consultá su historial. Los ajustes manuales de saldo se realizan desde Clientes.
        </p>
      </header>

      {notice ? (
        <p
          className={cn(
            "rounded-xl border px-3 py-2 text-xs font-bold",
            notice.ok
              ? "border-emerald-300/25 bg-emerald-400/10 text-emerald-100"
              : "border-red-300/25 bg-red-500/10 text-red-100",
          )}
        >
          {notice.text}
        </p>
      ) : null}

      <section className="rounded-2xl border border-beyonix-blue-light/16 bg-[#0B1118] p-4">
        <div className="grid gap-2 xl:grid-cols-[1.2fr_0.8fr_0.65fr_1fr_auto]">
          <div className="flex gap-2">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void loadCustomer("source")
              }}
              placeholder="Cliente: mail, usuario, nombre o DNI"
              className="h-11 min-w-0 flex-1 rounded-xl border border-beyonix-blue-light/18 bg-[#10151C] px-3 text-sm font-semibold text-white outline-none placeholder:text-white/35 focus:border-beyonix-blue-light/65"
            />
            <button
              type="button"
              onClick={() => void loadCustomer("source")}
              disabled={loading === "source"}
              className="inline-flex h-11 w-11 cursor-pointer items-center justify-center rounded-xl border border-beyonix-blue-light/36 bg-[#112A43] text-white disabled:opacity-45"
            >
              {loading === "source" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Search className="size-4" />
              )}
            </button>
          </div>

          {action === "transfer" ? (
            <div className="flex gap-2">
              <input
                value={destinationQuery}
                onChange={(event) => setDestinationQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void loadCustomer("destination")
                }}
                placeholder="Destino"
                className="h-11 min-w-0 flex-1 rounded-xl border border-beyonix-blue-light/18 bg-[#10151C] px-3 text-sm font-semibold text-white outline-none placeholder:text-white/35 focus:border-beyonix-blue-light/65"
              />
              <button
                type="button"
                onClick={() => void loadCustomer("destination")}
                disabled={loading === "destination"}
                className="inline-flex h-11 w-11 cursor-pointer items-center justify-center rounded-xl border border-beyonix-blue-light/36 bg-[#112A43] text-white disabled:opacity-45"
              >
                {loading === "destination" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Search className="size-4" />
                )}
              </button>
            </div>
          ) : (
            <div className="hidden xl:block" />
          )}

          <input
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            inputMode="decimal"
            placeholder="Monto"
            className="h-11 rounded-xl border border-beyonix-blue-light/18 bg-[#10151C] px-3 text-sm font-semibold text-white outline-none placeholder:text-white/35 focus:border-beyonix-blue-light/65"
          />

          <input
            value={messageText}
            onChange={(event) => setMessageText(event.target.value)}
            placeholder="Mensaje para el cliente"
            className="h-11 rounded-xl border border-beyonix-blue-light/18 bg-[#10151C] px-3 text-sm font-semibold text-white outline-none placeholder:text-white/35 focus:border-beyonix-blue-light/65"
          />

          <button
            type="button"
            disabled={!profile || saving}
            onClick={() => void submitGiftCard()}
            className="inline-flex h-11 min-w-150px cursor-pointer items-center justify-center gap-2 rounded-xl border border-beyonix-blue-light/40 bg-[#112A43] px-4 text-sm font-black text-white transition hover:border-beyonix-blue-light/70 hover:bg-[#183B5E] disabled:cursor-not-allowed disabled:opacity-45"
          >
            {saving && <Loader2 className="size-4 animate-spin" />}
            Guardar
          </button>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {[
            { value: "transfer" as const, label: "Transferir", icon: ArrowRightLeft },
          ].map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setAction(option.value)}
              className={cn(
                "inline-flex h-9 cursor-pointer items-center gap-2 rounded-xl border px-3 text-xs font-black transition",
                action === option.value
                  ? "border-beyonix-blue-light/65 bg-[#112A43] text-white"
                  : "border-white/10 bg-black/20 text-white/55 hover:border-beyonix-blue-light/35 hover:text-white",
              )}
            >
              <option.icon className="size-4" />
              {option.label}
            </button>
          ))}
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,0.36fr)_minmax(0,0.64fr)]">
        <div className="rounded-2xl border border-beyonix-blue-light/16 bg-[#0B1118] p-4">
          <p className="text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
            Cliente seleccionado
          </p>
          <h3 className="mt-2 text-lg font-black text-white">{getClientLabel(profile)}</h3>
          <p className="mt-1 text-xs text-white/45">{getClientDetail(profile)}</p>
          <div className="mt-4 rounded-xl border border-emerald-300/25 bg-emerald-400/10 px-3 py-2">
            <p className="text-10px font-black uppercase tracking-widest text-emerald-100/70">
              Saldo
            </p>
            <p className="mt-0.5 text-2xl font-black text-white">{formatARS(balance)}</p>
          </div>
          {action === "transfer" ? (
            <div className="mt-3 rounded-xl border border-beyonix-blue-light/16 bg-black/20 px-3 py-2">
              <p className="text-10px font-black uppercase tracking-widest text-white/40">
                Destino
              </p>
              <p className="mt-1 text-sm font-bold text-white">
                {getClientLabel(destinationProfile)}
              </p>
              <p className="mt-0.5 text-xs text-white/42">
                {getClientDetail(destinationProfile)}
              </p>
            </div>
          ) : null}
        </div>

        <div className="rounded-2xl border border-beyonix-blue-light/16 bg-[#0B1118] p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-sm font-black text-white">Movimientos</h3>
            <span className="text-xs font-bold text-white/42">
              {movements.length} registros
            </span>
          </div>
          <div className="space-y-2">
            {movements.length ? (
              movements.slice(0, 12).map((movement) => (
                <div
                  key={movement.id}
                  className="grid gap-3 rounded-xl border border-white/8 bg-black/20 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto]"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-white">
                      {movement.description}
                    </p>
                    <p className="mt-0.5 text-xs text-white/42">
                      {formatMovementDate(movement.created_at)}
                    </p>
                  </div>
                  <p
                    className={cn(
                      "text-sm font-black",
                      movementSign(movement) === "+"
                        ? "text-emerald-300"
                        : "text-white",
                    )}
                  >
                    {movementSign(movement)}
                    {formatARS(Number(movement.amount ?? 0))}
                  </p>
                </div>
              ))
            ) : (
              <p className="rounded-xl border border-white/8 bg-black/20 px-3 py-5 text-center text-sm font-semibold text-white/55">
                Buscá un cliente para ver sus GiftCards.
              </p>
            )}
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-beyonix-blue-light/16 bg-[#0B1118] p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <p className="text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
              Listado
            </p>
            <h3 className="mt-1 text-lg font-black text-white">Historial de GiftCards</h3>
          </div>
          <span className="text-xs font-bold text-white/42">
            {giftCards.length} registros
          </span>
        </div>

        {giftCardsLoading ? (
          <div className="rounded-xl border border-white/8 bg-black/20 px-3 py-6 text-center text-sm font-semibold text-white/55">
            Cargando GiftCards...
          </div>
        ) : giftCards.length ? (
          <div className="overflow-hidden rounded-xl border border-beyonix-blue-light/16">
            <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1fr)_150px_96px] bg-[#08111A] px-3 py-2 text-10px font-black uppercase tracking-widest text-beyonix-cyan md:grid">
              <span>Origen</span>
              <span>Destino</span>
              <span>Monto</span>
              <span className="text-right">Acciones</span>
            </div>
            {giftCards.map((giftCard) => (
              <div
                key={giftCard.id}
                className="grid gap-3 border-t border-beyonix-blue-light/10 px-3 py-3 first:border-t-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_150px_96px] md:items-center"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-black text-white">
                    {getClientLabel(giftCard.origin) || "Transferencia"}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-white/42">
                    {getClientDetail(giftCard.origin) || giftCard.submitted_name || "-"}
                  </p>
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-black text-white">
                    {getClientLabel(giftCard.destination)}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-white/42">
                    {getClientDetail(giftCard.destination)}
                  </p>
                </div>
                <div>
                  <p
                    className={cn(
                      "text-sm font-black",
                      giftCard.movement_type === "debit"
                        ? "text-red-300"
                        : "text-emerald-300",
                    )}
                  >
                    {giftCard.movement_type === "debit" ? "− " : ""}
                    {formatARS(Number(giftCard.amount ?? 0))}
                  </p>
                  <p className="mt-0.5 text-xs text-white/42">
                    {formatMovementDate(giftCard.created_at)} · {giftCard.status}
                    {giftCard.expires_at
                      ? ` · Vence ${formatExpirationDate(giftCard.expires_at)}`
                      : ""}
                  </p>
                  {giftCard.email_status ? (
                    <p className={cn(
                      "mt-1 text-10px font-black uppercase tracking-wide",
                      giftCard.email_status === "sent" ? "text-emerald-300" : giftCard.email_status === "error" ? "text-red-300" : "text-amber-200",
                    )}>
                      Email: {giftCard.email_status === "sent" ? "enviado" : giftCard.email_status === "error" ? "con error" : giftCard.email_status === "sending" ? "enviando" : "pendiente"}
                    </p>
                  ) : null}
                </div>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => setSelectedGiftCard(giftCard)}
                    className="inline-flex size-10 cursor-pointer items-center justify-center rounded-xl border border-beyonix-blue-light/36 bg-[#112A43] text-white transition hover:bg-[#183B5E]"
                    title="Ver resumen"
                    aria-label="Ver resumen"
                  >
                    <Eye className="size-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="rounded-xl border border-white/8 bg-black/20 px-3 py-6 text-center text-sm font-semibold text-white/55">
            Todavía no hay GiftCards registradas.
          </p>
        )}
      </section>

      {selectedGiftCard ? (
        <div className="fixed inset-0 z-100 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-2xl rounded-2xl border border-beyonix-blue-light/24 bg-[#0B1118] p-5 shadow-2xl shadow-black/50">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
                  Resumen
                </p>
                <h3 className="mt-1 text-xl font-black text-white">Detalle de GiftCard</h3>
              </div>
              <button
                type="button"
                onClick={() => setSelectedGiftCard(null)}
                className="inline-flex size-9 cursor-pointer items-center justify-center rounded-xl border border-white/10 bg-black/20 text-white/70 hover:text-white"
                aria-label="Cerrar"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <DetailBlock title="Datos de origen" profile={selectedGiftCard.origin} fallback={selectedGiftCard.submitted_name ?? "Transferencia bancaria"} />
              <DetailBlock title="Datos de destino" profile={selectedGiftCard.destination} fallback="Sin cliente" />
              <div className="rounded-xl border border-white/8 bg-black/20 p-3">
                <p className="text-10px font-black uppercase tracking-widest text-white/40">Monto del movimiento</p>
                <p className="mt-1 text-2xl font-black text-white">{formatARS(Number(selectedGiftCard.amount ?? 0))}</p>
                <p className="mt-1 text-xs text-white/45">{selectedGiftCard.status}</p>
                <p className="mt-1 text-xs text-white/45">
                  Vence: {formatExpirationDate(selectedGiftCard.expires_at)}
                </p>
                {selectedGiftCard.movement_type === "credit" ? (
                  <button
                    type="button"
                    onClick={() => void reactivateGiftCard(selectedGiftCard)}
                    disabled={reactivatingGiftCard}
                    className="mt-3 inline-flex h-9 items-center gap-2 rounded-lg border border-beyonix-blue-light/35 bg-[#112A43] px-3 text-xs font-black text-white transition hover:bg-[#183B5E] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {reactivatingGiftCard ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <RotateCcw className="size-4" />
                    )}
                    Reactivar 12 meses
                  </button>
                ) : null}
              </div>
              <div className="rounded-xl border border-white/8 bg-black/20 p-3">
                <p className="text-10px font-black uppercase tracking-widest text-white/40">Entrega por email</p>
                <p className={cn("mt-2 text-sm font-black", selectedGiftCard.email_status === "sent" ? "text-emerald-300" : selectedGiftCard.email_status === "error" ? "text-red-300" : "text-amber-200")}>
                  {selectedGiftCard.email_status === "sent" ? "Enviado" : selectedGiftCard.email_status === "error" ? "Error de envío" : selectedGiftCard.email_status === "sending" ? "Enviando" : selectedGiftCard.email_status === "pending" ? "Pendiente" : "Sin seguimiento (registro anterior)"}
                </p>
                {selectedGiftCard.email_sent_at ? <p className="mt-1 text-xs text-white/55">Enviado: {formatMovementDate(selectedGiftCard.email_sent_at)}</p> : null}
                {selectedGiftCard.email_last_attempt_at ? <p className="mt-1 text-xs text-white/45">Último intento: {formatMovementDate(selectedGiftCard.email_last_attempt_at)} · {selectedGiftCard.email_attempts ?? 0} intento(s)</p> : null}
                {selectedGiftCard.email_last_error ? <p className="mt-2 rounded-lg border border-red-300/20 bg-red-500/10 px-2.5 py-2 text-xs leading-5 text-red-100">{selectedGiftCard.email_last_error}</p> : null}
                {selectedGiftCard.email_status ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" onClick={() => void runGiftCardEmailAction(selectedGiftCard, "preview")} disabled={emailActionLoading !== null} className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-beyonix-blue-light/35 bg-[#112A43] px-3 text-xs font-black text-white hover:bg-[#183B5E] disabled:cursor-not-allowed disabled:opacity-50">
                      {emailActionLoading === "preview" ? <Loader2 className="size-4 animate-spin" /> : <MailCheck className="size-4" />}
                      Vista previa
                    </button>
                    {["pending", "error"].includes(selectedGiftCard.email_status) && !["vencida", "cancelada"].includes(selectedGiftCard.status) ? (
                      <button type="button" onClick={() => void runGiftCardEmailAction(selectedGiftCard, "retry")} disabled={emailActionLoading !== null} className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-emerald-300/35 bg-emerald-400/10 px-3 text-xs font-black text-emerald-100 hover:bg-emerald-400/20 disabled:cursor-not-allowed disabled:opacity-50">
                        {emailActionLoading === "retry" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                        Reenviar email
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <div className="rounded-xl border border-white/8 bg-black/20 p-3 md:col-span-2">
                <p className="text-10px font-black uppercase tracking-widest text-white/40">Mensaje de la Gift</p>
                <p className="mt-2 text-sm font-semibold leading-6 text-white">
                  {selectedGiftCard.message || "Sin mensaje."}
                </p>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {emailPreviewHtml ? (
        <div className="fixed inset-0 z-110 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
          <div className="flex h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-beyonix-blue-light/30 bg-[#0B1118] shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <div><p className="text-10px font-black uppercase tracking-widest text-beyonix-cyan">Sin realizar envíos</p><h3 className="text-lg font-black text-white">Vista previa del email</h3></div>
              <button type="button" onClick={() => setEmailPreviewHtml("")} className="inline-flex size-9 cursor-pointer items-center justify-center rounded-xl border border-white/10 text-white/70 hover:text-white" aria-label="Cerrar vista previa"><X className="size-4" /></button>
            </div>
            <iframe title="Vista previa del email de Gift Card" srcDoc={emailPreviewHtml} sandbox="" className="min-h-0 flex-1 border-0 bg-[#050a10]" />
          </div>
        </div>
      ) : null}
    </div>
  )
}

function DetailBlock({
  title,
  profile,
  fallback,
}: {
  title: string
  profile: CreditProfile | null
  fallback: string
}) {
  return (
    <div className="rounded-xl border border-white/8 bg-black/20 p-3">
      <p className="text-10px font-black uppercase tracking-widest text-white/40">
        {title}
      </p>
      <p className="mt-2 text-sm font-black text-white">{getClientLabel(profile) || fallback}</p>
      <p className="mt-1 text-xs leading-5 text-white/55">{getClientDetail(profile) || fallback}</p>
    </div>
  )
}
