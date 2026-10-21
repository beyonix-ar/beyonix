"use client"

import Link from "next/link"
import { ArrowLeft } from "lucide-react"

import { AccountMenu } from "@/components/account-menu"
import { AccountThemeToggle } from "@/components/account/account-theme-toggle"
import { AdminNotificationsBell } from "@/components/admin-notifications-bell"
import { BeyonixHeaderLoginLink, BeyonixHeaderRegisterLink } from "@/components/beyonix-ui"
import { checkoutSecondaryButtonClassName } from "@/components/checkout/checkout-button-styles"
import { useAuth } from "@/context/auth-context"
import { useBackNavigation } from "@/hooks/use-back-navigation"
import { useOrderNotifications } from "@/hooks/use-order-notifications"
import { cn } from "@/lib/utils"

export function CheckoutHeader() {
  const { back } = useBackNavigation()
  const { user, isLoading, isInternal } = useAuth()
  const adminNotifications = useOrderNotifications(isInternal)

  return (
    <header className="checkout-header sticky top-0 z-50 border-b border-beyonix-blue-light/14 bg-[#05070A]/95 backdrop-blur">
      <div className="container mx-auto px-3 sm:px-4 lg:px-8">
        {/* Mobile: Volver (sólo ícono en celulares angostos), marca con
            espacio propio y acciones compactas (avatar sin nombre); nada
            se superpone. Desde sm se conserva el layout original. */}
        <div data-checkout-header-row className="flex h-16 items-center justify-between gap-2 lg:h-20">
          <button
            type="button"
            aria-label="Volver a la tienda"
            onClick={() => back("/productos")}
            className={cn("h-9 shrink-0 px-3 text-sm", checkoutSecondaryButtonClassName)}
          >
            <ArrowLeft className="size-4" />

            <span className="hidden text-sm font-medium min-[375px]:inline">
              Volver
            </span>
          </button>

          <Link
            href="/"
            aria-label="Ir al inicio de BEYONIX"
            title="Ir al inicio de BEYONIX"
            className="min-w-0 cursor-pointer font-heading text-xl font-bold tracking-tight text-foreground transition-colors duration-150 hover:text-[#2F6FA3] min-[375px]:text-2xl sm:text-26px lg:text-28px"
          >
            BEYONIX
          </Link>

          <div className="relative flex shrink-0 items-center justify-end gap-1 sm:min-w-20 sm:gap-2">
            {isInternal && (
              <AdminNotificationsBell
                variant="storefront"
                tone={adminNotifications.notificationTone}
                groups={adminNotifications.notificationGroups}
                notifications={adminNotifications.notifications}
                loading={adminNotifications.loading}
                error={adminNotifications.error}
                onRetry={adminNotifications.reloadNotificationCount}
              />
            )}
            <AccountThemeToggle />
            {isLoading ? (
              <div
                aria-hidden="true"
                className="hidden h-11 w-36 items-center gap-2 rounded-full border border-white/8 bg-white/5 px-3 sm:flex"
              >
                <span className="size-7 shrink-0 animate-pulse rounded-full bg-white/10" />
                <span className="h-2.5 w-16 animate-pulse rounded-full bg-white/10" />
              </div>
            ) : user ? (
              <>
                <AccountMenu compact className="sm:hidden" />
                <AccountMenu className="hidden sm:block" />
              </>
            ) : (
              <div className="hidden items-center gap-2 sm:flex">
                <BeyonixHeaderLoginLink href="/login?redirect=/checkout" />
                <BeyonixHeaderRegisterLink href="/login?mode=register&redirect=/checkout" />
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  )
}
