"use client"

import { createContext, useContext, useState } from "react"
import type { StoreProduct } from "@/lib/types/product"

type CartItem = {
  product: StoreProduct
  color: string
  image: string
  quantity: number
}

type CartContextType = {
  cart: CartItem[]

  addToCart: (
    product: StoreProduct,
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

  clearCart: () => void

  total: number

  isOpen: boolean

  openCart: () => void
  closeCart: () => void

  isInCart: (
    productId: number,
    color: string
  ) => boolean
}

const CartContext = createContext<CartContextType | null>(null)

export function CartProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [cart, setCart] = useState<CartItem[]>([])
  const [isOpen, setIsOpen] = useState(false)

  // ➕ AGREGAR
  const addToCart = (
    product: StoreProduct,
    color: string,
    image?: string
  ) => {
    setCart((prev) => {
      const existing = prev.find(
        (item) =>
          item.product.id === product.id &&
          item.color === color
      )

      if (existing) {
        return prev.map((item) =>
          item.product.id === product.id &&
          item.color === color
            ? {
                ...item,
                quantity: item.quantity + 1,
              }
            : item
        )
      }

      const fallbackImage =
        image ||
        product.colors?.find(
          (c) => c.value === color
        )?.images?.[0] ||
        product.colors?.[0]?.images?.[0] ||
        "/placeholder.svg"

      return [
        ...prev,
        {
          product,
          color,
          image: fallbackImage,
          quantity: 1,
        },
      ]
    })
  }

  // 🔁 UPDATE DIRECTO
  const updateQuantity = (
    productId: number,
    color: string,
    quantity: number
  ) => {
    if (quantity <= 0) {
      removeFromCart(productId, color)
      return
    }

    setCart((prev) =>
      prev.map((item) =>
        item.product.id === productId &&
        item.color === color
          ? {
              ...item,
              quantity,
            }
          : item
      )
    )
  }

  // ➕ INCREMENTAR
  const increaseQuantity = (
    productId: number,
    color: string
  ) => {
    setCart((prev) =>
      prev.map((item) =>
        item.product.id === productId &&
        item.color === color
          ? {
              ...item,
              quantity: item.quantity + 1,
            }
          : item
      )
    )
  }

  // ➖ DISMINUIR
  const decreaseQuantity = (
    productId: number,
    color: string
  ) => {
    setCart((prev) =>
      prev
        .map((item) => {
          if (
            item.product.id === productId &&
            item.color === color
          ) {
            return {
              ...item,
              quantity: item.quantity - 1,
            }
          }

          return item
        })
        .filter((item) => item.quantity > 0)
    )
  }

  // 🔢 OBTENER CANTIDAD
  const getQuantity = (
    productId: number,
    color: string
  ) => {
    const item = cart.find(
      (item) =>
        item.product.id === productId &&
        item.color === color
    )

    return item?.quantity || 0
  }

  // 🗑 ELIMINAR
  const removeFromCart = (
    productId: number,
    color: string
  ) => {
    setCart((prev) =>
      prev.filter(
        (item) =>
          !(
            item.product.id === productId &&
            item.color === color
          )
      )
    )
  }

  // 🔍 CHECK
  const isInCart = (
    productId: number,
    color: string
  ) =>
    cart.some(
      (item) =>
        item.product.id === productId &&
        item.color === color
    )

  // 🧹 CLEAR
  const clearCart = () => setCart([])

  // 💰 TOTAL
  const total = cart.reduce(
    (sum, item) =>
      sum + item.product.price * item.quantity,
    0
  )

  // 🛒 SIDEBAR
  const openCart = () => setIsOpen(true)
  const closeCart = () => setIsOpen(false)

  return (
    <CartContext.Provider
      value={{
        cart,

        addToCart,
        removeFromCart,
        updateQuantity,

        increaseQuantity,
        decreaseQuantity,
        getQuantity,

        clearCart,

        total,

        isOpen,
        openCart,
        closeCart,

        isInCart,
      }}
    >
      {children}
    </CartContext.Provider>
  )
}

export function useCart() {
  const context = useContext(CartContext)

  if (!context) {
    throw new Error(
      "useCart must be used inside CartProvider"
    )
  }

  return context
}