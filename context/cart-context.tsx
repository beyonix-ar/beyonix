"use client"

import { usePathname, useRouter } from "next/navigation"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"

import type { SupabaseProducto } from "@/lib/supabase/types"
import {
  getSafeSupabaseSession,
  supabase,
} from "@/lib/supabase/client"
import { DEFAULT_VARIANT_VALUE } from "@/lib/products/product-variants"
import {
  getProductImage,
  normalizeCart,
  resolveCartVariant,
  toFiniteNumber,
  type CartItem,
} from "@/lib/cart/cart-items"
import {
  resolveCartOnSignIn,
  resolveCartOnSignOut,
  type CartAuthOwner,
  type GuestCartHandoff,
} from "@/lib/cart/guest-cart-handoff"
import { getMaxPurchasableQuantity } from "@/lib/cart/stock-status"
import { createCartSessionId } from "@/lib/cart/cart-session-id"
import { reconcileCartWithCatalog } from "@/lib/cart/cart-catalog-refresh"
import { getStoreCartProducts } from "@/lib/supabase/queries/store"
import {
  abandonCheckoutReservation,
  isCheckoutPath,
  pendingCheckoutReleases,
  releaseAbandonedCheckoutReservations,
} from "@/lib/cart/checkout-abandonment"
import { reserveCartStock } from "@/lib/cart/stock-reservations"
import { trackAddToCart } from "@/lib/analytics/track-commerce"

export type { CartItem }

export interface CartCatalogRefreshResult {
  /** Cambió precio, cuotas, stock o se quitó alguna línea del carrito. */
  changed: boolean
  removedCount: number
  /** Cambió el precio/descuento de una línea que sigue en el carrito. */
  priceChanged: boolean
  /** Cambió el stock vendible de una línea que sigue en el carrito. */
  availabilityChanged: boolean
}

const NO_CART_CATALOG_CHANGE: CartCatalogRefreshResult = {
  changed: false,
  removedCount: 0,
  priceChanged: false,
  availabilityChanged: false,
}

interface CartContextType {
  cart: CartItem[]
  total: number
  itemCount: number
  cartSessionId: string
  isOpen: boolean
  isReady: boolean
  /** `track: false` para vistas previas del Admin (no son demanda de clientes). */
  addToCart: (product: SupabaseProducto, color: string, image?: string, options?: { track?: boolean }) => void
  removeFromCart: (productId: number, color: string) => void
  updateQuantity: (productId: number, color: string, quantity: number) => void
  increaseQuantity: (productId: number, color: string) => void
  decreaseQuantity: (productId: number, color: string) => void
  getQuantity: (productId: number, color: string) => number
  isInCart: (productId: number, color: string) => boolean
  clearCart: () => void
  /** Nueva identidad de checkout tras vencer una reserva; conserva el carrito. */
  startNewCheckoutSession: () => void
  /** Vuelve a leer el catálogo vigente de los productos del carrito (sólo UX: pagar siempre revalida server-side). */
  refreshCartCatalog: () => Promise<CartCatalogRefreshResult>
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

export function CartProvider({ children }: { children: ReactNode }) {
  const [cart, setCart] = useState<CartItem[]>([])
  const [cartSessionId, setCartSessionId] = useState("")
  const [isOpen, setIsOpen] = useState(false)
  const [hasHydrated, setHasHydrated] = useState(false)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const cartRef = useRef<CartItem[]>([])
  const cartSessionIdRef = useRef("")
  const cartOwnerRef = useRef<CartAuthOwner>({ kind: "unknown" })
  const guestCartHandoffRef = useRef<GuestCartHandoff | null>(null)

  useEffect(() => {
    cartRef.current = cart
  }, [cart])

  useEffect(() => {
    cartSessionIdRef.current = cartSessionId
  }, [cartSessionId])

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
    const readStoredAccountCart = (userId: string) => {
      try {
        const stored = localStorage.getItem(getUserCartStorageKey(userId))
        return stored ? normalizeCart(JSON.parse(stored)) : []
      } catch {
        localStorage.removeItem(getUserCartStorageKey(userId))
        return []
      }
    }

    const writeCartStorage = (userId: string | null, nextCart: CartItem[]) => {
      if (nextCart.length > 0) {
        sessionStorage.setItem(CART_STORAGE_KEY, JSON.stringify(nextCart))
        if (userId) localStorage.setItem(getUserCartStorageKey(userId), JSON.stringify(nextCart))
      } else {
        sessionStorage.removeItem(CART_STORAGE_KEY)
        if (userId) localStorage.removeItem(getUserCartStorageKey(userId))
      }
    }

    // Ver `lib/cart/guest-cart-handoff.ts`: un invitado confirmado conserva
    // su carrito al iniciar sesión (se une con el de la cuenta); una sesión
    // ya existente restaura el de la cuenta como siempre. Se escribe en
    // storage en el acto para que un segundo SIGNED_IN/TOKEN_REFRESHED lea
    // el carrito ya unido y no vuelva a sumar.
    const restoreUserCart = (userId: string) => {
      const { cart: nextCart, handoff } = resolveCartOnSignIn({
        owner: cartOwnerRef.current,
        userId,
        currentCart: cartRef.current,
        storedAccountCart: readStoredAccountCart(userId),
      })

      cartOwnerRef.current = { kind: "user", userId }
      if (handoff && window.location.pathname.startsWith("/login")) {
        guestCartHandoffRef.current = handoff
      }
      setCurrentUserId(userId)
      setCart(nextCart)
      writeCartStorage(userId, nextCart)
    }

    const markGuestIfUnknown = () => {
      if (cartOwnerRef.current.kind === "unknown") {
        cartOwnerRef.current = { kind: "guest" }
      }
    }

    getSafeSupabaseSession()
      .then((session) => {
        if (!session?.user) {
          markGuestIfUnknown()
          return
        }

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
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "INITIAL_SESSION" && !session?.user) {
        markGuestIfUnknown()
        return
      }

      if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
        const user = session?.user

        if (!user) return

        try {
          restoreUserCart(user.id)
        } catch {
          setCurrentUserId(user.id)
          setCart([])
          sessionStorage.removeItem(CART_STORAGE_KEY)
          localStorage.removeItem(getUserCartStorageKey(user.id))
        }

        return
      }

      if (event !== "SIGNED_OUT") return

      // Un logout real vacía el carrito como siempre. Sólo si la sesión
      // recién traspasada se rechaza enseguida (seguimos en /login) se
      // devuelve el carrito del invitado y el de la cuenta queda como estaba.
      const { cart: nextCart, restoreAccount } = resolveCartOnSignOut(
        guestCartHandoffRef.current,
      )
      guestCartHandoffRef.current = null
      cartOwnerRef.current = { kind: "guest" }
      if (restoreAccount) writeCartStorage(restoreAccount.userId, restoreAccount.cart)

      setCurrentUserId(null)
      setCart(nextCart)
      setIsOpen(false)
      localStorage.removeItem(CART_STORAGE_KEY)
      if (nextCart.length > 0) {
        sessionStorage.setItem(CART_STORAGE_KEY, JSON.stringify(nextCart))
      } else {
        sessionStorage.removeItem(CART_STORAGE_KEY)
      }
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
    options?: { track?: boolean },
  ) => {
    const variant = resolveCartVariant(product, color)
    const variantColor = variant?.value ?? DEFAULT_VARIANT_VALUE
    // Tope = min(3, disponible). Disponible = físico - reservas activas
    // (lib/inventory/sellable-stock.ts); reserve_cart_stock es la autoridad.
    const maxQuantity = getMaxPurchasableQuantity(product, variantColor)
    const normalizedProduct = {
      ...product,
      precio: toFiniteNumber(product.precio),
    }

    if (maxQuantity < 1) return

    // Analítica: sólo si el carrito va a crecer de verdad, y fuera del
    // updater (React puede ejecutarlo dos veces en Strict Mode).
    const current = cartRef.current.find(
      (item) => item.product.id === normalizedProduct.id && item.color === variantColor,
    )
    if (options?.track !== false && (current?.quantity ?? 0) < maxQuantity) {
      trackAddToCart(normalizedProduct.id, current?.variantId ?? variant?.id ?? null)
    }

    setCart((prev) => {
      const existing = prev.find(
        (item) =>
          item.product.id === normalizedProduct.id &&
          item.color === variantColor,
      )

      if (existing) {
        if (existing.quantity >= maxQuantity) return prev

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
          conditionedStockId: variant?.conditionedStockId ?? null,
          variantName: variant?.name ?? null,
          colorHex: variant?.colorHex ?? null,
          secondaryColorHex: variant?.secondaryColorHex ?? null,
          unitPrice: variant?.price ?? normalizedProduct.precio,
          originalUnitPrice: variant?.originalPrice ?? null,
          discountReason: variant?.reason ?? null,
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
      prev.map((item) => {
        if (item.product.id !== productId || item.color !== color) {
          return item
        }

        // Bajar siempre se permite (así se corrige una línea marcada); subir
        // no puede superar el disponible actual.
        if (
          nextQuantity > item.quantity &&
          nextQuantity > getMaxPurchasableQuantity(item.product, item.color)
        ) {
          return item
        }

        return {
          ...item,
          quantity: nextQuantity,
        }
      }),
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
    const item = cartRef.current.find((line) => line.product.id === productId && line.color === color)
    // Misma regla que updateQuantity: sumar una unidad sólo si entra en el tope.
    if (item && item.quantity + 1 <= getMaxPurchasableQuantity(item.product, item.color)) {
      trackAddToCart(productId, item.variantId)
    }
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

  const startNewCheckoutSession = useCallback(() => {
    const nextSessionId = createCartSessionId()
    sessionStorage.setItem(CART_SESSION_STORAGE_KEY, nextSessionId)
    setCartSessionId(nextSessionId)
  }, [])

  // Salir de /checkout (link, "Volver" del navegador o recarga en otra
  // página) libera la reserva del Paso 3 en el momento, sin esperar los 20
  // minutos. Moverse entre pasos dentro de /checkout no la toca.
  const pathname = usePathname()
  const router = useRouter()
  const checkoutReleaseInFlightRef = useRef(false)

  // Fuera de /login la sesión ya fue aceptada (o nunca hubo traspaso): desde
  // ahí un SIGNED_OUT es un logout real y vacía el carrito como siempre.
  useEffect(() => {
    if (!pathname?.startsWith("/login")) guestCartHandoffRef.current = null
  }, [pathname])
  useEffect(() => {
    if (!hasHydrated || isCheckoutPath(pathname)) return
    try {
      // Sincrónico: si vuelve a entrar ya es un checkout nuevo, con su
      // propia identidad y sus 20 minutos completos.
      const abandoned = abandonCheckoutReservation(sessionStorage)
      if (abandoned && abandoned === cartSessionIdRef.current) startNewCheckoutSession()
      if (checkoutReleaseInFlightRef.current || !pendingCheckoutReleases(sessionStorage).length) return
    } catch {
      return
    }
    checkoutReleaseInFlightRef.current = true
    void releaseAbandonedCheckoutReservations(sessionStorage, (sessionId) =>
      reserveCartStock({ sessionId, items: [] }),
    )
      // La página actual pudo renderizarse con esas unidades todavía
      // reservadas: se vuelve a pedir con el stock ya liberado.
      .then(({ released }) => {
        if (released.length) router.refresh()
      })
      .catch(() => {})
      .finally(() => {
        checkoutReleaseInFlightRef.current = false
      })
  }, [hasHydrated, pathname, router, startNewCheckoutSession])

  const refreshCartCatalog = useCallback(async (): Promise<CartCatalogRefreshResult> => {
    const productIds = cartRef.current.map((item) => item.product.id)
    if (!productIds.length) return NO_CART_CATALOG_CHANGE

    // La reserva vigente de ESTE checkout no se descuenta a sí misma.
    const freshProducts = await getStoreCartProducts(productIds, {
      excludeSessionId: cartSessionIdRef.current || null,
    })
    const snapshot = reconcileCartWithCatalog(cartRef.current, freshProducts)
    if (!snapshot.changed) return NO_CART_CATALOG_CHANGE

    // Se reconcilia sobre el estado MÁS reciente (el cliente pudo cambiar
    // cantidades mientras volvía la consulta); sin cambios -> misma
    // referencia, sin re-render.
    setCart((prev) => reconcileCartWithCatalog(prev, freshProducts).items)
    return {
      changed: true,
      removedCount: snapshot.removed.length,
      priceChanged: snapshot.priceChanged,
      availabilityChanged: snapshot.availabilityChanged,
    }
  }, [])

  const { total, itemCount } = useMemo(() => {
    return cart.reduce(
      (acc, item) => {
        acc.total += item.unitPrice * item.quantity
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
        startNewCheckoutSession,
        refreshCartCatalog,
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
