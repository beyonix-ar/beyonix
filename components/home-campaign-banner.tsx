"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { getImageProps } from "next/image"

import { parseHomeCampaignState, type HomeCampaignState, type PublicBanner } from "@/lib/banners/public-banners"
import {
  HOME_CAMPAIGN_POLL_MS,
  isHomeCampaignStale,
  msUntilHomeCampaignEnds,
  msUntilHomeCampaignRefresh,
} from "@/lib/banners/home-campaign-schedule"
import { DEFAULT_ALT_TEXT, HOME_BANNER_DESKTOP, HOME_BANNER_MOBILE, isInternalDestination } from "@/lib/banners/site-banners"

/**
 * Campaña vigente del HOME. Arranca con la del render del servidor (sin
 * esperar al navegador: buen LCP y sin saltos) y se mantiene al día sola:
 *   * render viejo (pestaña restaurada, caché) → se confirma con el servidor al montar;
 *   * página abierta y visible → se consulta en el próximo cambio programado
 *     o, a más tardar, cada HOME_CAMPAIGN_POLL_MS (una campaña desactivada,
 *     editada, eliminada o reemplazada por Admin desaparece/cambia sola);
 *   * pestaña oculta → no se consulta; al volver se revisa enseguida si
 *     correspondía. Una sola consulta a la vez y un solo temporizador.
 * Si la campaña llega a su fin y el servidor no responde, se oculta igual.
 */
export function useHomeCampaign(initial: HomeCampaignState) {
  const [state, setState] = useState(initial)

  useEffect(() => {
    let cancelled = false
    let inFlight = false
    let timer: number | undefined
    let dueAt = Number.POSITIVE_INFINITY
    let current = initial
    // Fin de la campaña visible en el reloj del dispositivo, medido desde la respuesta del servidor.
    let endsAtDevice = Number.POSITIVE_INFINITY

    const track = (next: HomeCampaignState) => {
      const ms = msUntilHomeCampaignEnds(next)
      endsAtDevice = ms === null ? Number.POSITIVE_INFINITY : Date.now() + ms
    }

    const hideIfEnded = () => {
      if (!current.banner || Date.now() < endsAtDevice) return
      current = { ...current, banner: null }
      setState(current)
    }

    const wait = (ms: number) => {
      window.clearTimeout(timer)
      dueAt = Date.now() + ms
      timer = window.setTimeout(() => {
        // Oculta: no consulta (queda vencido y se revisa al volver), pero nunca muestra una vencida.
        if (document.visibilityState === "hidden") hideIfEnded()
        else void refresh()
      }, ms)
    }

    const refresh = async () => {
      if (inFlight || cancelled) return
      inFlight = true
      window.clearTimeout(timer)
      try {
        const response = await fetch("/api/store/banners?placement=home", { cache: "no-store" })
        const next = response.ok ? parseHomeCampaignState(await response.json()) : null
        if (!next) throw new Error("HOME_CAMPAIGN_REFRESH_FAILED")
        if (cancelled) return
        current = next
        track(next)
        setState(next)
        wait(msUntilHomeCampaignRefresh(next))
      } catch {
        if (cancelled) return
        hideIfEnded()
        wait(HOME_CAMPAIGN_POLL_MS)
      } finally {
        inFlight = false
      }
    }

    if (isHomeCampaignStale(initial, Date.now())) {
      // Render viejo: su hora no sirve de referencia; mientras tanto, el reloj del dispositivo.
      const endsAt = initial.banner?.ends_at ? Date.parse(initial.banner.ends_at) : Number.NaN
      endsAtDevice = Number.isFinite(endsAt) ? endsAt : Number.POSITIVE_INFINITY
      void refresh()
    } else {
      track(initial)
      wait(msUntilHomeCampaignRefresh(initial))
    }

    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() >= dueAt) void refresh()
    }
    // Volver desde la caché del navegador (atrás/adelante): confirmar enseguida.
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) void refresh()
    }
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("pageshow", onPageShow)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("pageshow", onPageShow)
    }
  }, [initial])

  return state
}

/**
 * Banner panorámico debajo del header. Escritorio 4:1 (1920 × 480); con imagen
 * para celular, 3:2 (960 × 640) en pantallas chicas. La caja reserva su
 * proporción (sin CLS) y la imagen es la principal de la página
 * (fetchPriority alta; `preload` no aplica con dos imágenes por viewport).
 */
export function HomeCampaignBanner({ banner }: { banner: PublicBanner }) {
  const alt = banner.alt_text || DEFAULT_ALT_TEXT.home
  const common = { alt, sizes: "(min-width: 1920px) 1920px, 100vw", loading: "eager" as const, fetchPriority: "high" as const }
  const { props: desktop } = getImageProps({ ...common, src: banner.image_url, ...HOME_BANNER_DESKTOP })
  const mobile = banner.mobile_image_url
    ? getImageProps({ ...common, src: banner.mobile_image_url, ...HOME_BANNER_MOBILE }).props
    : null

  const picture = (
    <picture>
      {mobile ? <source media="(max-width: 639px)" srcSet={mobile.srcSet} sizes={mobile.sizes} /> : null}
      <img {...desktop} alt={alt} className="absolute inset-0 size-full object-cover object-center" data-home-campaign-image="" />
    </picture>
  )
  const destination = banner.destination_url

  return (
    <section aria-label="Campaña destacada" className="home-campaign pt-18 lg:pt-20" data-home-campaign={banner.id}>
      <div className={`relative mx-auto w-full max-w-[1920px] overflow-hidden bg-beyonix-page ${mobile ? "aspect-[3/2] sm:aspect-[4/1]" : "aspect-[4/1]"}`}>
        {destination ? (
          isInternalDestination(destination) ? (
            <Link href={destination} aria-label={alt} className="absolute inset-0 block focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-beyonix-sky">
              {picture}
            </Link>
          ) : (
            <a href={destination} target="_blank" rel="noopener noreferrer" aria-label={alt} className="absolute inset-0 block focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-beyonix-sky">
              {picture}
            </a>
          )
        ) : picture}
      </div>
    </section>
  )
}
