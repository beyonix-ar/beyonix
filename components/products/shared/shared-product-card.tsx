"use client"

import {
  useEffect,
  useRef,
  useState,
} from "react"
import type {
  SupabaseProducto,
} from "@/lib/supabase/types"
import {
  ArrowRight,
  Heart,
  Star,
} from "lucide-react"

import { useCart } from "@/context/cart-context"
import { useAuth } from "@/context/auth-context"
import { supabase } from "@/lib/supabase/client"

import { ProductCardImage } from "./product-card-image"

import { ProductCardPricing } from "./product-card-pricing"
import {
  getDefaultVariantOption,
} from "@/lib/products/product-variants"
import { getInstallmentsLabel } from "@/lib/products/installments"

interface SharedProductCardProps {
  product: SupabaseProducto

  onOpenPreview?: (
    product: SupabaseProducto
  ) => void

  onAddToCart?: (
    product: SupabaseProducto,
    color: string,
    image?: string
  ) => void

  onFavoriteChange?: (
    product: SupabaseProducto,
    isFavorite: boolean
  ) => void
}

export default function SharedProductCard({
  product,
  onOpenPreview,
  onAddToCart,
  onFavoriteChange,
}: SharedProductCardProps) {
  const { user } = useAuth()
  const {
    getQuantity,
    increaseQuantity,
    decreaseQuantity,
  } = useCart()
  const feedbackTimerRef =
    useRef<ReturnType<typeof setTimeout> | null>(null)
  const [isFavorite, setIsFavorite] =
    useState(false)
  const [favoriteLoading, setFavoriteLoading] =
    useState(false)
  const [favoriteFeedback, setFavoriteFeedback] =
    useState("")

  const defaultVariant =
    getDefaultVariantOption(product)

  if (!defaultVariant) return null

  const image =
    defaultVariant.images[0]

  const quantity =
    getQuantity(
      product.id,
      defaultVariant.value
    )

  const discountPercentage =
    product.precio_anterior &&
    product.precio_anterior >
      product.precio
      ? Math.round(
          (1 -
            product.precio /
              product.precio_anterior) *
            100
        )
      : null
  const installmentsLabel =
    getInstallmentsLabel(product)
  const ratingSeed = String(product.id)
    .split("")
    .reduce(
      (total, character) => total + character.charCodeAt(0),
      0
    )
  const ratingCount = 18 + (ratingSeed % 37)

  useEffect(() => {
    let active = true

    async function loadFavorite() {
      if (!user) {
        setIsFavorite(false)
        return
      }

      const { data, error } = await supabase
        .from("product_favorites")
        .select("id")
        .eq("user_id", user.id)
        .eq("product_id", product.id)
        .maybeSingle()

      if (!active) return

      if (!error) {
        setIsFavorite(Boolean(data))
      }
    }

    void loadFavorite()

    return () => {
      active = false
    }
  }, [product.id, user])

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current) {
        clearTimeout(feedbackTimerRef.current)
      }
    }
  }, [])

  const showFavoriteFeedback = (message: string) => {
    setFavoriteFeedback(message)

    if (feedbackTimerRef.current) {
      clearTimeout(feedbackTimerRef.current)
    }

    feedbackTimerRef.current = setTimeout(() => {
      setFavoriteFeedback("")
    }, 2200)
  }

  const handleAddToCart = () => {
    onAddToCart?.(
      product,
      defaultVariant.value,
      image
    )
  }

  const handleToggleFavorite = async () => {
    if (!user) {
      showFavoriteFeedback("Iniciá sesión para guardar favoritos")
      return
    }

    if (favoriteLoading) return

    setFavoriteLoading(true)

    if (isFavorite) {
      const { error } = await supabase
        .from("product_favorites")
        .delete()
        .eq("user_id", user.id)
        .eq("product_id", product.id)

      if (!error) {
        setIsFavorite(false)
        onFavoriteChange?.(product, false)
        showFavoriteFeedback("Producto eliminado de favoritos")
      } else {
        showFavoriteFeedback("No se pudo actualizar favoritos")
      }

      setFavoriteLoading(false)
      return
    }

    const { error } = await supabase
      .from("product_favorites")
      .insert({
        user_id: user.id,
        product_id: product.id,
      })

    if (!error) {
      setIsFavorite(true)
      onFavoriteChange?.(product, true)
      showFavoriteFeedback("Producto agregado a favoritos")
    } else if (
      typeof error.message === "string" &&
      error.message.toLowerCase().includes("duplicate")
    ) {
      setIsFavorite(true)
      showFavoriteFeedback("Producto agregado a favoritos")
    } else {
      showFavoriteFeedback("No se pudo actualizar favoritos")
    }

    setFavoriteLoading(false)
  }

  return (
    <article
      onClick={() => onOpenPreview?.(product)}
      className="beyonix-product-card group flex h-full w-full cursor-pointer flex-col overflow-hidden rounded-xl"
    >
      <div className="relative">
        <ProductCardImage
          image={image}
          canNavigate={false}
          onPrev={() => {}}
          onNext={() => {}}
          productName={product.nombre}
        />

        {!!discountPercentage && (
          <span className="absolute left-3 top-3 z-10 rounded-md border border-green-400/35 bg-green-600/90 px-2 py-1 text-11px font-bold text-white shadow-[0_0_18px_rgba(22,163,74,0.28)]">
            -{discountPercentage}%
          </span>
        )}

        <button
          type="button"
          aria-label={
            isFavorite
              ? `Quitar ${product.nombre} de favoritos`
              : `Marcar ${product.nombre} como favorito`
          }
          title={isFavorite ? "Quitar de favoritos" : "Favorito"}
          disabled={favoriteLoading}
          onClick={(event) => {
            event.stopPropagation()
            void handleToggleFavorite()
          }}
          className={`absolute right-3 top-3 z-10 flex size-9 cursor-pointer items-center justify-center rounded-full border backdrop-blur-md transition-all disabled:cursor-wait ${
            isFavorite
              ? "border-beyonix-sky/50 bg-beyonix-blue/70 text-beyonix-sky shadow-[0_0_16px_rgba(140,200,242,0.18)]"
              : "border-beyonix-blue-light/24 bg-black/58 text-white/72 hover:border-beyonix-sky/48 hover:bg-beyonix-blue/42 hover:text-white"
          }`}
        >
          <Heart className={`size-4 ${isFavorite ? "fill-current" : ""}`} />
        </button>

        {favoriteFeedback ? (
          <div className="absolute right-3 top-14 z-20 max-w-220px rounded-xl border border-beyonix-blue-light/25 bg-[#071018]/95 px-3 py-2 text-left text-11px font-bold text-white/86 shadow-[0_14px_34px_rgba(0,0,0,0.34)]">
            {favoriteFeedback}
          </div>
        ) : null}
      </div>

      <div className="flex flex-1 flex-col p-4">
        <p className="min-h-18px truncate text-10px font-bold uppercase tracking-[0.16em] text-beyonix-sky/82">
          {
            product.categorias
              ?.nombre
          }
        </p>

        <h3
          className="mt-1.5 min-h-44px line-clamp-2 text-15px font-semibold leading-product-title tracking-tight text-white transition-colors group-hover:text-white sm:text-16px"
        >
          {product.nombre}
        </h3>

        <div className="mt-2 flex items-center gap-1.5 text-11px text-yellow-400">
          {[0, 1, 2, 3, 4].map((item) => (
            <Star
              key={item}
              className="size-3.5 fill-current"
            />
          ))}
          <span className="ml-1 text-white/48">({ratingCount})</span>
        </div>

        <div className="mt-3 border-t border-beyonix-blue-light/12 pt-3">
          <ProductCardPricing
            price={product.precio}
            originalPrice={
              product.precio_anterior ||
              undefined
            }
            discountPercentage={
              discountPercentage
            }
            installmentsLabel={
              installmentsLabel
            }
            quantity={quantity}
            maxReached={
              defaultVariant.stock < 1 ||
              quantity >= defaultVariant.stock
            }
            onAddToCart={
              handleAddToCart
            }
            onIncrease={() =>
              increaseQuantity(
                product.id,
                defaultVariant.value
              )
            }
            onDecrease={() =>
              decreaseQuantity(
                product.id,
                defaultVariant.value
              )
            }
          />
        </div>

        <button
          type="button"
          aria-label={`Ver ${product.nombre}`}
          title={`Ver ${product.nombre}`}
          onClick={(event) => {
            event.stopPropagation()
            onOpenPreview?.(product)
          }}
          className="mt-3 flex h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-beyonix-blue-light/22 bg-black/28 text-13px font-semibold text-white/86 transition-all duration-200 hover:border-beyonix-sky/48 hover:bg-beyonix-blue/32 hover:text-white hover:shadow-[0_0_18px_rgba(30,140,255,0.16)]"
        >
          Ver producto
          <ArrowRight className="size-3.5" />
        </button>
      </div>
    </article>
  )
}
