"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import {
  ChevronDown,
  CircleUserRound,
  Coins,
  Heart,
  IdCard,
  LockKeyhole,
  LogOut,
  ShieldCheck,
  WalletCards,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { useAuth } from "@/context/auth-context"
import { useCustomerCredit } from "@/context/customer-credit-context"
import { ADMIN_ROUTES } from "@/lib/admin/admin-routes"
import { formatARS } from "@/lib/customer-credit"
import { beyonixHoverBorder, cn } from "@/lib/utils"

export function AccountMenuIcon({
  Icon,
  filled = false,
  dollarBadge = false,
  danger = false,
}: {
  Icon: LucideIcon
  filled?: boolean
  dollarBadge?: boolean
  danger?: boolean
}) {
  return (
    <span
      className={cn(
        "relative flex size-7 shrink-0 items-center justify-center rounded-lg border border-beyonix-blue-light/34 bg-[linear-gradient(135deg,rgba(17,42,67,0.86),rgba(7,18,31,0.9))] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_0_12px_rgba(30,140,255,0.1)] transition-all group-hover:border-beyonix-sky/58 group-hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.11),0_0_16px_rgba(140,200,242,0.16)]",
        danger &&
          "group-hover:border-red-500/70 group-hover:text-red-500 group-hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.10),0_0_16px_rgba(239,68,68,0.22)] group-focus-visible:border-red-500/70 group-focus-visible:text-red-500",
      )}
    >
      <Icon
        className={`size-4 stroke-[2.35] drop-shadow-[0_0_4px_rgba(255,255,255,0.18)] ${
          filled ? "fill-white" : "fill-none"
        }`}
      />
      {dollarBadge && (
        <span className="absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full border border-white/24 bg-white text-[9px] font-black leading-none text-[#07121E] shadow-[0_0_8px_rgba(255,255,255,0.14)]">
          $
        </span>
      )}
    </span>
  )
}

export const accountMenuItemClass =
  "group flex items-center gap-2.5 border-b border-white/8 px-4 py-3 text-sm text-[#F8FAFC] outline-none transition-all duration-200 hover:bg-[rgba(17,42,67,0.75)] hover:text-[#D7ECFF] hover:shadow-[inset_0_0_0_1px_rgba(191,228,255,0.10)] focus-visible:bg-[rgba(17,42,67,0.75)] focus-visible:ring-2 focus-visible:ring-beyonix-blue-light/25"
export const accountLogoutMenuItemClass = cn(
  accountMenuItemClass,
  "w-full text-left hover:text-red-500 focus-visible:text-red-500",
)

export interface AccountMenuProps {
  className?: string
  // Modo controlado opcional: permite que un header con otros desplegables
  // (categorías, notificaciones) coordine el cierre cruzado, igual que el
  // comportamiento original. Sin estas props, el menú administra su propio
  // estado (uso simple, sin coordinación con hermanos).
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function AccountMenu({
  className,
  open: openProp,
  onOpenChange,
}: AccountMenuProps) {
  const { user, isLoading, isInternal, logout } = useAuth()
  const customerCredit = useCustomerCredit()
  const [internalOpen, setInternalOpen] = useState(false)
  const isControlled = openProp !== undefined
  const open = isControlled ? openProp : internalOpen
  const ref = useRef<HTMLDivElement>(null)

  const setOpen = useCallback(
    (next: boolean) => {
      if (!isControlled) setInternalOpen(next)
      onOpenChange?.(next)
    },
    [isControlled, onOpenChange],
  )

  useEffect(() => {
    function handleOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }

    document.addEventListener("mousedown", handleOutside)
    return () => document.removeEventListener("mousedown", handleOutside)
  }, [setOpen])

  if (!user) return null

  const userLabel = user.username?.trim() || (isLoading ? "" : "Mi cuenta")

  return (
    <div ref={ref} className={cn("relative", className)}>
      <button
        type="button"
        aria-label="Abrir menú de usuario"
        onClick={() => setOpen(!open)}
        className={cn(
          "flex h-11 max-w-300px cursor-pointer items-center gap-2.5 rounded-full bg-beyonix-blue/10 pl-1.5 pr-3.5 text-white hover:bg-beyonix-blue/18",
          beyonixHoverBorder,
          open && "border-beyonix-blue-light/70 ring-2 ring-beyonix-blue-light/18",
        )}
      >
        <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full border border-beyonix-blue-light/45 bg-white text-black shadow-sm shadow-black/40">
          {user.avatarUrl ? (
            <img src={user.avatarUrl} alt="" className="size-full object-cover" />
          ) : (
            <CircleUserRound className="size-5" />
          )}
        </span>
        <span className="whitespace-nowrap text-sm font-medium uppercase text-white/86">
          {userLabel.toUpperCase()}
        </span>
        <ChevronDown
          className={`size-3 text-white/52 transition-transform duration-200 ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-60 overflow-hidden rounded-xl border border-[rgba(148,197,255,0.18)] bg-[#080D14] shadow-[0_18px_45px_rgba(0,0,0,0.45)]">
          <Link
            href="/cuenta"
            onClick={() => setOpen(false)}
            className={accountMenuItemClass}
          >
            <AccountMenuIcon Icon={CircleUserRound} />
            Mi cuenta
          </Link>
          <Link
            href="/cuenta?tab=cargar-saldo"
            onClick={() => setOpen(false)}
            className={cn(
              accountMenuItemClass,
              "bg-[rgba(17,42,67,0.28)] font-semibold text-beyonix-sky",
            )}
          >
            <AccountMenuIcon Icon={WalletCards} dollarBadge />
            <span className="whitespace-nowrap">
              Mi saldo: {formatARS(customerCredit.balance)}
            </span>
          </Link>
          <Link
            href="/cuenta?tab=datos"
            onClick={() => setOpen(false)}
            className={accountMenuItemClass}
          >
            <AccountMenuIcon Icon={IdCard} />
            Mis datos
          </Link>
          <Link
            href="/cuenta?tab=ordenes"
            onClick={() => setOpen(false)}
            className={accountMenuItemClass}
          >
            <AccountMenuIcon Icon={Coins} dollarBadge />
            Mis compras
          </Link>
          <Link
            href="/cuenta/favoritos"
            onClick={() => setOpen(false)}
            className={accountMenuItemClass}
          >
            <AccountMenuIcon Icon={Heart} filled />
            Favoritos
          </Link>
          <Link
            href="/cuenta?tab=seguridad"
            onClick={() => setOpen(false)}
            className={accountMenuItemClass}
          >
            <AccountMenuIcon Icon={LockKeyhole} />
            Seguridad
          </Link>
          {isInternal && (
            <Link
              href={ADMIN_ROUTES.dashboard}
              onClick={() => setOpen(false)}
              className={`${accountMenuItemClass} font-semibold`}
            >
              <AccountMenuIcon Icon={ShieldCheck} />
              Panel administrador
            </Link>
          )}
          <button
            type="button"
            aria-label="Cerrar sesión"
            onClick={() => {
              logout()
              setOpen(false)
            }}
            className={accountLogoutMenuItemClass}
          >
            <AccountMenuIcon Icon={LogOut} danger />
            Cerrar sesión
          </button>
        </div>
      )}
    </div>
  )
}
