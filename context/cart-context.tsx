"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"

import type { SupabaseProducto } from "@/lib/supabase/types"
import { supabase } from "@/lib/supabase/client"
import {
  DEFAULT_VARIANT_VALUE,
  FALLBACK_PRODUCT_IMAGE,
  getDefaultVariantValue,
  getProductImagesByVariant,
  getVariantOptionByValue,
} from "@/lib/products/product-variants"

export interface CartItem {
  product: SupabaseProducto
  color: string
  image: string
  quantity: number
  variantId: number | null
  variantName: string | null
  colorHex: string | null
}

interface CartContextType {
  cart: CartItem[]
  total: number
  itemCount: number
  cartSessionId: string
  isOpen: boolean
  isReady: boolean
  addToCart: (product: SupabaseProducto, color: string, image?: string) => void
  removeFromCart: (productId: number, color: string) => void
  updateQuantity: (productId: number, color: string, quantity: number) => void
  increaseQuantity: (productId: number, color: string) => void
  decreaseQuantity: (productId: number, color: string) => void
  getQuantity: (productId: number, color: string) => number
  isInCart: (productId: number, color: string) => boolean
  clearCart: () => void
  openCart: () => void
  closeCart: () => void
}

const CartContext = createContext<CartContextType | null>(null)

export const CART_STORAGE_KEY = "beyonix-cart"
export const CART_SESSION_STORAGE_KEY = "beyonix-cart-session"
const USER_CART_STORAGE_PREFIX = "beyonix-cart-user"

function getUserCartStorageKey(userId: string) {
  return `${USER_CART_STORAGE_PREFIX}:${userId}`
}

function createCartSessionId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID()
  }

  return `cart-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function toFiniteNumber(value: unknown, fallback = 0) {
  const numberValue = typeof value === "number" ? value : Number(value)

  return Number.isFinite(numberValue) ? numberValue : fallback
}

function getProductImage(product: SupabaseProducto, image?: string) {
  return image || getProductImagesByVariant(product)[0] || FALLBACK_PRODUCT_IMAGE
}

function resolveCartVariant(product: SupabaseProducto, color?: string) {
  const value =
    color && color !== DEFAULT_VARIANT_VALUE
      ? color
      : getDefaultVariantValue(product)

  return getVariantOptionByValue(product, value)
}

function normalizeCartItem(item: unknown): CartItem | null {
  if (!item || typeof item !== "object") return null

  const rawItem = item as Record<string, unknown>
  const rawProduct = rawItem.product

  if (!rawProduct || typeof rawProduct !== "object") return null

  const productRecord = rawProduct as Record<string, unknown>
  const id = toFiniteNumber(productRecord.id, NaN)
  const precio = toFiniteNumber(productRecord.precio, NaN)
  const quantity = Math.trunc(toFiniteNumber(rawItem.quantity, 1))
  const nombre = productRecord.nombre

  if (
    !Number.isFinite(id) ||
    !Number.isFinite(precio) ||
    typeof nombre !== "string" ||
    quantity < 1
  ) {
    return null
  }

  const product = {
    ...productRecord,
    id,
    nombre,
    precio,
  } as SupabaseProducto

  const rawColor =
    typeof rawItem.color === "string"
      ? rawItem.color
      : DEFAULT_VARIANT_VALUE
  const variant = resolveCartVariant(product, rawColor)
  const variantId = toFiniteNumber(rawItem.variantId, variant?.id ?? NaN)

  return {
    product,
    color: variant?.value ?? rawColor,
    image:
      typeof rawItem.image === "string" && rawItem.image.trim()
        ? rawItem.image
        : variant?.images[0] ?? getProductImage(product),
    quantity,
    variantId: Number.isFinite(variantId) ? variantId : null,
    variantName:
      typeof rawItem.variantName === "string"
        ? rawItem.variantName
        : variant?.name ?? null,
    colorHex:
      typeof rawItem.colorHex === "string"
        ? rawItem.colorHex
        : variant?.colorHex ?? null,
  }
}

function normalizeCart(items: unknown) {
  if (!Array.isArray(items)) return []

  return items.reduce<CartItem[]>((acc, item) => {
    const normalized = normalizeCartItem(item)

    if (!normalized) return acc

    const existing = acc.find(
      (cartItem) =>
        cartItem.product.id === normalized.product.id &&
        cartItem.color === normalized.color,
    )

    if (existing) {
      existing.quantity += normalized.quantity
      return acc
    }

    acc.push(normalized)
    return acc
  }, [])
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [cart, setCart] = useState<CartItem[]>([])
  const [cartSessionId, setCartSessionId] = useState("")
  const [isOpen, setIsOpen] = useState(false)
  const [hasHydrated, setHasHydrated] = useState(false)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)

  useEffect(() => {
    try {
      localStorage.removeItem(CART_STORAGE_KEY)

      const storedSessionId = sessionStorage.getItem(CART_SESSION_STORAGE_KEY)
      const nextSessionId = storedSessionId || createCartSessionId()

      sessionStorage.setItem(CART_SESSION_STORAGE_KEY, nextSessionId)
      setCartSessionId(nextSessionId)

      const stored = sessionStorage.getItem(CART_STORAGE_KEY)
      setCart(stored ? normalizeCart(JSON.parse(stored)) : [])
    } catch {
      localStorage.removeItem(CART_STORAGE_KEY)
      sessionStorage.removeItem(CART_STORAGE_KEY)
      sessionStorage.removeItem(CART_SESSION_STORAGE_KEY)
      const nextSessionId = createCartSessionId()
      sessionStorage.setItem(CART_SESSION_STORAGE_KEY, nextSessionId)
      setCartSessionId(nextSessionId)
      setCart([])
    } finally {
      setHasHydrated(true)
    }
  }, [])

  useEffect(() => {
    if (!hasHydrated) return

    if (cart.length === 0) {
      sessionStorage.removeItem(CART_STORAGE_KEY)
      if (currentUserId) {
        localStorage.removeItem(getUserCartStorageKey(currentUserId))
      }
      return
    }

    sessionStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart))
    if (currentUserId) {
      localStorage.setItem(
        getUserCartStorageKey(currentUserId),
        JSON.stringify(cart),
      )
    }
  }, [cart, currentUserId, hasHydrated])

  useEffect(() => {
    const restoreUserCart = (userId: string) => {
      const stored = localStorage.getItem(getUserCartStorageKey(userId))
      const storedCart = stored ? normalizeCart(JSON.parse(stored)) : []

      setCurrentUserId(userId)
      setCart(storedCart)

      if (storedCart.length > 0) {
        sessionStorage.setItem(CART_STORAGE_KEY, JSON.stringify(storedCart))
      } else {
        sessionStorage.removeItem(CART_STORAGE_KEY)
      }
    }

    supabase.auth
      .getSession()
      .then(({ data: { session } }) => {
        if (!session?.user) return

        try {
          restoreUserCart(session.user.id)
        } catch {
          setCurrentUserId(session.user.id)
          setCart([])
          sessionStorage.removeItem(CART_STORAGE_KEY)
          localStorage.removeItem(getUserCartStorageKey(session.user.id))
        }
      })
      .catch(() => {
        setCurrentUserId(null)
      })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
        supabase.auth.getUser().then(({ data: { user } }) => {
          if (!user) return

          try {
            restoreUserCart(user.id)
          } catch {
            setCurrentUserId(user.id)
            setCart([])
            sessionStorage.removeItem(CART_STORAGE_KEY)
            localStorage.removeItem(getUserCartStorageKey(user.id))
          }
        })

        return
      }

      if (event !== "SIGNED_OUT") return

      setCurrentUserId(null)
      setCart([])
      setIsOpen(false)
      localStorage.removeItem(CART_STORAGE_KEY)
      sessionStorage.removeItem(CART_STORAGE_KEY)
      sessionStorage.removeItem(CART_SESSION_STORAGE_KEY)
      const nextSessionId = createCartSessionId()
      sessionStorage.setItem(CART_SESSION_STORAGE_KEY, nextSessionId)
      setCartSessionId(nextSessionId)
    })

    return () => subscription.unsubscribe()
  }, [])

  const addToCart = (
    product: SupabaseProducto,
    color: string,
    image?: string,
  ) => {
    const variant = resolveCartVariant(product, color)
    const variantColor = variant?.value ?? DEFAULT_VARIANT_VALUE
    const normalizedProduct = {
      ...product,
      precio: toFiniteNumber(product.precio),
    }

    setCart((prev) => {
      const existing = prev.find(
        (item) =>
          item.product.id === normalizedProduct.id &&
          item.color === variantColor,
      )

      if (existing) {
        return prev.map((item) =>
          item.product.id === normalizedProduct.id &&
          item.color === variantColor
            ? { ...item, quantity: item.quantity + 1 }
            : item,
        )
      }

      return [
        ...prev,
        {
          product: normalizedProduct,
          color: variantColor,
          image:
            image ||
            variant?.images[0] ||
            getProductImage(normalizedProduct),
          quantity: 1,
          variantId: variant?.id ?? null,
          variantName: variant?.name ?? null,
          colorHex: variant?.colorHex ?? null,
        },
      ]
    })
  }

  const removeFromCart = (productId: number, color: string) => {
    setCart((prev) =>
      prev.filter(
        (item) => !(item.product.id === productId && item.color === color),
      ),
    )
  }

  const updateQuantity = (
    productId: number,
    color: string,
    quantity: number,
  ) => {
    const nextQuantity = Math.trunc(toFiniteNumber(quantity))

    if (nextQuantity < 1) {
      removeFromCart(productId, color)
      return
    }

    setCart((prev) =>
      prev.map((item) =>
        item.product.id === productId && item.color === color
          ? { ...item, quantity: nextQuantity }
          : item,
      ),
    )
  }

  const getQuantity = (productId: number, color: string) => {
    return (
      cart.find(
        (item) => item.product.id === productId && item.color === color,
      )?.quantity ?? 0
    )
  }

  const increaseQuantity = (productId: number, color: string) => {
    updateQuantity(productId, color, getQuantity(productId, color) + 1)
  }

  const decreaseQuantity = (productId: number, color: string) => {
    updateQuantity(productId, color, getQuantity(productId, color) - 1)
  }

  const isInCart = (productId: number, color: string) => {
    return cart.some(
      (item) => item.product.id === productId && item.color === color,
    )
  }

  const clearCart = useCallback(() => {
    setCart([])
    setIsOpen(false)
    localStorage.removeItem(CART_STORAGE_KEY)
    if (currentUserId) {
      localStorage.removeItem(getUserCartStorageKey(currentUserId))
    }
    sessionStorage.removeItem(CART_STORAGE_KEY)
    sessionStorage.removeItem(CART_SESSION_STORAGE_KEY)
    const nextSessionId = createCartSessionId()
    sessionStorage.setItem(CART_SESSION_STORAGE_KEY, nextSessionId)
    setCartSessionId(nextSessionId)

    void supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return

      localStorage.removeItem(getUserCartStorageKey(user.id))
      setCart([])
    })
  }, [currentUserId])

  const { total, itemCount } = useMemo(() => {
    return cart.reduce(
      (acc, item) => {
        acc.total += item.product.precio * item.quantity
        acc.itemCount += item.quantity
        return acc
      },
      { total: 0, itemCount: 0 },
    )
  }, [cart])

  return (
    <CartContext.Provider
      value={{
        cart,
        total,
        itemCount,
        cartSessionId,
        isOpen,
        isReady: hasHydrated,
        addToCart,
        removeFromCart,
        updateQuantity,
        increaseQuantity,
        decreaseQuantity,
        getQuantity,
        isInCart,
        clearCart,
        openCart: () => setIsOpen(true),
        closeCart: () => setIsOpen(false),
      }}
    >
      {children}
    </CartContext.Provider>
  )
}

export function useCart() {
  const context = useContext(CartContext)

  if (!context) {
    throw new Error("useCart must be used inside CartProvider")
  }

  return context
}
