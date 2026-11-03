"use client"

import { useEffect, useRef } from "react"

/**
 * "Volver a elegir la sección en la que ya estoy" (click en el menú lateral
 * sobre la sección activa). Next no remonta la página al navegar a la misma
 * ruta, así que una sección con subvistas internas (editor, pestañas) se
 * entera por este evento y vuelve a su vista principal.
 */
const ADMIN_ROUTE_RESELECT_EVENT = "beyonix:admin-route-reselect"

function toPathname(href: string) {
  return new URL(href, window.location.href).pathname
}

/** El link apunta a la misma página (ruta + query) que la actual. */
export function isSameAdminLocation(href: string) {
  const url = new URL(href, window.location.href)
  return (
    url.origin === window.location.origin &&
    url.pathname === window.location.pathname &&
    url.search === window.location.search
  )
}

export function notifyAdminRouteReselect(href: string) {
  window.dispatchEvent(
    new CustomEvent<string>(ADMIN_ROUTE_RESELECT_EVENT, { detail: toPathname(href) }),
  )
}

export function useAdminRouteReselect(pathname: string, onReselect: () => void) {
  const handlerRef = useRef(onReselect)
  useEffect(() => {
    handlerRef.current = onReselect
  })

  useEffect(() => {
    const listener = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === pathname) handlerRef.current()
    }
    window.addEventListener(ADMIN_ROUTE_RESELECT_EVENT, listener)
    return () => window.removeEventListener(ADMIN_ROUTE_RESELECT_EVENT, listener)
  }, [pathname])
}
