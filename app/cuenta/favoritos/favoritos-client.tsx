"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Heart, Loader2 } from "lucide-react"

import SharedProductCard from "@/components/products/shared/shared-product-card"
import { useAuth } from "@/context/auth-context"
import { useCart } from "@/context/cart-context"
import { supabase } from "@/lib/supabase/client"
import type { SupabaseProducto } from "@/lib/supabase/types"

const FAVORITES_PRODUCT_SELECT = `
  product_id,
  created_at,
  productos (
    *,
    categorias(*),
    imagenes_producto(*),
    producto_variantes(*),
    producto_especificaciones(*)
  )
`

export function FavoritosClient() {
  const { user, isLoading } = useAuth()
  const { addToCart } = useCart()
  const [products, setProducts] = useState<SupabaseProducto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  useEffect(() => {
    let active = true

    async function loadFavorites() {
      if (isLoading) return

      if (!user) {
        setProducts([])
        setLoading(false)
        return
      }

      setLoading(true)
      setError("")

      const { data, error: favoritesError } = await supabase
        .from("product_favorites")
        .select(FAVORITES_PRODUCT_SELECT)
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })

      if (!active) return

      if (favoritesError) {
        setError("No pudimos cargar tus favoritos.")
        setLoading(false)
        return
      }

      setProducts(
        (data ?? [])
          .map((item) => item.productos as unknown as SupabaseProducto | null)
          .filter((product): product is SupabaseProducto => Boolean(product))
      )
      setLoading(false)
    }

    void loadFavorites()

    return () => {
      active = false
    }
  }, [isLoading, user])

  const handleFavoriteChange = (
    product: SupabaseProducto,
    isFavorite: boolean
  ) => {
    if (isFavorite) return

    setProducts((current) =>
      current.filter((item) => item.id !== product.id)
    )
  }

  if (isLoading || loading) {
    return (
      <main className="min-h-screen bg-black px-4 pt-32 text-white lg:px-8">
        <div className="mx-auto flex max-w-[var(--beyonix-content-max)] items-center justify-center py-24">
          <Loader2 className="size-8 animate-spin text-beyonix-sky" />
        </div>
      </main>
    )
  }

  if (!user) {
    return (
      <main className="min-h-screen bg-black px-4 pt-32 text-white lg:px-8">
        <div className="mx-auto max-w-md rounded-3xl border border-beyonix-blue-light/20 bg-[#071018] p-8 text-center">
          <Heart className="mx-auto mb-4 size-10 text-beyonix-sky" />
          <h1 className="text-2xl font-black">Favoritos</h1>
          <p className="mt-2 text-sm text-white/62">
            Iniciá sesión para guardar y ver tus productos favoritos.
          </p>
          <Link
            href="/login?redirect=/cuenta/favoritos"
            className="mt-6 inline-flex h-11 items-center justify-center rounded-2xl bg-white px-6 text-sm font-black text-black transition hover:bg-white/90"
          >
            Iniciar sesión
          </Link>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-black px-4 pb-16 pt-32 text-white lg:px-8">
      <section className="mx-auto max-w-[var(--beyonix-content-max)]">
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="mb-1 text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
              Mi cuenta
            </p>
            <h1 className="text-3xl font-black text-white">Favoritos</h1>
            <p className="mt-2 text-sm text-white/62">
              Tus productos guardados para volver a encontrarlos rápido.
            </p>
          </div>
          <Link
            href="/productos"
            className="inline-flex h-11 min-w-150px items-center justify-center rounded-2xl border border-beyonix-blue-light/28 bg-beyonix-blue/22 px-5 text-sm font-black text-white/86 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-all duration-200 hover:border-beyonix-sky/42 hover:bg-beyonix-blue/36 hover:text-white hover:shadow-[0_0_16px_rgba(96,165,250,0.12),inset_0_1px_0_rgba(255,255,255,0.06)]"
          >
            Ver productos
          </Link>
        </div>

        {error ? (
          <div className="rounded-2xl border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        ) : products.length ? (
          <div className="grid grid-cols-1 items-stretch justify-start justify-items-stretch gap-[clamp(1rem,1.4vw,1.35rem)] sm:grid-cols-product-cards-2 xl:grid-cols-product-cards-4">
            {products.map((product) => (
              <SharedProductCard
                key={product.id}
                product={product}
                onOpenPreview={() => {
                  window.location.href = `/productos/${product.slug}`
                }}
                onAddToCart={(nextProduct, color, image) => {
                  addToCart(nextProduct, color, image)
                }}
                onFavoriteChange={handleFavoriteChange}
              />
            ))}
          </div>
        ) : (
          <div className="rounded-3xl border border-beyonix-blue-light/20 bg-[#071018] px-6 py-14 text-center">
            <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl border border-beyonix-blue-light/30 bg-beyonix-blue/35 text-beyonix-sky">
              <Heart className="size-6 text-white" />
            </div>
            <h2 className="text-xl font-black text-white">
              Todavía no agregaste productos a favoritos.
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-white/58">
              Tocá el corazón en cualquier producto para guardarlo acá.
            </p>
          </div>
        )}
      </section>
    </main>
  )
}
