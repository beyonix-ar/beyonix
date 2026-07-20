"use client"

import { useEffect, useState } from "react"
import { CheckCircle2, Gift, Loader2, LockKeyhole, Sparkles } from "lucide-react"

import { formatARS } from "@/lib/customer-credit"

type GiftCard = {
  recipient_name: string
  sender_name: string
  initial_amount: number
  message: string
  display_code: string
  status: "sent" | "claimed" | "expired" | "cancelled"
  expires_at: string
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(new Date(value))
}

export function GiftCardClaimClient({ token }: { token: string }) {
  const [giftCard, setGiftCard] = useState<GiftCard | null>(null)
  const [loading, setLoading] = useState(true)
  const [claiming, setClaiming] = useState(false)
  const [claimed, setClaimed] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    let active = true
    void fetch(`/api/gift-cards/${encodeURIComponent(token)}`, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || "No pudimos abrir la Gift Card.")
        if (active) setGiftCard(data.giftCard)
      })
      .catch((loadError) => active && setError(loadError instanceof Error ? loadError.message : "No pudimos abrir la Gift Card."))
      .finally(() => active && setLoading(false))
    return () => { active = false }
  }, [token])

  async function claimGiftCard() {
    setClaiming(true)
    setError("")
    try {
      const response = await fetch(`/api/gift-cards/${encodeURIComponent(token)}`, { method: "POST" })
      const data = await response.json()
      if (response.status === 401) {
        const redirect = `/gift-card/${token}`
        window.location.assign(`/login?redirect=${encodeURIComponent(redirect)}`)
        return
      }
      if (!response.ok) throw new Error(data.error || "No pudimos acreditar la Gift Card.")
      setClaimed(true)
    } catch (claimError) {
      setError(claimError instanceof Error ? claimError.message : "No pudimos acreditar la Gift Card.")
    } finally {
      setClaiming(false)
    }
  }

  if (loading) return <main className="flex min-h-screen items-center justify-center bg-[#03070B]"><Loader2 className="size-8 animate-spin text-beyonix-sky" /></main>

  if (!giftCard) return <main className="flex min-h-screen items-center justify-center bg-[#03070B] px-5 text-center text-white"><div><Gift className="mx-auto size-10 text-white/35" /><h1 className="mt-4 text-2xl font-bold">Gift Card no disponible</h1><p className="mt-2 text-sm text-white/55">{error}</p></div></main>

  const unavailable = giftCard.status === "expired" || giftCard.status === "cancelled"
  const alreadyClaimed = giftCard.status === "claimed"

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#03070B] px-4 py-12 text-white">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_10%,rgba(29,117,173,0.24),transparent_34%),radial-gradient(circle_at_85%_85%,rgba(60,94,246,0.14),transparent_30%)]" />
      <div className="relative w-full max-w-2xl">
        <div className="mb-6 text-center"><p className="text-2xl font-black tracking-[0.26em]">BEYONIX</p><p className="mt-2 text-[10px] font-bold uppercase tracking-[0.24em] text-beyonix-sky">Un regalo para vos</p></div>
        <section className="rounded-[28px] border border-[#28577A] bg-[#08131E] p-2 shadow-[0_30px_90px_rgba(0,0,0,0.5)]">
          <div className="relative min-h-[310px] overflow-hidden rounded-[22px] border border-white/10 bg-[radial-gradient(circle_at_8%_0%,rgba(74,180,247,0.34),transparent_38%),linear-gradient(135deg,#15496F_0%,#092238_48%,#050A11_100%)] p-7 sm:p-9">
            <Sparkles className="absolute right-8 top-24 size-6 text-white/20" />
            <div className="flex items-center justify-between"><span className="font-black tracking-[0.16em]">BEYONIX</span><span className="rounded-full border border-white/15 bg-black/15 px-3 py-1.5 text-[9px] font-bold uppercase tracking-[0.18em] text-beyonix-sky">Gift Card</span></div>
            <div className="mt-14"><p className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/50">Crédito para disfrutar</p><p className="mt-2 text-5xl font-black tracking-tight">{formatARS(Number(giftCard.initial_amount))}</p></div>
            <div className="mt-12 flex items-end justify-between gap-5 border-t border-white/10 pt-5"><div><p className="text-[9px] uppercase tracking-[0.18em] text-white/40">Para</p><p className="mt-1 font-semibold">{giftCard.recipient_name}</p></div><div className="text-right"><p className="text-[9px] uppercase tracking-[0.18em] text-white/40">Código</p><p className="mt-1 text-xs font-semibold tracking-wider">{giftCard.display_code}</p></div></div>
          </div>
          <div className="px-6 py-7 text-center sm:px-10">
            <h1 className="text-2xl font-bold">{giftCard.sender_name} pensó en vos</h1>
            <blockquote className="mx-auto mt-4 max-w-lg rounded-2xl border border-[#28577A] bg-[#0C2030] px-5 py-4 text-base italic leading-7 text-white/88">“{giftCard.message || "Elegí eso que tanto querías. Este regalo es para vos."}”</blockquote>
            <p className="mt-5 text-xs leading-5 text-white/48">Válida hasta el {formatDate(giftCard.expires_at)}. El saldo puede usarse en una o varias compras.</p>
            {claimed || alreadyClaimed ? <div className="mt-6 rounded-xl border border-emerald-400/25 bg-emerald-500/10 p-4"><CheckCircle2 className="mx-auto size-7 text-emerald-300" /><p className="mt-2 font-semibold">La Gift Card ya está acreditada</p><a href="/cuenta?tab=saldo" className="mt-3 inline-block text-sm font-bold text-beyonix-sky">Ver mi saldo</a></div> : unavailable ? <p className="mt-6 rounded-xl border border-red-400/20 bg-red-500/10 p-4 text-sm text-red-100">Esta Gift Card ya no está disponible.</p> : <button type="button" onClick={() => void claimGiftCard()} disabled={claiming} className="mt-6 inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#1B75AD] px-5 text-sm font-bold transition hover:bg-[#2487C5] disabled:opacity-60"><LockKeyhole className="size-4" />{claiming ? "Acreditando..." : "Recibir mi Gift Card"}</button>}
            {error ? <p className="mt-3 text-sm text-red-200">{error}</p> : null}
          </div>
        </section>
      </div>
    </main>
  )
}
