"use client"

import { Suspense, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { CheckCircle2, Loader2 } from "lucide-react"

import { BeyonixLogoLink } from "@/components/beyonix-logo-link"

function ConfirmEmailContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const tokenHash = searchParams.get("token_hash") ?? ""
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  const handleConfirm = async () => {
    if (!tokenHash || loading) return

    setLoading(true)
    setError("")

    const response = await fetch("/api/auth/confirm-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokenHash }),
    })
    const result = await response.json()

    setLoading(false)

    if (!response.ok) {
      setError(result.error || "No pudimos confirmar tu cuenta.")
      return
    }

    router.replace("/login?email-confirmed=1")
  }

  return (
    <div className="flex min-h-screen flex-col bg-black">
      <header className="border-b border-white/10 bg-black">
        <nav className="container mx-auto px-4 lg:px-8">
          <div className="flex h-16 items-center justify-center lg:h-18">
            <BeyonixLogoLink />
          </div>
        </nav>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-6">
        <div className="w-full max-w-md rounded-2xl border border-white/10 bg-beyonix-surface-4 p-6 text-center shadow-2xl shadow-black/35">
          <div className="mx-auto flex size-16 items-center justify-center rounded-full border border-emerald-400/25 bg-emerald-500/10">
            <CheckCircle2 className="size-10 text-emerald-400" />
          </div>

          <h1 className="mt-5 text-2xl font-bold text-white">
            Confirmá tu cuenta
          </h1>

          <p className="mt-3 text-sm leading-6 text-white/60">
            Presioná el botón para validar tu email y activar tu cuenta.
          </p>

          {error && (
            <p className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              {error}
            </p>
          )}

          <button
            type="button"
            aria-label="Confirmar cuenta"
            title="Confirmar cuenta"
            onClick={handleConfirm}
            disabled={!tokenHash || loading}
            className="mt-6 flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-white text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading && <Loader2 className="size-4 animate-spin" />}
            {loading ? "Confirmando..." : "Confirmar cuenta"}
          </button>
        </div>
      </main>
    </div>
  )
}

export default function ConfirmEmailPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-black" />}>
      <ConfirmEmailContent />
    </Suspense>
  )
}
