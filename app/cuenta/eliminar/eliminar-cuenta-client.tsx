"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Loader2,
  ShieldAlert,
  Trash2,
} from "lucide-react"

import {
  AccountCard,
  AccountPageContainer,
  AccountPageHeader,
  IconContainer,
} from "@/components/account/account-ui"
import { useAuth } from "@/context/auth-context"
import { supabase } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"

const deletionEffects = [
  "Se cierra el acceso a tu cuenta BEYONIX.",
  "Se eliminan favoritos, datos guardados, saldo visible y preferencias de cuenta.",
  "Las compras, facturas, garantías y comprobantes pueden conservarse por obligaciones legales u operativas.",
  "Esta acción no se puede deshacer.",
]

export function EliminarCuentaClient() {
  const router = useRouter()
  const { logout } = useAuth()
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState("")
  const [confirmOpen, setConfirmOpen] = useState(false)

  async function deleteAccount() {
    setDeleting(true)
    setError("")

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session?.access_token) {
        throw new Error("Tu sesión venció. Volvé a iniciar sesión para eliminar la cuenta.")
      }

      const response = await fetch("/api/account/delete", {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      })
      const data = (await response.json().catch(() => ({}))) as {
        error?: string
      }

      if (!response.ok) {
        throw new Error(data.error || "No se pudo eliminar la cuenta.")
      }

      await logout()
      router.replace("/")
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "No se pudo eliminar la cuenta.",
      )
    } finally {
      setDeleting(false)
    }
  }

  return (
    <AccountPageContainer className="max-w-4xl space-y-5 pt-24 pb-12 sm:pt-28 sm:pb-16 lg:pt-32 lg:pb-20">
      <AccountPageHeader
        eyebrow="Mi cuenta"
        title="¿Seguro que querés eliminar tu cuenta?"
        description="La eliminación de cuenta es permanente. Revisá qué implica antes de continuar."
        className="border-transparent bg-transparent p-0 shadow-none"
      />

      <AccountCard padding="lg" className="space-y-6">
        <div className="flex items-start gap-4">
          <IconContainer
            size="lg"
            className="border-red-500/30 bg-red-500/10 text-red-400"
          >
            <ShieldAlert className="size-6 stroke-[2.25]" />
          </IconContainer>
          <div className="min-w-0">
            <h2 className="text-xl font-bold text-white">
              Esto es lo que implica
            </h2>
            <p className="mt-2 text-sm leading-7 text-[var(--account-text-secondary)]">
              BEYONIX eliminará tu acceso y los datos de cuenta asociados al perfil. Algunos registros de compra pueden conservarse cuando sean necesarios para facturación, garantías o respaldo operativo.
            </p>
          </div>
        </div>

        <ul className="grid gap-3">
          {deletionEffects.map((effect) => (
            <li
              key={effect}
              className="flex items-start gap-2.5 text-sm leading-6 text-[var(--account-text-secondary)]"
            >
              <CheckCircle2 className="mt-1 size-4 shrink-0 text-beyonix-cyan" />
              <span>{effect}</span>
            </li>
          ))}
        </ul>

        <div className="rounded-xl border border-red-500/20 bg-red-500/8 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-red-400" />
            <p className="text-sm font-semibold leading-6 text-red-100/86">
              Antes de eliminarla, asegurate de no necesitar comprobantes, garantías, reclamos o saldos disponibles.
            </p>
          </div>
        </div>

        {error ? (
          <p className="rounded-xl border border-red-400/24 bg-red-500/10 px-4 py-3 text-sm font-semibold text-red-100">
            {error}
          </p>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <Link
            href="/cuenta"
            className="inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border border-beyonix-blue-light/24 bg-beyonix-blue/14 px-5 text-sm font-semibold text-white/84 transition hover:border-beyonix-blue-light/55 hover:bg-beyonix-blue/24 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-beyonix-blue-light/25"
          >
            <ArrowLeft className="size-4" />
            Volver a mi cuenta
          </Link>
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={deleting}
            className={cn(
              "inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border border-red-500/35 bg-red-500/10 px-5 text-sm font-semibold text-red-100 transition hover:border-red-500/70 hover:bg-red-500/18 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/25 disabled:cursor-not-allowed disabled:opacity-60",
            )}
          >
            {deleting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Trash2 className="size-4" />
            )}
            Eliminar cuenta permanentemente
          </button>
        </div>
      </AccountCard>

      {confirmOpen ? (
        <div className="fixed inset-0 z-100 flex items-center justify-center bg-black/72 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-beyonix-blue-light/20 bg-[#080D14] p-5 text-white shadow-2xl shadow-black/55">
            <div className="flex items-start gap-3">
              <IconContainer
                className="border-red-500/30 bg-red-500/10 text-red-400"
                size="md"
              >
                <AlertTriangle className="size-5 stroke-[2.3]" />
              </IconContainer>
              <div className="min-w-0">
                <h2 className="text-lg font-bold text-white">
                  ¿Estás seguro de eliminar tu cuenta permanentemente?
                </h2>
                <p className="mt-2 text-sm leading-6 text-white/62">
                  Esta acción no se puede deshacer.
                </p>
              </div>
            </div>

            <div className="mt-5 grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                disabled={deleting}
                className="inline-flex h-10 cursor-pointer items-center justify-center rounded-xl border border-beyonix-blue-light/22 bg-beyonix-blue/12 px-4 text-sm font-semibold text-white/78 transition hover:border-beyonix-blue-light/50 hover:bg-beyonix-blue/22 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-beyonix-blue-light/25 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void deleteAccount()}
                disabled={deleting}
                className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl border border-red-500/40 bg-red-500/12 px-4 text-sm font-semibold text-red-100 transition hover:border-red-500/75 hover:bg-red-500/20 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/25 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {deleting ? <Loader2 className="size-4 animate-spin" /> : null}
                Eliminar
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </AccountPageContainer>
  )
}
