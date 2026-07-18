"use client"

import { useCallback, useEffect, useMemo, useState, type DragEvent, type ReactNode } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
  BarChart3,
  BellRing,
  CalendarDays,
  Coins,
  FileText,
  GripVertical,
  History,
  LogOut,
  Menu,
  Package,
  Percent,
  Settings2,
  ShieldCheck,
  ShoppingCart,
  UserCog,
  Users,
  X,
} from "lucide-react"

import { useAuth } from "@/context/auth-context"
import { useAdminNotifications } from "@/hooks/use-admin-notifications"
import { AdminNotificationsBell } from "@/components/admin-notifications-bell"
import { supabase } from "@/lib/supabase/client"
import {
  markAdminOrderNewNotificationRead,
  type AdminNotificationTone,
} from "@/lib/admin/admin-notifications"
import { ADMIN_SENSITIVE_DANGER } from "@/lib/admin/admin-sensitive-visuals"
import { ROLE_LABELS, type UserRole } from "@/lib/auth/roles"

import { AdminAuditoria } from "./sections/auditoria/admin-auditoria"
import { AdminAccionesMasivas } from "./sections/acciones-masivas/admin-acciones-masivas"
import { AdminClientes } from "./sections/clientes/admin-clientes"
import { AdminCreditos } from "./sections/creditos/admin-creditos"
import { AdminDashboard } from "./sections/dashboard/admin-dashboard"
import { AdminEventos } from "./sections/eventos/admin-eventos"
import { AdminFacturacion } from "./sections/facturacion/admin-facturacion"
import { AdminNotificaciones } from "./sections/notificaciones/admin-notificaciones"
import { AdminModificaciones } from "./sections/modificaciones/admin-modificaciones"
import { AdminPedidos } from "./sections/pedidos/admin-pedidos"
import { AdminProductos } from "./sections/productos/admin-productos"
import { AdminUsuarios } from "./sections/usuarios/admin-usuarios"

export type AdminSection =
  | "dashboard"
  | "modificaciones"
  | "notificaciones"
  | "acciones-masivas"
  | "eventos"
  | "productos"
  | "clientes"
  | "creditos"
  | "facturacion"
  | "pedidos"
  | "usuarios"
  | "auditoria"

const ADMIN_SECTIONS: AdminSection[] = [
  "dashboard",
  "modificaciones",
  "notificaciones",
  "acciones-masivas",
  "eventos",
  "productos",
  "clientes",
  "creditos",
  "facturacion",
  "pedidos",
  "usuarios",
  "auditoria",
]

const ADMIN_SECTION_STORAGE_KEY = "beyonix-admin-section"
const ADMIN_NAV_ORDER_STORAGE_KEY = "beyonix-admin-nav-order"

interface NavigationItem {
  key: AdminSection
  label: string
  description: string
  icon: ReactNode
  notificationCount?: number
  notificationTone?: AdminNotificationTone
}

function SidebarItem({
  item,
  active,
  dragging,
  dragOver,
  reorderable,
  onClick,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  item: NavigationItem
  active: boolean
  dragging?: boolean
  dragOver?: boolean
  reorderable?: boolean
  onClick: () => void
  onDragStart?: (event: DragEvent<HTMLButtonElement>) => void
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void
  onDrop?: (event: DragEvent<HTMLDivElement>) => void
  onDragEnd?: () => void
}) {
  const sensitiveNotificationTone =
    item.notificationTone === "claim" ||
    item.notificationTone === "cancellation"

  return (
    <div
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={`group/nav relative grid grid-cols-[16px_minmax(0,1fr)] items-stretch rounded-2xl transition ${
        dragging ? "opacity-45" : ""
      } ${
        dragOver ? "ring-1 ring-beyonix-sky/55 ring-offset-2 ring-offset-black/40" : ""
      }`}
    >
      {reorderable && (
        <button
          type="button"
          draggable
          aria-label={`Mover ${item.label}`}
          title="Arrastrar para ordenar"
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          className="grid w-4 shrink-0 cursor-grab place-items-center rounded-xl text-white/24 transition hover:bg-white/5 hover:text-beyonix-sky active:cursor-grabbing"
        >
          <GripVertical className="size-3.5" strokeWidth={2.2} />
        </button>
      )}
      <button
        type="button"
        aria-label={item.label}
        onClick={onClick}
        className={`admin-ds-nav-item flex min-h-48px min-w-0 cursor-pointer items-center gap-3 px-4 py-3 text-left transition-all ${
          active ? "admin-ds-nav-item-active" : "admin-ds-nav-item-muted"
        }`}
      >
        <span
          className={`admin-ds-nav-icon flex size-10 shrink-0 items-center justify-center ${
            active ? "admin-ds-nav-icon-active" : "admin-ds-nav-icon-muted"
          }`}
        >
          {item.icon}
        </span>

        <span className="flex min-w-0 flex-1 items-start justify-between gap-2">
          <span className="min-w-0">
            <span className="block text-sm font-bold">{item.label}</span>
            <span
              className="mt-0.5 block truncate text-11px text-white/58"
            >
              {item.description}
            </span>
          </span>
          {item.notificationCount ? (
            <span
              className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-10px font-black transition-colors group-hover/nav:text-white ${
                sensitiveNotificationTone
                  ? `${ADMIN_SENSITIVE_DANGER.badge} admin-ds-nav-badge-danger`
                  : "admin-ds-nav-badge"
              }`}
            >
              {item.notificationCount}
            </span>
          ) : null}
        </span>
      </button>
    </div>
  )
}

function getAdminSection(value: string | null) {
  if (!value) return null
  if (value === "banners") return "modificaciones"

  return ADMIN_SECTIONS.includes(value as AdminSection)
    ? (value as AdminSection)
    : null
}

function getStoredAdminSection() {
  if (typeof window === "undefined") return null

  return getAdminSection(window.localStorage.getItem(ADMIN_SECTION_STORAGE_KEY))
}

function getStoredNavigationOrder(allowedSections: AdminSection[]) {
  if (typeof window === "undefined") return []

  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(ADMIN_NAV_ORDER_STORAGE_KEY) ?? "[]",
    ) as unknown

    if (!Array.isArray(parsed)) return []

    return parsed.filter((item): item is AdminSection =>
      allowedSections.includes(item as AdminSection),
    )
  } catch {
    return []
  }
}

export function AdminClient({ initialOrderId }: { initialOrderId?: number } = {}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user, isLoading, isInternal, isOperator, isSuperAdmin, logout } =
    useAuth()
  const {
    notificationCount,
    notificationTone,
    notificationGroups,
    notifications,
    loading: notificationsLoading,
    error: notificationsError,
    reloadNotifications,
  } = useAdminNotifications(isInternal)
  const [section, setSection] = useState<AdminSection>(
    () =>
      (initialOrderId ? "pedidos" : null) ||
      getAdminSection(searchParams.get("section")) ||
      getStoredAdminSection() ||
      "dashboard"
  )
  const [mobileOpen, setMobileOpen] = useState(false)
  const [invoicePendingCount, setInvoicePendingCount] = useState(0)
  const [navigationOrder, setNavigationOrder] = useState<AdminSection[]>([])
  const [draggedSection, setDraggedSection] = useState<AdminSection | null>(null)
  const [dragOverSection, setDragOverSection] = useState<AdminSection | null>(null)

  const loadInvoicePendingCount = useCallback(async () => {
    if (!isInternal || isOperator) {
      setInvoicePendingCount(0)
      return
    }

    const {
      data: { session },
    } = await supabase.auth.getSession()

    if (!session?.access_token) {
      setInvoicePendingCount(0)
      return
    }

    const response = await fetch("/api/admin/facturacion", {
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
    })

    if (!response.ok) {
      setInvoicePendingCount(0)
      return
    }

    const data = (await response.json()) as {
      orders?: Array<{ invoice_status?: string | null }>
    }

    setInvoicePendingCount(
      (data.orders ?? []).filter(
        (order) =>
          order.invoice_status == null ||
          order.invoice_status === "pending" ||
          order.invoice_status === "error",
      ).length,
    )
  }, [isInternal, isOperator])

  useEffect(() => {
    void loadInvoicePendingCount()

    const channel = supabase
      .channel("admin-invoice-sidebar-count")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "ordenes" },
        () => {
          void loadInvoicePendingCount()
        },
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [loadInvoicePendingCount])

  const navigation = useMemo<NavigationItem[]>(() => {
    const giftCardNotificationCount = notificationGroups.giftcard ?? 0
    const clientNotificationCount = notifications.filter((notification) =>
      notification.actionUrl.includes("section=clientes"),
    ).length
    const orderNotificationCount = Math.max(
      0,
      notificationCount - giftCardNotificationCount - clientNotificationCount,
    )
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
        notificationCount: orderNotificationCount,
        notificationTone,
      },
    ]

    if (isOperator) return operational

    return [
      ...operational,
      {
        key: "modificaciones",
        label: "Modificaciones",
        description: "Envío, banners y ajustes globales",
        icon: <Settings2 className="size-4" />,
      },
      {
        key: "notificaciones",
        label: "Notificaciones",
        description: "Promos y avisos a clientes",
        icon: <BellRing className="size-4" />,
      },
      {
        key: "acciones-masivas",
        label: "Editor masivo",
        description: "Ofertas, precios y cuotas",
        icon: <Percent className="size-4" />,
      },
      {
        key: "eventos",
        label: "Eventos",
        description: "Campañas programadas",
        icon: <CalendarDays className="size-4" />,
      },
      {
        key: "facturacion",
        label: "Facturación",
        description: "Facturas C pendientes",
        icon: <FileText className="size-4" />,
        notificationCount: invoicePendingCount,
        notificationTone: "invoice",
      },
      {
        key: "clientes",
        label: "Clientes",
        description: "Cuentas, saldos y compras",
        icon: <Users className="size-4" />,
        notificationCount: clientNotificationCount,
        notificationTone: "payment",
      },
      {
        key: "creditos",
        label: "GiftCard",
        description: "Envíos y regalos",
        icon: <Coins className="size-4" />,
        notificationCount: giftCardNotificationCount,
        notificationTone: "giftcard",
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
  }, [invoicePendingCount, isOperator, isSuperAdmin, notificationCount, notificationGroups.giftcard, notificationTone, notifications])

  useEffect(() => {
    if (!isSuperAdmin) {
      setNavigationOrder([])
      return
    }

    setNavigationOrder(getStoredNavigationOrder(navigation.map((item) => item.key)))
  }, [isSuperAdmin, navigation])

  const orderedNavigation = useMemo(() => {
    if (!isSuperAdmin || navigationOrder.length === 0) return navigation

    const byKey = new Map(navigation.map((item) => [item.key, item]))
    const ordered = navigationOrder
      .map((key) => byKey.get(key))
      .filter((item): item is NavigationItem => Boolean(item))
    const missing = navigation.filter((item) => !navigationOrder.includes(item.key))

    return [...ordered, ...missing]
  }, [isSuperAdmin, navigation, navigationOrder])

  const moveNavigationItem = (source: AdminSection, target: AdminSection) => {
    if (source === target) return

    const currentOrder = orderedNavigation.map((item) => item.key)
    const sourceIndex = currentOrder.indexOf(source)
    const targetIndex = currentOrder.indexOf(target)

    if (sourceIndex < 0 || targetIndex < 0) return

    const nextOrder = [...currentOrder]
    const [moved] = nextOrder.splice(sourceIndex, 1)
    nextOrder.splice(targetIndex, 0, moved)

    setNavigationOrder(nextOrder)
    window.localStorage.setItem(ADMIN_NAV_ORDER_STORAGE_KEY, JSON.stringify(nextOrder))
  }

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
    nextParams.delete("attention")

    router.replace(`/admin?${nextParams.toString()}`, {
      scroll: false,
    })
  }

  useEffect(() => {
    if (isLoading || !user || !isInternal) return
    if (!initialOrderId) return

    void markAdminOrderNewNotificationRead(initialOrderId)
  }, [initialOrderId, isInternal, isLoading, user])

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
    modificaciones: !isOperator ? <AdminModificaciones /> : null,
    notificaciones: !isOperator ? <AdminNotificaciones /> : null,
    "acciones-masivas": !isOperator ? <AdminAccionesMasivas /> : null,
    eventos: !isOperator ? <AdminEventos /> : null,
    productos: <AdminProductos />,
    clientes: <AdminClientes />,
    creditos: !isOperator ? <AdminCreditos /> : null,
    facturacion: !isOperator ? <AdminFacturacion /> : null,
    pedidos: <AdminPedidos initialOrderId={initialOrderId} />,
    usuarios: !isOperator ? <AdminUsuarios /> : null,
    auditoria: isSuperAdmin ? <AdminAuditoria /> : null,
  }

  const sidebar = (
    <aside className="beyonix-admin-sidebar admin-ds-sidebar flex h-full flex-col border-r">
      <div className="flex items-start justify-between gap-3 border-b border-beyonix-blue-light/20 px-5 py-5">
        <button
          type="button"
          aria-label="Ir al inicio"
          onClick={() => router.push("/")}
          className="group cursor-pointer text-left"
        >
          <p className="mb-1 text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
            Panel administrativo
          </p>
          <h1 className="text-2xl font-black text-white transition-colors duration-150 group-hover:text-beyonix-sky">
            BEYONIX
          </h1>
        </button>
        <AdminNotificationsBell
          count={notificationCount}
          tone={notificationTone}
          groups={notificationGroups}
          notifications={notifications}
          loading={notificationsLoading}
          error={notificationsError}
          onRetry={reloadNotifications}
          align="start"
        />
      </div>

      <div className="border-b border-beyonix-blue-light/18 p-4">
        <div className="admin-ds-sidebar-card p-4">
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

      <nav className="custom-scrollbar flex-1 space-y-2 overflow-x-hidden overflow-y-auto p-4">
        {orderedNavigation.map((item) => (
          <SidebarItem
            key={item.key}
            item={item}
            active={section === item.key}
            reorderable={isSuperAdmin}
            dragging={draggedSection === item.key}
            dragOver={dragOverSection === item.key && draggedSection !== item.key}
            onClick={() => goToSection(item.key)}
            onDragStart={(event) => {
              setDraggedSection(item.key)
              event.dataTransfer.effectAllowed = "move"
              event.dataTransfer.setData("text/plain", item.key)
            }}
            onDragOver={(event) => {
              if (!isSuperAdmin || !draggedSection || draggedSection === item.key) return
              event.preventDefault()
              event.dataTransfer.dropEffect = "move"
              setDragOverSection(item.key)
            }}
            onDrop={(event) => {
              event.preventDefault()
              const source =
                getAdminSection(event.dataTransfer.getData("text/plain")) ?? draggedSection

              if (isSuperAdmin && source) {
                moveNavigationItem(source, item.key)
              }

              setDraggedSection(null)
              setDragOverSection(null)
            }}
            onDragEnd={() => {
              setDraggedSection(null)
              setDragOverSection(null)
            }}
          />
        ))}
      </nav>

      <div className="border-t border-beyonix-blue-light/18 p-4">
        <button
          type="button"
          aria-label="Cerrar sesión"
          onClick={handleLogout}
          className="flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-2xl border border-beyonix-blue-light/20 px-6 text-sm font-bold text-white/62 transition-all hover:border-red-500/30 hover:text-red-300"
        >
          <LogOut className="size-4" />
          Cerrar sesión
        </button>
      </div>
    </aside>
  )

  return (
    <div className="beyonix-admin-shell min-h-screen text-white lg:flex">
      <div className="hidden lg:block">{sidebar}</div>

      <header className="admin-ds-mobile-header sticky top-0 z-50 flex h-16 items-center justify-between border-b px-4 lg:hidden">
        <button
          type="button"
          aria-label="Abrir navegación"
          onClick={() => setMobileOpen(true)}
          className="flex size-10 items-center justify-center rounded-xl border border-white/10 text-white"
        >
          <Menu className="size-5" />
        </button>
        <p className="text-sm font-black tracking-widest">BEYONIX ADMIN</p>
        <AdminNotificationsBell
          count={notificationCount}
          tone={notificationTone}
          groups={notificationGroups}
          notifications={notifications}
          loading={notificationsLoading}
          error={notificationsError}
          onRetry={reloadNotifications}
        />
      </header>

      {mobileOpen && (
        <div className="fixed inset-0 z-100 bg-black lg:hidden">
          <div className="absolute right-4 top-4 z-10">
            <button
              type="button"
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
        className={`beyonix-admin-main min-w-0 flex-1 bg-beyonix-page ${
          section === "dashboard" ? "" : "admin-solid-surface"
        }`}
      >
        {sections[section]}
      </main>
    </div>
  )
}
