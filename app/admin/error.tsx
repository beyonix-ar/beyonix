"use client"

import Link from "next/link"
import { AlertTriangle, RotateCcw } from "lucide-react"

import { ADMIN_ROUTES } from "@/lib/admin/admin-routes"

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-3xl items-center px-4 py-10">
      <section className="w-full rounded-3xl border border-red-400/20 bg-[#07111B] p-6 text-center shadow-2xl shadow-black/30 sm:p-8">
        <span className="mx-auto flex size-12 items-center justify-center rounded-2xl border border-red-400/25 bg-red-400/10 text-red-200">
          <AlertTriangle className="size-5" />
        </span>
        <h1 className="mt-4 text-2xl font-black text-white">
          No pudimos cargar esta sección
        </h1>
        <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-white/58">
          Ocurrió un inconveniente temporal. Podés reintentar sin cerrar sesión
          o volver al Dashboard.
        </p>
        {process.env.NODE_ENV === "development" && (
          <p className="mt-4 break-words rounded-2xl border border-white/8 bg-black/35 p-3 text-left font-mono text-xs text-white/55">
            {error.message}
          </p>
        )}
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <button
            type="button"
            onClick={reset}
            className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-2xl bg-white px-5 text-sm font-black text-black transition hover:bg-white/90"
          >
            <RotateCcw className="size-4" />
            Reintentar
          </button>
          <Link
            href={ADMIN_ROUTES.dashboard}
            className="inline-flex h-11 items-center rounded-2xl border border-beyonix-sky/30 bg-beyonix-blue/20 px-5 text-sm font-black text-white transition hover:border-beyonix-sky/55"
          >
            Volver al Dashboard
          </Link>
        </div>
      </section>
    </div>
  )
}
