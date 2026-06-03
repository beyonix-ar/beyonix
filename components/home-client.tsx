"use client"

import { useEffect } from "react"

import type { SupabaseProducto } from "@/lib/supabase/types"

import { useCart } from "@/context/cart-context"

import { BenefitsSection } from "@/components/benefits-section"
import { CategoriesSection } from "@/components/categories-section"
import { HeroSection } from "@/components/hero-section"
import { ProductsSection } from "@/components/products-section"
import { ReviewsSection } from "@/components/reviews-section"
import { WhatsAppButton } from "@/components/whatsapp-button"

export function HomeClient() {
  const { addToCart } = useCart()

  useEffect(() => {
    document.documentElement.classList.add("home-scroll-snap")

    if (window.location.pathname !== "/") {
      window.history.replaceState(null, "", "/")
    }

    const prefersReducedMotion =
      window.matchMedia("(prefers-reduced-motion: reduce)").matches

    if (prefersReducedMotion) {
      return () => {
        document.documentElement.classList.remove("home-scroll-snap")
      }
    }

    let frame = 0
    let isAnimating = false
    let lastWheelAt = 0

    const getSnapSections = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          ".home-snap-section, footer"
        )
      )

    const getSectionTop = (section: HTMLElement) =>
      Math.max(
        0,
        section.getBoundingClientRect().top +
          window.scrollY -
          72
      )

    const getCurrentSectionIndex = (
      sections: HTMLElement[]
    ) => {
      const currentY = window.scrollY

      return sections.reduce(
        (closestIndex, section, index) => {
          const closestDistance = Math.abs(
            currentY -
              getSectionTop(sections[closestIndex])
          )
          const nextDistance = Math.abs(
            currentY -
              getSectionTop(section)
          )

          return nextDistance < closestDistance
            ? index
            : closestIndex
        },
        0
      )
    }

    const easeInOutCubic = (progress: number) =>
      progress < 0.5
        ? 4 * progress * progress * progress
        : 1 -
          Math.pow(
            -2 * progress + 2,
            3
          ) /
            2

    const scrollToSection = (
      section: HTMLElement
    ) => {
      const startY = window.scrollY
      const targetY = getSectionTop(section)
      const distance = targetY - startY
      const duration = 950
      const startedAt = performance.now()

      isAnimating = true

      const animate = (now: number) => {
        const progress = Math.min(
          (now - startedAt) / duration,
          1
        )
        const eased = easeInOutCubic(progress)

        window.scrollTo(
          0,
          startY + distance * eased
        )

        if (progress < 1) {
          frame =
            requestAnimationFrame(animate)
          return
        }

        isAnimating = false
      }

      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(animate)
    }

    const handleWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) < 12) {
        return
      }

      event.preventDefault()

      const now = Date.now()

      if (
        isAnimating ||
        now - lastWheelAt < 320
      ) {
        return
      }

      lastWheelAt = now

      const sections = getSnapSections()
      const currentIndex =
        getCurrentSectionIndex(sections)
      const direction =
        event.deltaY > 0 ? 1 : -1
      const nextIndex = Math.max(
        0,
        Math.min(
          sections.length - 1,
          currentIndex + direction
        )
      )

      if (nextIndex === currentIndex) {
        return
      }

      scrollToSection(sections[nextIndex])
    }

    window.addEventListener(
      "wheel",
      handleWheel,
      { passive: false }
    )

    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener(
        "wheel",
        handleWheel
      )
      document.documentElement.classList.remove("home-scroll-snap")
    }
  }, [])

  const handleAddToCart = (
    product: SupabaseProducto,
    color: string,
    image?: string
  ) => {
    addToCart(product, color, image)
  }

  return (
    <>
      <section id="inicio" className="home-snap-section">
        <HeroSection />
      </section>

      <section id="categorias" className="home-snap-section">
        <CategoriesSection />
      </section>

      <section id="productos" className="home-snap-section">
        <ProductsSection onAddToCart={handleAddToCart} />
      </section>

      <section id="beneficios" className="home-snap-section">
        <BenefitsSection />
      </section>

      <section id="reseñas" className="home-snap-section">
        <ReviewsSection />
      </section>

      <WhatsAppButton />
    </>
  )
}
