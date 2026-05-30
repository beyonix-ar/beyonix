"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import {
  BarChart3,
  FolderOpen,
  History,
  LogOut,
  Menu,
  Package,
  ShieldCheck,
  ShoppingCart,
  Users,
  X,
} from "lucide-react"

import { useAuth } from "@/context/auth-context"

import { AdminAuditoria } from "./sections/auditoria/admin-auditoria"
import { AdminCategorias } from "./sections/categorias/admin-categorias"
import { AdminClientes } from "./sections/clientes/admin-clientes"
import { AdminDashboard } from "./sections/dashboard/admin-dashboard"
import { AdminPedidos } from "./sections/pedidos/admin-pedidos"
import { AdminProductos } from "./sections/productos/admin-productos"

export type AdminSection =
  | "dashboard"
  | "productos"
  | "clientes"
  | "categorias"
  | "pedidos"
  | "activos"
  | "auditoria"

interface NavigationItem {
  key: AdminSection
  label: string
  description: string
  icon: React.ReactNode
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

      <span className="min-w-0">
        <span className="block text-sm font-bold">{item.label}</span>
        <span title={item.description} className="mt-0.5 block truncate text-11px text-white/58">
          {item.description}
        </span>
      </span>
    </button>
  )
}

export function AdminClient() {
  const router = useRouter()
  const { user, isLoading, isAdmin, isSuperAdmin, logout } = useAuth()
  const [section, setSection] = useState<AdminSection>("dashboard")
  const [mobileOpen, setMobileOpen] = useState(false)

  const navigation = useMemo<NavigationItem[]>(
    () => [
      {
        key: "dashboard",
        label: "Dashboard",
        description: "Control del negocio",
        icon: <BarChart3 className="size-4" />,
      },
      {
        key: "productos",
        label: "Productos",
        description: "Stock, precios y variantes",
        icon: <Package className="size-4" />,
      },
      {
        key: "clientes",
        label: "Clientes",
        description: "Cuentas y compras",
        icon: <Users className="size-4" />,
      },
      {
        key: "pedidos",
        label: "Pedidos",
        description: "Ventas y despacho",
        icon: <ShoppingCart className="size-4" />,
      },
      {
        key: "activos",
        label: "Activos",
        description: "Sesiones actuales",
        icon: <ShieldCheck className="size-4" />,
      },
      {
        key: "categorias",
        label: "Categorías",
        description: "Organización del catálogo",
        icon: <FolderOpen className="size-4" />,
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
    ],
    [isSuperAdmin]
  )

  const goToSection = (nextSection: AdminSection) => {
    setSection(nextSection)
    setMobileOpen(false)
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

  if (!user || !isAdmin) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black px-4">
        <div className="max-w-md rounded-3xl border border-white/10 bg-beyonix-surface p-8 text-center">
          <ShieldCheck className="mx-auto mb-4 size-10 text-beyonix-sky" />
          <h1 className="text-2xl font-bold text-white">Acceso restringido</h1>
          <p className="mt-2 text-sm text-white/60">
            Solo administradores autorizados pueden entrar al panel.
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

  const sections: Record<AdminSection, React.ReactNode> = {
    dashboard: <AdminDashboard onNavigate={goToSection} />,
    productos: <AdminProductos />,
    clientes: <AdminClientes />,
    pedidos: <AdminPedidos />,
    activos: <AdminClientes initialActiveOnly />,
    categorias: <AdminCategorias />,
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
          className="cursor-pointer text-left"
        >
          <p className="mb-1 text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
            Panel administrativo
          </p>
          <h1 className="text-2xl font-black text-white">BEYONIX</h1>
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
              {isSuperAdmin ? "Super admin" : "Admin"}
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
