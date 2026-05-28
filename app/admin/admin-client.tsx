"use client"

import {
  useEffect,
  useMemo,
  useState,
} from "react"

import { useRouter } from "next/navigation"

import {
  FolderOpen,
  History,
  LayoutDashboard,
  LogOut,
  Package,
  ShoppingCart,
} from "lucide-react"

import { useAuth } from "@/context/auth-context"

import { AdminDashboard } from "./sections/dashboard/admin-dashboard"
import { AdminAuditoria } from "./sections/auditoria/admin-auditoria"
import { AdminCategorias } from "./sections/categorias/admin-categorias"
import { AdminPedidos } from "./sections/pedidos/admin-pedidos"
import { AdminProductos } from "./sections/productos/admin-productos"

type AdminSection =
  | "dashboard"
  | "productos"
  | "categorias"
  | "pedidos"
  | "auditoria"

interface NavigationItem {
  key: AdminSection
  label: string
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
      title={item.label}
      aria-label={item.label}
      onClick={onClick}
      className={`flex h-11 w-full items-center gap-3 rounded-xl px-4 transition-all cursor-pointer ${
        active
          ? "bg-white text-black"
          : "text-white/65 hover:bg-white/5 hover:text-white"
      }`}
    >
      {item.icon}

      <span className="text-sm font-medium">
        {item.label}
      </span>
    </button>
  )
}

export function AdminClient() {
  const router = useRouter()

  const {
    user,
    isLoading,
    isAdmin,
    isSuperAdmin,
    logout,
  } = useAuth()

  const [section, setSection] =
    useState<AdminSection>(
      "dashboard"
    )

  // ───────────────────────────────────────────────────────────────────────────
  // Redirects
  // ───────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!isLoading && !user) {
      router.push("/cuenta")
    }
  }, [
    isLoading,
    user,
    router,
  ])

  useEffect(() => {
    if (
      !isLoading &&
      user &&
      !isAdmin
    ) {
      router.push("/")
    }
  }, [
    isLoading,
    user,
    isAdmin,
    router,
  ])

  // ───────────────────────────────────────────────────────────────────────────
  // Navigation
  // ───────────────────────────────────────────────────────────────────────────

  const navigation =
    useMemo<NavigationItem[]>(
      () => [
        {
          key: "dashboard",
          label: "Dashboard",
          icon: (
            <LayoutDashboard className="size-4" />
          ),
        },
        {
          key: "productos",
          label: "Productos",
          icon: (
            <Package className="size-4" />
          ),
        },
        {
          key: "categorias",
          label: "Categorías",
          icon: (
            <FolderOpen className="size-4" />
          ),
        },
        {
          key: "pedidos",
          label: "Pedidos",
          icon: (
            <ShoppingCart className="size-4" />
          ),
        },
        ...(isSuperAdmin
          ? [
              {
                key: "auditoria" as const,
                label: "Auditoría",
                icon: (
                  <History className="size-4" />
                ),
              },
            ]
          : []),
      ],
      [isSuperAdmin]
    )

  // ───────────────────────────────────────────────────────────────────────────
  // Sections
  // ───────────────────────────────────────────────────────────────────────────

  const sections: Record<
    AdminSection,
    React.ReactNode
  > = {
    dashboard:
      <AdminDashboard />,

    productos:
      <AdminProductos />,

    categorias:
      <AdminCategorias />,

    pedidos:
      <AdminPedidos />,

    auditoria:
      isSuperAdmin ? (
        <AdminAuditoria />
      ) : null,
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Loading
  // ───────────────────────────────────────────────────────────────────────────

  if (
    isLoading ||
    !user ||
    !isAdmin
  ) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black">
        <div className="size-10 animate-spin rounded-full border-2 border-white/10 border-t-white" />
      </div>
    )
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Logout
  // ───────────────────────────────────────────────────────────────────────────

  const handleLogout =
    async () => {
      await logout()

      router.push("/")
    }

  // ───────────────────────────────────────────────────────────────────────────
  // Render
  // ───────────────────────────────────────────────────────────────────────────

  return (
    <div className="flex min-h-screen bg-beyonix-page">
      <aside className="flex w-72 flex-col border-r border-white/6 bg-black/40 backdrop-blur-xl">
        <div className="flex h-20 items-center border-b border-white/6 px-6">
          <div>
            <p className="mb-1 text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
              Panel
            </p>

            <button
              type="button"
              title="Ir al inicio"
              aria-label="Ir al inicio"
              onClick={() =>
                router.push("/")
              }
              className="group text-left"
            >
              <h1 className="text-xl font-bold text-white transition-colors group-hover:text-beyonix-cyan">
                BEYONIX Admin
              </h1>
            </button>
          </div>
        </div>

        <div className="border-b border-white/6 p-4">
          <div className="rounded-2xl border border-white/8 bg-white/3 p-4">
            <p className="truncate text-sm font-semibold text-white">
              {user.name}
            </p>

            <p className="mt-1 truncate text-xs text-white/50">
              {user.email}
            </p>

            <div className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-beyonix-blue-light/40 bg-beyonix-blue px-2.5 py-1">
              <span className="size-1.5 rounded-full bg-beyonix-cyan" />

              <span className="text-10px font-semibold uppercase tracking-widest text-beyonix-sky">
                Administrador
                {isSuperAdmin
                  ? " total"
                  : ""}
              </span>
            </div>
          </div>
        </div>

        <nav className="flex-1 space-y-1.5 p-4">
          {navigation.map((item) => (
            <SidebarItem
              key={item.key}
              item={item}
              active={
                section === item.key
              }
              onClick={() =>
                setSection(item.key)
              }
            />
          ))}
        </nav>

        <div className="border-t border-white/6 p-4">
          <button
            type="button"
            title="Cerrar sesión"
            aria-label="Cerrar sesión"
            onClick={handleLogout}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-white/8 text-white/65 transition-all hover:border-red-500/30 hover:text-red-400 cursor-pointer"
          >
            <LogOut className="size-4" />

            <span className="text-sm font-medium">
              Cerrar sesión
            </span>
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-auto">
        {sections[section]}
      </main>
    </div>
  )
}
