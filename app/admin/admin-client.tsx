"use client"

import {
  useMemo,
  useState,
} from "react"

import { useRouter } from "next/navigation"

import {
  LayoutDashboard,
  Package,
  ShoppingCart,
  Users,
  Tag,
  FolderOpen,
  LogOut,
} from "lucide-react"

import { useAuth } from "@/context/auth-context"

import { AdminDashboard } from "./sections/dashboard/admin-dashboard"

import { AdminProductos } from "./sections/productos/admin-productos"

import { AdminCategorias } from "./sections/categorias/admin-categorias"

import { AdminPedidos } from "./sections/pedidos/admin-pedidos"

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type AdminSection =
  | "dashboard"
  | "productos"
  | "categorias"
  | "pedidos"
  | "clientes"
  | "descuentos"

interface NavigationItem {
  key: AdminSection

  label: string

  icon: React.ReactNode
}

// ─────────────────────────────────────────────────────────────────────────────
// Sidebar item
// ─────────────────────────────────────────────────────────────────────────────

interface SidebarItemProps {
  item: NavigationItem

  active?: boolean

  onClick: () => void
}

function SidebarItem({
  item,
  active,
  onClick,
}: SidebarItemProps) {
  return (
    <button
      type="button"
      title={item.label}
      onClick={onClick}
      className={`w-full h-11 px-4 rounded-xl flex items-center gap-3 transition-all cursor-pointer ${
        active
          ? "bg-white text-black"
          : "text-white/55 hover:text-white hover:bg-white/5"
      }`}
    >
      <span className="shrink-0">
        {item.icon}
      </span>

      <span className="text-sm font-medium">
        {item.label}
      </span>
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

export function AdminClient() {
  const router = useRouter()

  const {
    user,
    isLoading,
    isAdmin,
    logout,
  } = useAuth()

  // ───────────────────────────────────────────────────────────────────────────
  // State
  // ───────────────────────────────────────────────────────────────────────────

  const [section, setSection] =
    useState<AdminSection>(
      "dashboard"
    )

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

        {
          key: "clientes",

          label: "Clientes",

          icon: (
            <Users className="size-4" />
          ),
        },

        {
          key: "descuentos",

          label: "Descuentos",

          icon: (
            <Tag className="size-4" />
          ),
        },
      ],
      []
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

    clientes: (
      <div className="p-8 text-white">
        Clientes próximamente
      </div>
    ),

    descuentos: (
      <div className="p-8 text-white">
        Descuentos próximamente
      </div>
    ),
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Guards
  // ───────────────────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="size-10 rounded-full border-2 border-white/10 border-t-white animate-spin" />
      </div>
    )
  }

  if (!user) {
    router.push("/cuenta")

    return null
  }

  if (!isAdmin) {
    router.push("/")

    return null
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Logout
  // ───────────────────────────────────────────────────────────────────────────

  const handleLogout = async () => {
    await logout()

    router.push("/")
  }

  // ───────────────────────────────────────────────────────────────────────────
  // UI
  // ───────────────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#050505] flex">
      {/* Sidebar */}
      <aside className="w-72 border-r border-white/6 bg-black/40 backdrop-blur-xl flex flex-col">
        {/* Header */}
        <div className="h-20 px-6 flex items-center border-b border-white/6">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.25em] text-[#4A90B8] mb-1">
              Panel
            </p>

            <button
              type="button"
              title="Ir al inicio"
              onClick={() => router.push("/")}
              className="text-left group"
            >
              <h1 className="text-xl font-bold text-white transition-colors group-hover:text-[#4A90B8]">
                BEYONIX Admin
              </h1>
            </button>
          </div>
        </div>

        {/* User */}
        <div className="p-4 border-b border-white/6">
          <div className="rounded-2xl border border-white/8 bg-white/3 p-4">
            <p className="text-sm font-semibold text-white truncate">
              {user.name}
            </p>

            <p className="text-xs text-white/40 truncate mt-1">
              {user.email}
            </p>

            <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-[#112A43] border border-[#1E4D7B]/40 px-2.5 py-1">
              <span className="size-1.5 rounded-full bg-[#4A90B8]" />

              <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#8CC8F2]">
                Administrador
              </span>
            </div>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-4 space-y-1.5">
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

        {/* Logout */}
        <div className="p-4 border-t border-white/6">
          <button
            type="button"
            title="Cerrar sesión"
            onClick={handleLogout}
            className="w-full h-11 rounded-xl border border-white/8 text-white/55 hover:text-red-400 hover:border-red-500/30 transition-all flex items-center justify-center gap-2 cursor-pointer"
          >
            <LogOut className="size-4" />

            <span className="text-sm font-medium">
              Cerrar sesión
            </span>
          </button>
        </div>
      </aside>

      {/* Content */}
      <main className="flex-1 overflow-auto">
        {sections[section]}
      </main>
    </div>
  )
}