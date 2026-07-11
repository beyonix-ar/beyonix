"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Heart, Loader2 } from "lucide-react"

import {
  AccountCard,
  AccountEmptyState,
  AccountPageContainer,
  AccountPageHeader,
  BeyonixButton,
} from "@/components/account/account-ui"
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
      <main className="min-h-screen bg-[var(--account-background)] pt-32 text-white">
        <AccountPageContainer className="flex items-center justify-center py-24">
          <Loader2 className="size-8 animate-spin text-beyonix-sky" />
        </AccountPageContainer>
      </main>
    )
  }

  if (!user) {
    return (
      <main className="min-h-screen bg-[var(--account-background)] pt-32 text-white">
        <AccountPageContainer>
          <AccountEmptyState
            icon={<Heart className="fill-white" />}
            title="Favoritos"
            description="Iniciá sesión para guardar y ver tus productos favoritos."
            action={
              <BeyonixButton asChild size="lg">
                <Link href="/login?redirect=/cuenta/favoritos">
                  Iniciar sesión
                </Link>
              </BeyonixButton>
            }
          />
        </AccountPageContainer>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-[var(--account-background)] pb-16 pt-32 text-white">
      <AccountPageContainer asChild>
      <section>
        <AccountPageHeader
          eyebrow="Mi cuenta"
          title="Favoritos"
          description="Tus productos guardados para volver a encontrarlos rápido."
          className="mb-6"
          action={
            <BeyonixButton asChild size="lg">
              <Link href="/productos">Ver productos</Link>
            </BeyonixButton>
          }
        />

        {error ? (
          <AccountCard padding="sm" className="border-[var(--account-danger-border)] bg-[var(--account-danger-bg)] text-sm text-[var(--account-danger-text)]">
            {error}
          </AccountCard>
        ) : products.length ? (
          <div className="grid grid-cols-1 items-stretch justify-start justify-items-stretch gap-[clamp(1rem,1.4vw,1.35rem)] sm:grid-cols-product-cards-2 xl:grid-cols-product-cards-3 2xl:grid-cols-product-cards-4">
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
          <AccountEmptyState
            icon={<Heart className="fill-white" />}
            title="Todavía no agregaste productos a favoritos."
            description="Tocá el corazón en cualquier producto para guardarlo acá."
          />
        )}
      </section>
      </AccountPageContainer>
    </main>
  )
}
