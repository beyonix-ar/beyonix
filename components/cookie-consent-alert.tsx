"use client"

import { useEffect, useState } from "react"

import { Cookie } from "lucide-react"

import { useAuth } from "@/context/auth-context"

const COOKIE_CONSENT_ACCEPTED_KEY = "beyonix-cookie-consent-accepted"
const COOKIE_CONSENT_DISMISSED_KEY = "beyonix-cookie-consent-dismissed-session"

export function CookieConsentAlert() {
  const { user, isLoading } = useAuth()
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (isLoading || !user) {
      setVisible(false)
      return
    }

    const accepted =
      window.localStorage.getItem(COOKIE_CONSENT_ACCEPTED_KEY) === "true"
    const dismissed =
      window.sessionStorage.getItem(COOKIE_CONSENT_DISMISSED_KEY) === "true"

    setVisible(!accepted && !dismissed)
  }, [isLoading, user])

  function acceptCookies() {
    window.localStorage.setItem(COOKIE_CONSENT_ACCEPTED_KEY, "true")
    window.sessionStorage.removeItem(COOKIE_CONSENT_DISMISSED_KEY)
    setVisible(false)
  }

  function cancelNotice() {
    window.sessionStorage.setItem(COOKIE_CONSENT_DISMISSED_KEY, "true")
    setVisible(false)
  }

  if (!visible) return null

  return (
    <div className="fixed inset-x-0 bottom-0 z-100 flex justify-center border-t border-white/8 bg-black/78 px-3 py-3 text-white shadow-2xl shadow-black/50 backdrop-blur-md">
      <div className="w-full max-w-5xl">
        <div className="flex flex-col items-center justify-center gap-3 text-center sm:flex-row">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-beyonix-blue-light/22 bg-beyonix-blue/16 text-white/78">
            <Cookie className="size-5" />
          </span>
          <div className="min-w-0 sm:flex sm:items-center sm:gap-5">
            <p className="text-sm font-bold text-white">
              Este sitio utiliza cookies para mejorar tu navegación.
            </p>
            <div className="mt-3 flex flex-wrap justify-center gap-2 sm:mt-0">
              <button
                type="button"
                onClick={acceptCookies}
                className="inline-flex h-9 cursor-pointer items-center justify-center rounded-lg border border-beyonix-blue-light/42 bg-beyonix-blue px-4 text-xs font-bold text-white transition hover:border-beyonix-blue-light/70 hover:bg-beyonix-blue-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-beyonix-blue-light/25"
              >
                Aceptar
              </button>
              <button
                type="button"
                onClick={cancelNotice}
                className="inline-flex h-9 cursor-pointer items-center justify-center rounded-lg border border-white/10 bg-black/20 px-4 text-xs font-bold text-white/64 transition hover:border-white/20 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-beyonix-blue-light/25"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
