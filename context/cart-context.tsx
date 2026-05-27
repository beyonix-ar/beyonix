"use client"

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react"

import type {
  SupabaseProducto,
} from "@/lib/supabase/types"

interface CartItem {
  product: SupabaseProducto
  color: string
  image: string
  quantity: number
}

interface CartContextType {
  cart: CartItem[]

  total: number

  isOpen: boolean

  addToCart: (
    product: SupabaseProducto,
    color: string,
    image?: string
  ) => void

  removeFromCart: (
    productId: number,
    color: string
  ) => void

  updateQuantity: (
    productId: number,
    color: string,
    quantity: number
  ) => void

  increaseQuantity: (
    productId: number,
    color: string
  ) => void

  decreaseQuantity: (
    productId: number,
    color: string
  ) => void

  getQuantity: (
    productId: number,
    color: string
  ) => number

  isInCart: (
    productId: number,
    color: string
  ) => boolean

  clearCart: () => void

  openCart: () => void

  closeCart: () => void
}

const CartContext =
  createContext<CartContextType | null>(
    null
  )

const STORAGE_KEY =
  "beyonix-cart"

export function CartProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [cart, setCart] = useState<
    CartItem[]
  >([])

  const [isOpen, setIsOpen] =
    useState(false)

  // ─────────────────────────────────────
  // Hydration
  // ─────────────────────────────────────

  useEffect(() => {
    try {
      const stored =
        localStorage.getItem(
          STORAGE_KEY
        )

      if (!stored) {
        return
      }

      const parsed =
        JSON.parse(stored)

      if (!Array.isArray(parsed)) {
        return
      }

      const validCart =
        parsed.filter(
          (item) =>
            item?.product?.id &&
            item?.product?.nombre &&
            typeof item?.product
              ?.precio ===
              "number"
        )

      setCart(validCart)
    } catch (error) {
      console.error(error)

      localStorage.removeItem(
        STORAGE_KEY
      )
    }
  }, [])

  // ─────────────────────────────────────
  // Persist
  // ─────────────────────────────────────

  useEffect(() => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(cart)
    )
  }, [cart])

  // ─────────────────────────────────────
  // Add
  // ─────────────────────────────────────

  const addToCart = (
    product: SupabaseProducto,
    color: string,
    image?: string
  ) => {
    setCart((prev) => {
      const exists = prev.find(
        (item) =>
          item.product.id ===
            product.id &&
          item.color === color
      )

      if (exists) {
        return prev.map((item) =>
          item.product.id ===
            product.id &&
          item.color === color
            ? {
                ...item,
                quantity:
                  item.quantity + 1,
              }
            : item
        )
      }

      return [
        ...prev,
        {
          product,
          color,

          image:
            image ||
            product
              .imagen_principal ||
            product
              .imagenes_producto?.[0]
              ?.url ||
            "/placeholder.svg",

          quantity: 1,
        },
      ]
    })
  }

  // ─────────────────────────────────────
  // Remove
  // ─────────────────────────────────────

  const removeFromCart = (
    productId: number,
    color: string
  ) => {
    setCart((prev) =>
      prev.filter(
        (item) =>
          !(
            item.product.id ===
              productId &&
            item.color === color
          )
      )
    )
  }

  // ─────────────────────────────────────
  // Update quantity
  // ─────────────────────────────────────

  const updateQuantity = (
    productId: number,
    color: string,
    quantity: number
  ) => {
    if (quantity <= 0) {
      removeFromCart(
        productId,
        color
      )

      return
    }

    setCart((prev) =>
      prev.map((item) =>
        item.product.id ===
          productId &&
        item.color === color
          ? {
              ...item,
              quantity,
            }
          : item
      )
    )
  }

  const increaseQuantity = (
    productId: number,
    color: string
  ) => {
    updateQuantity(
      productId,
      color,
      getQuantity(
        productId,
        color
      ) + 1
    )
  }

  const decreaseQuantity = (
    productId: number,
    color: string
  ) => {
    updateQuantity(
      productId,
      color,
      getQuantity(
        productId,
        color
      ) - 1
    )
  }

  // ─────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────

  const getQuantity = (
    productId: number,
    color: string
  ) => {
    return (
      cart.find(
        (item) =>
          item.product.id ===
            productId &&
          item.color === color
      )?.quantity || 0
    )
  }

  const isInCart = (
    productId: number,
    color: string
  ) => {
    return cart.some(
      (item) =>
        item.product.id ===
          productId &&
        item.color === color
    )
  }

  const clearCart = () => {
    setCart([])
  }

  // ─────────────────────────────────────
  // Total
  // ─────────────────────────────────────

  const total = useMemo(() => {
    return cart.reduce(
      (sum, item) =>
        sum +
        item.product.precio *
          item.quantity,
      0
    )
  }, [cart])

  return (
    <CartContext.Provider
      value={{
        cart,

        total,

        isOpen,

        addToCart,

        removeFromCart,

        updateQuantity,

        increaseQuantity,

        decreaseQuantity,

        getQuantity,

        isInCart,

        clearCart,

        openCart: () =>
          setIsOpen(true),

        closeCart: () =>
          setIsOpen(false),
      }}
    >
      {children}
    </CartContext.Provider>
  )
}

export function useCart() {
  const context =
    useContext(CartContext)

  if (!context) {
    throw new Error(
      "useCart must be used inside CartProvider"
    )
  }

  return context
}