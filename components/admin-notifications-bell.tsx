"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { AlertTriangle, Bell, CreditCard, FileText, ShoppingCart } from "lucide-react"

import type {
  AdminOrderNotificationGroups,
  AdminOrderNotificationTone,
} from "@/lib/admin/order-notifications"

const GROUPS: Array<{
  tone: AdminOrderNotificationTone
  label: string
  description: string
  icon: typeof Bell
  dot: string
}> = [
  {
    tone: "issue",
    label: "Reclamos y devoluciones",
    description: "Problemas que requieren atención.",
    icon: AlertTriangle,
    dot: "bg-red-400",
  },
  {
    tone: "message",
    label: "Comprobantes recibidos",
    description: "Pagos, mensajes y consultas para revisar.",
    icon: CreditCard,
    dot: "bg-blue-400",
  },
  {
    tone: "order",
    label: "Pedidos nuevos",
    description: "Ventas nuevas pendientes de gestión.",
    icon: ShoppingCart,
    dot: "bg-emerald-400",
  },
  {
    tone: "invoice",
    label: "Facturas pendientes",
    description: "Pagos confirmados aún no facturados.",
    icon: FileText,
    dot: "bg-violet-400",
  },
]

const BELL_STYLES: Record<AdminOrderNotificationTone, string> = {
  issue: "border-red-400/45 bg-red-500 hover:bg-red-600",
  message: "border-blue-400/45 bg-blue-600 hover:bg-blue-700",
  invoice: "border-violet-400/45 bg-violet-600 hover:bg-violet-700",
  order: "border-emerald-400/45 bg-[#16A34A] hover:bg-[#15803D]",
}

export function AdminNotificationsBell({
  count,
  tone,
  groups,
}: {
  count: number
  tone: AdminOrderNotificationTone
  groups: AdminOrderNotificationGroups
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return

    const handleOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }

    document.addEventListener("mousedown", handleOutside)
    document.addEventListener("keydown", handleEscape)
    return () => {
      document.removeEventListener("mousedown", handleOutside)
      document.removeEventListener("keydown", handleEscape)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        title="Notificaciones administrativas"
        aria-label="Abrir notificaciones administrativas"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={`relative flex size-10 cursor-pointer items-center justify-center rounded-full border text-white shadow-lg shadow-black/35 transition-colors ${
          count > 0 ? BELL_STYLES[tone] : "border-white/12 bg-[#0D1117] hover:bg-[#15191F]"
        }`}
      >
        <Bell className="size-4" />
        {count > 0 && (
          <span className="absolute -right-1.5 -top-1.5 flex min-h-5 min-w-5 items-center justify-center rounded-full border-2 border-black bg-white px-1 text-10px font-black leading-none text-black">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-12 z-100 w-[min(360px,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-[#263241] bg-[#0D1117] shadow-2xl shadow-black/75">
          <div className="border-b border-white/8 px-4 py-3">
            <p className="text-sm font-black text-white">Notificaciones admin</p>
            <p className="mt-0.5 text-10px text-white/50">
              {count > 0 ? `${count} pendientes` : "Todo está al día"}
            </p>
          </div>
          <div className="space-y-1 p-2">
            {GROUPS.map((group) => {
              const groupCount = groups[group.tone]
              const Icon = group.icon

              return (
                <Link
                  key={group.tone}
                  href={`/admin?section=pedidos&attention=${group.tone}`}
                  onClick={() => setOpen(false)}
                  aria-disabled={groupCount === 0}
                  className={`flex items-start gap-3 rounded-xl border border-white/8 px-3 py-2.5 transition-colors ${
                    groupCount > 0
                      ? "cursor-pointer bg-[#141820] hover:bg-[#15191F]"
                      : "pointer-events-none opacity-35"
                  }`}
                >
                  <span className="relative mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-[#15191F] text-white/72">
                    <Icon className="size-3.5" />
                    <span className={`absolute -right-0.5 -top-0.5 size-2 rounded-full ${group.dot}`} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-3 text-xs font-bold text-white">
                      <span>{group.label}</span>
                      <span>{groupCount}</span>
                    </span>
                    <span className="mt-0.5 block text-10px leading-4 text-white/52">
                      {group.description}
                    </span>
                  </span>
                </Link>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
