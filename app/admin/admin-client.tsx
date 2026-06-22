"use client"

import { useEffect, useMemo, useState, type ReactNode } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
  BarChart3,
  History,
  LogOut,
  Menu,
  Package,
  ShieldCheck,
  ShoppingCart,
  UserCog,
  Users,
  X,
} from "lucide-react"

import { useAuth } from "@/context/auth-context"
import { useOrderNotifications } from "@/hooks/use-order-notifications"
import type { AdminOrderNotificationTone } from "@/lib/admin/order-notifications"
import { ROLE_LABELS, type UserRole } from "@/lib/auth/roles"

import { AdminAuditoria } from "./sections/auditoria/admin-auditoria"
import { AdminClientes } from "./sections/clientes/admin-clientes"
import { AdminDashboard } from "./sections/dashboard/admin-dashboard"
import { AdminPedidos } from "./sections/pedidos/admin-pedidos"
import { AdminProductos } from "./sections/productos/admin-productos"
import { AdminUsuarios } from "./sections/usuarios/admin-usuarios"

export type AdminSection =
  | "dashboard"
  | "productos"
  | "clientes"
  | "pedidos"
  | "usuarios"
  | "auditoria"

const ADMIN_SECTIONS: AdminSection[] = [
  "dashboard",
  "productos",
  "clientes",
  "pedidos",
  "usuarios",
  "auditoria",
]

const ADMIN_SECTION_STORAGE_KEY = "beyonix-admin-section"

interface NavigationItem {
  key: AdminSection
  label: string
  description: string
  icon: ReactNode
  notificationCount?: number
  notificationTone?: AdminOrderNotificationTone
}

function SidebarItem({
  item,
  active,
  onClick,
}: {
  item: NavigationItem
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      title={`${item.label}: ${item.description}`}
      aria-label={item.label}
      onClick={onClick}
      className={`group flex min-h-48px w-full cursor-pointer items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-all ${
        active
          ? "border-beyonix-blue-light bg-beyonix-blue text-white shadow-beyonix-slider"
          : "border-transparent text-white/70 hover:border-white/8 hover:bg-white/5 hover:text-white"
      }`}
    >
      <span
        className={`flex size-10 shrink-0 items-center justify-center rounded-xl border ${
          active
            ? "border-beyonix-sky/30 bg-black/20 text-beyonix-sky"
            : "border-white/8 bg-white/4 text-white/68 group-hover:text-white"
        }`}
      >
        {item.icon}
      </span>

      <span className="flex min-w-0 flex-1 items-start justify-between gap-2">
        <span className="min-w-0">
          <span className="block text-sm font-bold">{item.label}</span>
          <span
            title={item.description}
            className="mt-0.5 block truncate text-11px text-white/58"
          >
            {item.description}
          </span>
        </span>
        {item.notificationCount ? (
          <span
            title={`${item.notificationCount} pedidos requieren atención`}
            className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-10px font-black text-white transition-colors ${
              item.notificationTone === "issue"
                ? "border-[#EF4444]/50 bg-[#EF4444] shadow-[0_0_14px_rgba(239,68,68,0.35)] group-hover:bg-[#DC2626]"
                : item.notificationTone === "message"
                  ? "border-[#2563EB]/50 bg-[#2563EB] shadow-[0_0_14px_rgba(37,99,235,0.35)] group-hover:bg-[#1D4ED8]"
                  : "border-[#16A34A]/50 bg-[#16A34A] shadow-[0_0_14px_rgba(22,163,74,0.35)] group-hover:bg-[#15803D]"
            }`}
          >
            {item.notificationCount}
          </span>
        ) : null}
      </span>
    </button>
  )
}

function getAdminSection(value: string | null) {
  if (!value) return null

  return ADMIN_SECTIONS.includes(value as AdminSection)
    ? (value as AdminSection)
    : null
}

function getStoredAdminSection() {
  if (typeof window === "undefined") return null

  return getAdminSection(window.localStorage.getItem(ADMIN_SECTION_STORAGE_KEY))
}

export function AdminClient({ initialOrderId }: { initialOrderId?: number } = {}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user, isLoading, isInternal, isOperator, isSuperAdmin, logout } =
    useAuth()
  const { notificationCount, notificationTone } = useOrderNotifications()
  const [section, setSection] = useState<AdminSection>(
    () =>
      (initialOrderId ? "pedidos" : null) ||
      getAdminSection(searchParams.get("section")) ||
      getStoredAdminSection() ||
      "dashboard"
  )
  const [mobileOpen, setMobileOpen] = useState(false)

  const navigation = useMemo<NavigationItem[]>(() => {
    const operational: NavigationItem[] = [
      {
        key: "dashboard",
        label: "Dashboard",
        description: "Control del negocio",
        icon: <BarChart3 className="size-4" />,
      },
      {
        key: "productos",
        label: "Productos",
        description: "Stock, precios, variantes y categorías",
        icon: <Package className="size-4" />,
      },
      {
        key: "pedidos",
        label: "Pedidos",
        description: "Ventas, pagos, comprobantes y envíos",
        icon: <ShoppingCart className="size-4" />,
        notificationCount,
        notificationTone,
      },
    ]

    if (isOperator) return operational

    return [
      ...operational,
      {
        key: "clientes",
        label: "Clientes",
        description: "Cuentas y compras",
        icon: <Users className="size-4" />,
      },
      {
        key: "usuarios",
        label: "Usuarios / Roles",
        description: "Permisos de acceso",
        icon: <UserCog className="size-4" />,
      },
      ...(isSuperAdmin
        ? [
            {
              key: "auditoria" as const,
              label: "Auditoría",
              description: "Historial sensible",
              icon: <History className="size-4" />,
            },
          ]
        : []),
    ]
  }, [isOperator, isSuperAdmin, notificationCount, notificationTone])

  useEffect(() => {
    if (initialOrderId) {
      setSection("pedidos")
      return
    }
    const nextSection = getAdminSection(searchParams.get("section"))

    if (!nextSection) {
      const storedSection = getStoredAdminSection()

      if (!storedSection) {
        if (searchParams.has("section")) {
          router.replace("/admin?section=dashboard", {
            scroll: false,
          })
        }
        return
      }
      if (!navigation.some((item) => item.key === storedSection)) return

      setSection(storedSection)
      router.replace(`/admin?section=${storedSection}`, {
        scroll: false,
      })
      return
    }

    if (!navigation.some((item) => item.key === nextSection)) return

    setSection(nextSection)
    window.localStorage.setItem(ADMIN_SECTION_STORAGE_KEY, nextSection)
  }, [searchParams, navigation, router, initialOrderId])

  useEffect(() => {
    if (isLoading) return
    if (navigation.some((item) => item.key === section)) return

    setSection("dashboard")
    window.localStorage.setItem(ADMIN_SECTION_STORAGE_KEY, "dashboard")
    router.replace("/admin?section=dashboard", {
      scroll: false,
    })
  }, [section, isLoading, navigation, router])

  const goToSection = (nextSection: AdminSection) => {
    setSection(nextSection)
    setMobileOpen(false)
    window.localStorage.setItem(ADMIN_SECTION_STORAGE_KEY, nextSection)

    const nextParams = new URLSearchParams(searchParams.toString())
    nextParams.set("section", nextSection)

    router.replace(`/admin?${nextParams.toString()}`, {
      scroll: false,
    })
  }

  const handleLogout = async () => {
    await logout()
    router.push("/")
  }

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black">
        <div className="size-10 animate-spin rounded-full border-2 border-white/10 border-t-beyonix-sky" />
      </div>
    )
  }

  if (!user || !isInternal) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black px-4">
        <div className="max-w-md rounded-3xl border border-white/10 bg-beyonix-surface p-8 text-center">
          <ShieldCheck className="mx-auto mb-4 size-10 text-beyonix-sky" />
          <h1 className="text-2xl font-bold text-white">Acceso restringido</h1>
          <p className="mt-2 text-sm text-white/60">
            Tu cuenta no tiene permisos para ingresar al panel administrativo.
          </p>
          <button
            type="button"
            title="Volver al inicio"
            aria-label="Volver al inicio"
            onClick={() => router.push(user ? "/" : "/login?redirect=/admin")}
            className="mt-6 h-12 min-w-140px rounded-2xl bg-white px-6 text-sm font-bold text-black transition hover:bg-white/90"
          >
            Volver
          </button>
        </div>
      </div>
    )
  }

  const sections: Record<AdminSection, ReactNode> = {
    dashboard: <AdminDashboard onNavigate={goToSection} />,
    productos: <AdminProductos />,
    clientes: <AdminClientes />,
    pedidos: <AdminPedidos notificationCount={notificationCount} notificationTone={notificationTone} initialOrderId={initialOrderId} />,
    usuarios: !isOperator ? <AdminUsuarios /> : null,
    auditoria: isSuperAdmin ? <AdminAuditoria /> : null,
  }

  const sidebar = (
    <aside className="flex h-full w-280px flex-col border-r border-white/7 bg-black">
      <div className="border-b border-white/7 px-5 py-5">
        <button
          type="button"
          title="Ir al inicio"
          aria-label="Ir al inicio"
          onClick={() => router.push("/")}
          className="group cursor-pointer text-left"
        >
          <p className="mb-1 text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
            Panel administrativo
          </p>
          <h1 className="text-2xl font-black text-white transition-colors group-hover:text-[#112A43]">
            BEYONIX
          </h1>
        </button>
      </div>

      <div className="border-b border-white/7 p-4">
        <div className="rounded-3xl border border-white/8 bg-beyonix-surface p-4">
          <p className="truncate text-sm font-bold uppercase text-white">
            {user.username || user.name}
          </p>
          <p className="mt-1 truncate text-xs text-white/45">{user.email}</p>
          <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-beyonix-blue-light/40 bg-beyonix-blue px-3 py-1">
            <span className="size-1.5 rounded-full bg-beyonix-sky" />
            <span className="text-10px font-bold uppercase tracking-widest text-beyonix-sky">
              {ROLE_LABELS[user.rol as UserRole]}
            </span>
          </div>
        </div>
      </div>

      <nav className="custom-scrollbar flex-1 space-y-2 overflow-y-auto p-4">
        {navigation.map((item) => (
          <SidebarItem
            key={item.key}
            item={item}
            active={section === item.key}
            onClick={() => goToSection(item.key)}
          />
        ))}
      </nav>

      <div className="border-t border-white/7 p-4">
        <button
          type="button"
          title="Cerrar sesión"
          aria-label="Cerrar sesión"
          onClick={handleLogout}
          className="flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-2xl border border-white/8 px-6 text-sm font-bold text-white/62 transition-all hover:border-red-500/30 hover:text-red-300"
        >
          <LogOut className="size-4" />
          Cerrar sesión
        </button>
      </div>
    </aside>
  )

  return (
    <div className="min-h-screen bg-black text-white lg:flex">
      <div className="hidden lg:block">{sidebar}</div>

      <header className="sticky top-0 z-50 flex h-16 items-center justify-between border-b border-white/7 bg-black px-4 lg:hidden">
        <button
          type="button"
          title="Abrir navegación"
          aria-label="Abrir navegación"
          onClick={() => setMobileOpen(true)}
          className="flex size-10 items-center justify-center rounded-xl border border-white/10 text-white"
        >
          <Menu className="size-5" />
        </button>
        <p className="text-sm font-black tracking-widest">BEYONIX ADMIN</p>
        <span className="size-10" />
      </header>

      {mobileOpen && (
        <div className="fixed inset-0 z-100 bg-black lg:hidden">
          <div className="absolute right-4 top-4 z-10">
            <button
              type="button"
              title="Cerrar navegación"
              aria-label="Cerrar navegación"
              onClick={() => setMobileOpen(false)}
              className="flex size-10 items-center justify-center rounded-xl border border-white/10 text-white"
            >
              <X className="size-5" />
            </button>
          </div>
          {sidebar}
        </div>
      )}

      <main
        className={`min-w-0 flex-1 bg-beyonix-page ${
          section === "dashboard" ? "" : "admin-solid-surface"
        }`}
      >
        {sections[section]}
      </main>
    </div>
  )
}
