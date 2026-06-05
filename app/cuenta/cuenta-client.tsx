"use client"

import { useEffect, useRef, useState } from "react"
import type { InputHTMLAttributes } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
  ChevronLeft,
  ChevronRight,
  Camera,
  Eye,
  EyeOff,
  Hash,
  Lock,
  LogOut,
  Mail,
  MapPin,
  Phone,
  Shield,
  ShoppingBag,
  User,
} from "lucide-react"

import { useAuth } from "@/context/auth-context"
import { ProvinceSelect } from "@/components/province-select"
import { supabase } from "@/lib/supabase/client"
import type { SupabasePedido } from "@/lib/supabase/types"
import {
  FIELD_LIMITS,
  onlyDigits,
  validateProfilePayload,
  validateRegisterPayload,
} from "@/lib/validation/account-fields"

function formatCuentaPrice(price: number) {
  return price.toLocaleString("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 0,
  })
}

function formatCuentaOrderDate(value: string) {
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date(value))
}

function formatPublicOrderId(id: number) {
  return `BX-${1000 + id}`
}

function getClientOrderStatusLabel(status: string) {
  const normalizedStatus = status.toLowerCase()

  if (normalizedStatus === "enviado") {
    return "Despachado"
  }

  if (normalizedStatus === "entregado") {
    return "Entregado"
  }

  if (normalizedStatus === "cancelado") {
    return "Cancelado"
  }

  return "Tu pedido será enviado a la brevedad"
}

function getCuentaItemColor(item: NonNullable<SupabasePedido["orden_items"]>[number]) {
  const itemColor = item as typeof item & {
    color?: string | null
    color_nombre?: string | null
  }

  return (
    item.producto_variantes?.nombre ||
    itemColor.color_nombre ||
    itemColor.color ||
    "Sin color"
  )
}

function getCuentaItemImage(item: NonNullable<SupabasePedido["orden_items"]>[number]) {
  return (
    item.producto_variantes?.imagenes?.[0] ||
    item.productos?.imagen_principal ||
    item.productos?.imagenes_producto?.[0]?.url ||
    ""
  )
}

function InputField({
  label,
  type,
  value,
  onChange,
  placeholder,
  icon: Icon,
  rightElement,
  error,
  maxLength,
  inputMode,
}: {
  label: string
  type: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  icon: React.ElementType
  rightElement?: React.ReactNode
  error?: string
  maxLength?: number
  inputMode?: InputHTMLAttributes<HTMLInputElement>["inputMode"]
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-semibold uppercase tracking-widest text-white/60">
        {label}
      </label>
      <div
        className={`relative flex items-center rounded-xl border bg-white/5 transition-colors focus-within:border-beyonix-blue-light focus-within:ring-2 focus-within:ring-beyonix-blue/40 ${
          error ? "border-red-500/50" : "border-white/8 hover:border-white/14"
        }`}
      >
        <Icon className="absolute left-3.5 size-4 text-white/40 pointer-events-none" />
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          maxLength={maxLength}
          inputMode={inputMode}
          className="w-full bg-transparent py-2.5 pl-10 pr-10 text-sm text-white placeholder:text-white/25 outline-none"
        />
        {rightElement && <div className="absolute right-3">{rightElement}</div>}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  )
}

function TextareaField({
  label,
  value,
  onChange,
  placeholder,
  icon: Icon,
  maxLength,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  icon: React.ElementType
  maxLength?: number
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-semibold uppercase tracking-widest text-white/60">
        {label}
      </label>
      <div className="relative rounded-xl border border-white/8 bg-white/5 transition-colors hover:border-white/14 focus-within:border-beyonix-blue-light focus-within:ring-2 focus-within:ring-beyonix-blue/40">
        <Icon className="pointer-events-none absolute left-3.5 top-3.5 size-4 text-white/40" />
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          maxLength={maxLength}
          rows={2}
          className="min-h-20 w-full resize-none bg-transparent py-2.5 pl-10 pr-4 text-sm text-white placeholder:text-white/25 outline-none"
        />
      </div>
    </div>
  )
}

function LoginForm({ onSwitch }: { onSwitch: () => void }) {
  const { login } = useAuth()
  const router = useRouter()
  const [identifier, setIdentifier] = useState("")
  const [password, setPassword] = useState("")
  const [showPass, setShowPass] = useState(false)
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")
  const [loading, setLoading] = useState(false)
  const [resetLoading, setResetLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    setSuccess("")
    setLoading(true)

    const result = await login(identifier, password)
    setLoading(false)

    if (!result.ok) {
      setError(result.error || "Ocurrió un error.")
      return
    }

    if ("requiresConfirmation" in result && result.requiresConfirmation) {
      setSuccess("Cuenta creada. Te enviamos un email para confirmar tu cuenta antes de iniciar sesión.")
      return
    }

    router.push("/cuenta")
  }

  const handleForgotPassword = async () => {
    const normalizedEmail = identifier.trim().toLowerCase()

    if (!normalizedEmail || !normalizedEmail.includes("@")) {
      setError("Ingresá tu email primero.")
      setSuccess("")
      return
    }

    setError("")
    setSuccess("")
    setResetLoading(true)

    try {
      localStorage.setItem("beyonix-password-recovery", "true")

      const { error: resetError } = await supabase.auth.resetPasswordForEmail(
        normalizedEmail,
        {
          redirectTo: `${window.location.origin}/reset-password`,
        }
      )

      if (resetError) {
        localStorage.removeItem("beyonix-password-recovery")
        setError("No se pudo enviar el email.")
        return
      }

      setSuccess("Te enviamos un email para restablecer tu contraseña.")
    } catch {
      setError("No se pudo enviar el email. Intentá nuevamente.")
    } finally {
      setResetLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <InputField
        label="Email o usuario"
        type="text"
        value={identifier}
        onChange={setIdentifier}
        placeholder="usuario.tech o nombre@email.com"
        icon={Mail}
        maxLength={FIELD_LIMITS.loginIdentifier}
      />
      <InputField
        label="Contraseña"
        type={showPass ? "text" : "password"}
        value={password}
        onChange={setPassword}
        placeholder="••••••••"
        icon={Lock}
        maxLength={FIELD_LIMITS.password}
        rightElement={
          <button
            type="button"
            aria-label="Mostrar u ocultar contraseña"
            title="Mostrar u ocultar contraseña"
            onClick={() => setShowPass((value) => !value)}
            className="text-white/40 hover:text-white/70 transition-colors cursor-pointer"
          >
            {showPass ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        }
      />

      <div className="flex justify-end">
        <button
          type="button"
          aria-label="Recuperar contraseña"
          title="Recuperar contraseña"
          onClick={handleForgotPassword}
          disabled={resetLoading}
          className="text-sm font-medium text-beyonix-cyan transition-colors hover:text-white disabled:opacity-50 cursor-pointer"
        >
          {resetLoading ? "Enviando..." : "¿Olvidaste tu contraseña?"}
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/8 px-4 py-3">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}
      {success && (
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/8 px-4 py-3">
          <p className="text-sm text-emerald-400">{success}</p>
        </div>
      )}

      <button
        type="submit"
        aria-label="Iniciar sesión"
        title="Iniciar sesión"
        disabled={loading}
        className="w-full h-11 rounded-xl bg-white text-black text-sm font-semibold hover:bg-white/90 disabled:opacity-50 transition-all active:scale-95 cursor-pointer"
      >
        {loading ? "Ingresando..." : "Iniciar sesión"}
      </button>

      <p className="text-center text-sm text-white/50">
        ¿No tenés cuenta?{" "}
        <button
          type="button"
          aria-label="Ir a registro"
          title="Ir a registro"
          onClick={onSwitch}
          className="text-beyonix-cyan hover:text-white transition-colors cursor-pointer font-medium"
        >
          Registrate gratis
        </button>
      </p>
    </form>
  )
}

function RegisterForm({ onSwitch }: { onSwitch: () => void }) {
  const { register } = useAuth()
  const router = useRouter()
  const [username, setUsername] = useState("")
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [address, setAddress] = useState("")
  const [province, setProvince] = useState("")
  const [postalCode, setPostalCode] = useState("")
  const [phone, setPhone] = useState("")
  const [references, setReferences] = useState("")
  const [password, setPassword] = useState("")
  const [showPass, setShowPass] = useState(false)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")

    const validationError = validateRegisterPayload({
      username,
      name,
      email,
      address,
      province,
      postalCode,
      phone,
      password,
      references,
    })

    if (validationError) {
      setError(validationError)
      return
    }

    setLoading(true)
    const result = await register({
      username,
      name,
      email,
      password,
      address,
      province,
      postalCode,
      phone,
      references,
    })
    setLoading(false)

    if (!result.ok) {
      setError(result.error || "Ocurrió un error.")
      return
    }

    router.push("/cuenta")
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <InputField label="Nombre de usuario" type="text" value={username} onChange={setUsername} placeholder="usuario.tech" icon={User} maxLength={FIELD_LIMITS.username} />
      <InputField label="Nombre y apellido" type="text" value={name} onChange={setName} placeholder="Nombre Apellido" icon={User} maxLength={FIELD_LIMITS.name} />
      <InputField label="Email" type="email" value={email} onChange={setEmail} placeholder="nombre@email.com" icon={Mail} maxLength={FIELD_LIMITS.email} />
      <InputField label="Dirección" type="text" value={address} onChange={setAddress} placeholder="Calle 1234, piso/depto" icon={MapPin} maxLength={FIELD_LIMITS.address} />
      <TextareaField
        label="Referencias"
        value={references}
        onChange={setReferences}
        placeholder="Entre calles, fachada blanca, porton negro, antes de llegar a la esquina."
        icon={MapPin}
        maxLength={FIELD_LIMITS.references}
      />
      <div className="space-y-1.5">
        <label className="block text-xs font-semibold uppercase tracking-widest text-white/60">
          Provincia
        </label>
        <ProvinceSelect value={province} onChange={setProvince} />
      </div>
      <InputField label="Código postal" type="tel" value={postalCode} onChange={(value) => setPostalCode(onlyDigits(value, FIELD_LIMITS.postalCode))} placeholder="1001" icon={Hash} maxLength={FIELD_LIMITS.postalCode} inputMode="numeric" />
      <InputField label="Teléfono móvil" type="tel" value={phone} onChange={(value) => setPhone(onlyDigits(value, FIELD_LIMITS.phone))} placeholder="1100000000" icon={Phone} maxLength={FIELD_LIMITS.phone} inputMode="numeric" />
      <InputField
        label="Contraseña"
        type={showPass ? "text" : "password"}
        value={password}
        onChange={setPassword}
        placeholder="Mínimo 6 caracteres"
        icon={Lock}
        maxLength={FIELD_LIMITS.password}
        rightElement={
          <button
            type="button"
            aria-label="Mostrar u ocultar contraseña"
            title="Mostrar u ocultar contraseña"
            onClick={() => setShowPass((value) => !value)}
            className="text-white/40 hover:text-white/70 transition-colors cursor-pointer"
          >
            {showPass ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        }
      />

      {error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/8 px-4 py-3">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      <button
        type="submit"
        aria-label="Crear cuenta"
        title="Crear cuenta"
        disabled={loading}
        className="w-full h-11 rounded-xl bg-white text-black text-sm font-semibold hover:bg-white/90 disabled:opacity-50 transition-all active:scale-95 cursor-pointer"
      >
        {loading ? "Creando cuenta..." : "Crear cuenta"}
      </button>

      <p className="text-center text-sm text-white/50">
        ¿Ya tenés cuenta?{" "}
        <button
          type="button"
          aria-label="Ir a inicio de sesión"
          title="Ir a inicio de sesión"
          onClick={onSwitch}
          className="text-beyonix-cyan hover:text-white transition-colors cursor-pointer font-medium"
        >
          Iniciá sesión
        </button>
      </p>
    </form>
  )
}

type ProfileView = "home" | "ordenes" | "datos" | "seguridad"
const PASSWORD_CHANGE_COOLDOWN_DAYS = 15
const PASSWORD_CHANGE_COOLDOWN_MS =
  PASSWORD_CHANGE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000

function AccountViewFrame({
  onBack,
  kicker,
  title,
  children,
  maxWidth = "max-w-4xl",
}: {
  onBack: () => void
  kicker: string
  title: string
  children: React.ReactNode
  maxWidth?: string
}) {
  return (
    <div className={`mx-auto ${maxWidth} space-y-5`}>
      <button
        type="button"
        aria-label="Volver a mi cuenta"
        title="Volver a mi cuenta"
        onClick={onBack}
        className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-full border border-white/12 bg-white/6 px-4 text-sm font-semibold text-white/82 shadow-lg shadow-black/20 transition-all hover:border-beyonix-blue-light/45 hover:bg-beyonix-blue/35 hover:text-white"
      >
        <ChevronLeft className="size-4" />
        Volver a mi cuenta
      </button>

      <div className="rounded-2xl border border-white/8 bg-beyonix-surface px-5 py-5 shadow-2xl shadow-black/25 sm:px-6">
        <p className="text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
          {kicker}
        </p>
        <h2 className="mt-2 text-2xl font-bold tracking-tight text-white">
          {title}
        </h2>
      </div>

      {children}
    </div>
  )
}

function getPasswordCooldownMessage(lastChangedAt: string) {
  const availableAt =
    new Date(
      new Date(lastChangedAt).getTime() +
        PASSWORD_CHANGE_COOLDOWN_MS
    )

  return `La contraseña se puede cambiar una vez cada 15 días. Vas a poder cambiarla nuevamente el ${availableAt.toLocaleDateString("es-AR")}.`
}

function MisOrdenes({ onBack }: { onBack: () => void }) {
  const { user } = useAuth()
  const [orders, setOrders] = useState<SupabasePedido[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  useEffect(() => {
    let active = true

    async function loadOrders() {
      if (!user) return

      setLoading(true)
      setError("")

      const { data, error: ordersError } = await supabase
        .from("ordenes")
        .select("*, orden_items(*, productos(*), producto_variantes(*))")
        .order("created_at", { ascending: false })

      if (!active) return

      if (ordersError) {
        setError("No se pudieron cargar tus órdenes.")
        setLoading(false)
        return
      }

      const normalizedUserValues = [
        user.id,
        user.email,
        user.username,
        user.name,
        user.phone,
      ]
        .filter(Boolean)
        .map((value) => String(value).trim().toLowerCase())

      const matchedOrders = ((data ?? []) as SupabasePedido[]).filter((order) => {
        const orderValues = [
          order.usuario_id,
          order.cliente_email,
          order.cliente_nombre,
          order.cliente_telefono,
        ]
          .filter(Boolean)
          .map((value) => String(value).trim().toLowerCase())

        return orderValues.some((orderValue) =>
          normalizedUserValues.includes(orderValue)
        )
      })

      setOrders(matchedOrders)
      setLoading(false)
    }

    loadOrders()

    return () => {
      active = false
    }
  }, [user])

  return (
    <AccountViewFrame
      onBack={onBack}
      kicker="Mis órdenes"
      title="Historial de compras"
      maxWidth="max-w-5xl"
    >
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 2 }).map((_, index) => (
            <div
              key={index}
              className="h-132px animate-pulse rounded-2xl border border-white/7 bg-beyonix-surface"
            />
          ))}
        </div>
      ) : error ? (
        <div className="rounded-2xl border border-red-500/20 bg-red-500/8 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      ) : orders.length === 0 ? (
        <div className="rounded-2xl border border-white/7 bg-beyonix-surface p-8 text-center">
          <ShoppingBag className="size-10 text-white/15 mx-auto mb-3" />
          <p className="text-sm font-medium text-white/60">Todavía no realizaste ningún pedido.</p>
          <p className="text-xs text-white/40 mt-1">Cuando compres algo aparecerá acá.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {orders.map((order) => {
            const items = order.orden_items ?? []

            return (
              <article
                key={order.id}
                className="overflow-hidden rounded-2xl border border-white/8 bg-beyonix-surface shadow-2xl shadow-black/30"
              >
                <div className="flex flex-col gap-4 border-b border-white/7 bg-white/2 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
                      Pedido #{formatPublicOrderId(order.id)}
                    </p>
                    <p className="mt-2 text-sm text-white/55">
                      {formatCuentaOrderDate(order.created_at)}
                    </p>
                    <h3 className="mt-2 text-2xl font-black text-white">
                      {formatCuentaPrice(Number(order.total ?? 0))}
                    </h3>
                  </div>

                  <div className="flex flex-col items-start gap-2 sm:items-end">
                  <span className="w-fit rounded-full border border-beyonix-blue-light/35 bg-beyonix-blue px-3 py-1 text-11px font-black uppercase tracking-wide text-beyonix-sky">
                    {getClientOrderStatusLabel(order.estado)}
                  </span>
                    <button
                      type="button"
                      aria-label={`Ver factura del pedido ${formatPublicOrderId(order.id)}`}
                      title="Ver factura disponible próximamente"
                      disabled
                      className="h-9 cursor-not-allowed rounded-xl border border-white/8 px-4 text-11px font-black uppercase tracking-wide text-white/28"
                    >
                      Ver factura
                    </button>
                  </div>
                </div>

                <div className="px-5 py-4">
                  <div className="mb-2 hidden grid-cols-account-order-item gap-4 px-3 xl:grid">
                    {[
                      "Producto",
                      "Color",
                      "Cantidad",
                      "Precio x un.",
                      "Subtotal",
                    ].map((label) => (
                      <span
                        key={label}
                        className={`text-11px font-bold uppercase tracking-widest text-white/38 ${
                          label === "Producto" ? "text-left" : "text-center"
                        }`}
                      >
                        {label}
                      </span>
                    ))}
                  </div>

                  <div className="space-y-3">
                  {items.map((item) => {
                    const quantity = Number(item.cantidad ?? 0)
                    const unitPrice = Number(item.precio ?? 0)
                    const subtotal = quantity * unitPrice
                    const productName =
                      item.productos?.nombre ?? `Producto #${item.producto_id}`
                    const image = getCuentaItemImage(item)

                    return (
                      <div
                        key={item.id}
                        className="grid gap-4 rounded-xl border border-white/6 bg-black/35 p-3 sm:grid-cols-account-order-item sm:items-center"
                      >
                        <div className="flex items-center gap-3">
                          <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-white/8 bg-white">
                            {image ? (
                              <img
                                src={image}
                                alt={productName}
                                className="size-full object-contain"
                              />
                            ) : (
                              <ShoppingBag className="size-5 text-black/35" />
                            )}
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-black text-white">
                              {productName}
                            </p>
                            <p className="mt-1 text-xs text-white/48">
                              Producto #{item.producto_id}
                            </p>
                          </div>
                        </div>

                        <div className="text-center">
                          <p className="text-11px font-bold uppercase tracking-widest text-white/38 xl:hidden">
                            Color
                          </p>
                          <p className="mt-1 text-sm font-black text-white">
                            {getCuentaItemColor(item)}
                          </p>
                        </div>

                        <div className="text-center">
                          <p className="text-11px font-bold uppercase tracking-widest text-white/38 xl:hidden">
                            Cantidad
                          </p>
                          <p className="mt-1 text-sm font-black text-white">
                            {quantity}
                          </p>
                        </div>

                        <div className="text-center">
                          <p className="text-11px font-bold uppercase tracking-widest text-white/38 xl:hidden">
                            Precio x un.
                          </p>
                          <p className="mt-1 text-sm font-black text-white">
                            {formatCuentaPrice(unitPrice)}
                          </p>
                        </div>

                        <div className="text-center">
                          <p className="text-11px font-bold uppercase tracking-widest text-white/38 xl:hidden">
                            Subtotal
                          </p>
                          <p className="mt-1 text-sm font-black text-white">
                            {formatCuentaPrice(subtotal)}
                          </p>
                        </div>
                      </div>
                    )
                  })}
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </AccountViewFrame>
  )
}

function ReadOnlyField({
  label,
  value,
  icon: Icon,
  help,
}: {
  label: string
  value: string
  icon: React.ElementType
  help?: string
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-semibold uppercase tracking-widest text-white/60">
        {label}
      </label>
      <div className="flex items-center gap-2 rounded-xl border border-white/5 bg-white/1 px-3.5 py-3">
        <Icon className="size-4 shrink-0 text-white/20" />
        <span className="truncate text-sm text-white/50">{value}</span>
      </div>
      {help && <p className="text-11px text-white/25">{help}</p>}
    </div>
  )
}

type DeliveryAddressDraft = {
  codigoPostal: string
  calle: string
  numero: string
  piso?: string
  departamento?: string
  localidad: string
  region: string
  pais: "Argentina"
  componentesDeDireccion: []
}

function splitLegacyAddress(value: string) {
  const cleanValue = value.trim()
  const match = cleanValue.match(/^(.*?)(\d+[a-zA-Z]?)\b(.*)$/)

  if (!match) {
    return {
      street: cleanValue,
      number: "",
    }
  }

  return {
    street: match[1].replace(/[,\s]+$/, "").trim(),
    number: match[2].trim(),
  }
}

function parseProfileAddress(
  value: string,
  province?: string,
  postalCode?: string
) {
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
  const baseAddress = splitLegacyAddress(parts[0] ?? value)
  let floor = ""
  let apartment = ""
  let locality = ""

  for (const part of parts.slice(1)) {
    if (/^piso\s+/i.test(part)) {
      floor = part.replace(/^piso\s+/i, "").trim()
      continue
    }

    if (/^depto\s+/i.test(part)) {
      apartment = part.replace(/^depto\s+/i, "").trim()
      continue
    }

    if (province && part.toLowerCase() === province.toLowerCase()) {
      continue
    }

    if (postalCode && part.toLowerCase() === `cp ${postalCode}`.toLowerCase()) {
      continue
    }

    if (!locality) {
      locality = part
    }
  }

  return {
    ...baseAddress,
    floor,
    apartment,
    locality,
  }
}

function buildDeliveryAddressDraft({
  postalCode,
  street,
  streetNumber,
  floor,
  apartment,
  locality,
  province,
}: {
  postalCode: string
  street: string
  streetNumber: string
  floor: string
  apartment: string
  locality: string
  province: string
}): DeliveryAddressDraft {
  return {
    codigoPostal: postalCode.trim(),
    calle: street.trim(),
    numero: streetNumber.trim(),
    piso: floor.trim() || undefined,
    departamento: apartment.trim() || undefined,
    localidad: locality.trim(),
    region: province.trim(),
    pais: "Argentina",
    componentesDeDireccion: [],
  }
}

function formatDeliveryAddressForProfile(address: DeliveryAddressDraft) {
  const optionalParts = [
    address.piso ? `Piso ${address.piso}` : "",
    address.departamento ? `Depto ${address.departamento}` : "",
  ].filter(Boolean)

  return [
    `${address.calle} ${address.numero}`,
    ...optionalParts,
    address.localidad,
    address.region,
    `CP ${address.codigoPostal}`,
  ].join(", ")
}

function validateDeliveryAddress(address: DeliveryAddressDraft) {
  if (!address.calle) return "Ingresá la calle."
  if (!address.numero) return "Ingresá el número de calle."
  if (!/^\d{4,8}$/.test(address.codigoPostal)) {
    return "El código postal debe tener entre 4 y 8 números."
  }
  if (!address.localidad) return "Ingresá la localidad."
  if (!address.region) return "Seleccioná una provincia válida."

  const commonPattern = /^[a-zA-ZÀ-ÿ0-9\s.,'°/-]+$/
  const values = [
    address.calle,
    address.numero,
    address.piso ?? "",
    address.departamento ?? "",
    address.localidad,
  ].filter(Boolean)

  if (values.some((value) => !commonPattern.test(value))) {
    return "La dirección contiene caracteres no permitidos."
  }

  return ""
}

function validateAccountPassword(password: string) {
  if (password.length < 8) {
    return "La contraseña debe tener al menos 8 caracteres."
  }

  if (!/[A-Z]/.test(password)) {
    return "La contraseña debe incluir al menos una mayúscula."
  }

  if (!/[0-9]/.test(password)) {
    return "La contraseña debe incluir al menos un número."
  }

  return ""
}

function ChangePasswordForm() {
  const { user } = useAuth()
  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [showCurrent, setShowCurrent] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")

  const handleSubmit = async () => {
    setError("")
    setSuccess("")

    if (!user?.email) {
      setError("No se pudo validar el email de la cuenta.")
      return
    }

    if (!currentPassword) {
      setError("Ingresá tu contraseña actual.")
      return
    }

    const passwordError = validateAccountPassword(newPassword)

    if (passwordError) {
      setError(passwordError)
      return
    }

    if (newPassword !== confirmPassword) {
      setError("Las contraseñas nuevas no coinciden.")
      return
    }

    if (currentPassword === newPassword) {
      setError("La nueva contraseña debe ser distinta a la actual.")
      return
    }

    setLoading(true)

    const {
      data: authUserData,
      error: authUserError,
    } = await supabase.auth.getUser()

    if (authUserError) {
      setLoading(false)
      setError("No se pudo validar la sesión. Intentá nuevamente.")
      return
    }

    const lastPasswordChangedAt =
      authUserData.user?.user_metadata
        ?.last_password_change_at

    if (
      typeof lastPasswordChangedAt === "string" &&
      Number.isFinite(new Date(lastPasswordChangedAt).getTime()) &&
      Date.now() -
        new Date(lastPasswordChangedAt).getTime() <
        PASSWORD_CHANGE_COOLDOWN_MS
    ) {
      setLoading(false)
      setError(getPasswordCooldownMessage(lastPasswordChangedAt))
      return
    }

    const { error: verifyError } =
      await supabase.auth.signInWithPassword({
        email: user.email,
        password: currentPassword,
      })

    if (verifyError) {
      setLoading(false)
      setError("La contraseña actual no es correcta.")
      return
    }

    const { error: updateError } =
      await supabase.auth.updateUser({
        password: newPassword,
        data: {
          ...authUserData.user?.user_metadata,
          last_password_change_at: new Date().toISOString(),
        },
      })

    setLoading(false)

    if (updateError) {
      setError("No se pudo actualizar la contraseña. Intentá nuevamente.")
      return
    }

    setCurrentPassword("")
    setNewPassword("")
    setConfirmPassword("")
    setSuccess("Contraseña actualizada correctamente.")
    setTimeout(() => setSuccess(""), 3500)
  }

  return (
    <div className="space-y-4">
      <InputField
        label="Contraseña actual"
        type={showCurrent ? "text" : "password"}
        value={currentPassword}
        onChange={setCurrentPassword}
        placeholder="Contraseña actual"
        icon={Lock}
        maxLength={FIELD_LIMITS.password}
        rightElement={
          <button
            type="button"
            aria-label="Mostrar u ocultar contraseña actual"
            title="Mostrar u ocultar contraseña actual"
            onClick={() => setShowCurrent((value) => !value)}
            className="cursor-pointer text-white/40 transition-colors hover:text-white/70"
          >
            {showCurrent ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        }
      />

      <InputField
        label="Nueva contraseña"
        type={showNew ? "text" : "password"}
        value={newPassword}
        onChange={setNewPassword}
        placeholder="Mínimo 8 caracteres"
        icon={Lock}
        maxLength={FIELD_LIMITS.password}
        rightElement={
          <button
            type="button"
            aria-label="Mostrar u ocultar nueva contraseña"
            title="Mostrar u ocultar nueva contraseña"
            onClick={() => setShowNew((value) => !value)}
            className="cursor-pointer text-white/40 transition-colors hover:text-white/70"
          >
            {showNew ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        }
      />

      <InputField
        label="Confirmar nueva contraseña"
        type={showConfirm ? "text" : "password"}
        value={confirmPassword}
        onChange={setConfirmPassword}
        placeholder="Repetí la nueva contraseña"
        icon={Lock}
        maxLength={FIELD_LIMITS.password}
        rightElement={
          <button
            type="button"
            aria-label="Mostrar u ocultar confirmación"
            title="Mostrar u ocultar confirmación"
            onClick={() => setShowConfirm((value) => !value)}
            className="cursor-pointer text-white/40 transition-colors hover:text-white/70"
          >
            {showConfirm ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        }
      />

      <div className="rounded-xl border border-white/7 bg-white/2 px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-widest text-white/45">
          Requisitos
        </p>
        <p className="mt-2 text-sm leading-6 text-white/55">
          Mínimo 8 caracteres, una mayúscula y al menos un número. Puede cambiarse una vez cada 15 días.
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/8 px-4 py-3">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {success && (
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/8 px-4 py-3">
          <p className="text-sm text-emerald-400">{success}</p>
        </div>
      )}

      <button
        type="button"
        aria-label="Cambiar contraseña"
        title="Cambiar contraseña"
        disabled={loading}
        onClick={handleSubmit}
        className="h-11 w-full cursor-pointer rounded-xl border border-beyonix-blue-light/60 bg-beyonix-blue text-sm font-semibold text-white transition-colors hover:bg-beyonix-blue-light disabled:opacity-50"
      >
        {loading ? "Validando..." : "Cambiar contraseña"}
      </button>
    </div>
  )
}

function Seguridad({ onBack }: { onBack: () => void }) {
  return (
    <AccountViewFrame
      onBack={onBack}
      kicker="Seguridad"
      title="Cambiar contraseña"
      maxWidth="max-w-4xl"
    >
      <div className="rounded-2xl border border-white/7 bg-beyonix-surface p-6">
        <ChangePasswordForm />
      </div>
    </AccountViewFrame>
  )
}

function MisDatos({ onBack }: { onBack: () => void }) {
  const { user, updateUser } = useAuth()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const profileAddress = parseProfileAddress(
    user?.address ?? "",
    user?.province,
    user?.postalCode
  )
  const [name, setName] = useState(user?.name ?? "")
  const [phone, setPhone] = useState(user?.phone ?? "")
  const [province, setProvince] = useState(user?.province ?? "")
  const [postalCode, setPostalCode] = useState(user?.postalCode ?? "")
  const [street, setStreet] = useState(profileAddress.street)
  const [streetNumber, setStreetNumber] = useState(profileAddress.number)
  const [floor, setFloor] = useState(profileAddress.floor)
  const [apartment, setApartment] = useState(profileAddress.apartment)
  const [locality, setLocality] = useState(user?.city ?? profileAddress.locality)
  const [references, setReferences] = useState(user?.references ?? "")
  const [avatarUrl, setAvatarUrl] = useState(user?.avatarUrl ?? "")
  const [saved, setSaved] = useState(false)
  const [profileError, setProfileError] = useState("")
  const [avatarLoading, setAvatarLoading] = useState(false)
  const [avatarError, setAvatarError] = useState("")

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault()
    setProfileError("")

    const validationError = validateProfilePayload({
      name,
      phone,
      province,
      address: `${street} ${streetNumber}`.trim(),
      postalCode,
      references,
    })

    if (validationError) {
      setProfileError(validationError)
      return
    }

    const deliveryAddress = buildDeliveryAddressDraft({
      postalCode,
      street,
      streetNumber,
      floor,
      apartment,
      locality,
      province,
    })
    const deliveryError = validateDeliveryAddress(deliveryAddress)

    if (deliveryError) {
      setProfileError(deliveryError)
      return
    }

    updateUser({
      name,
      phone,
      province,
      address: formatDeliveryAddressForProfile(deliveryAddress),
      postalCode,
      references,
    })
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]

    if (!file || !user) return

    if (!file.type.startsWith("image/")) {
      setAvatarError("Subí una imagen válida.")
      return
    }

    if (file.size > 2 * 1024 * 1024) {
      setAvatarError("La imagen no puede superar los 2 MB.")
      return
    }

    setAvatarLoading(true)
    setAvatarError("")

    const fileExt = file.name.split(".").pop() || "jpg"
    const filePath = `${user.id}/avatar.${fileExt}`

    const { error: uploadError } = await supabase.storage
      .from("avatars")
      .upload(filePath, file, {
        cacheControl: "3600",
        upsert: true,
      })

    if (uploadError) {
      setAvatarLoading(false)
      setAvatarError(
        "No se pudo subir la foto. Revisá que el SQL 09-profile-avatar esté aplicado."
      )
      return
    }

    const {
      data: { publicUrl },
    } = supabase.storage.from("avatars").getPublicUrl(filePath)

    await updateUser({ avatarUrl: publicUrl })
    setAvatarUrl(publicUrl)
    setAvatarLoading(false)
  }

  return (
    <AccountViewFrame
      onBack={onBack}
      kicker="Mis datos"
      title="Datos de la cuenta"
      maxWidth="max-w-4xl"
    >
      <div className="rounded-2xl border border-white/7 bg-beyonix-surface p-4 sm:p-5">
        <form onSubmit={handleSave} className="space-y-4">
          <div className="flex items-center gap-3 rounded-xl border border-white/7 bg-white/2 p-3">
            <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/12 bg-white text-black">
              {avatarUrl ? (
                <img src={avatarUrl} alt="" className="size-full object-cover" />
              ) : (
                <User className="size-9" />
              )}
            </div>

            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-white">Foto de perfil</p>
              <p className="mt-0.5 text-xs text-white/45">
                JPG o PNG, hasta 2 MB.
              </p>
              {avatarError && (
                <p className="mt-2 text-xs text-red-400">{avatarError}</p>
              )}
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleAvatarChange}
              className="hidden"
              title="Cambiar foto de perfil"
              aria-label="Cambiar foto de perfil"
            />

            <button
              type="button"
              aria-label="Subir foto de perfil"
              title="Subir foto de perfil"
              onClick={() => fileInputRef.current?.click()}
              disabled={avatarLoading}
              className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-white/10 text-white/70 transition-colors hover:border-white/22 hover:text-white disabled:opacity-50"
            >
              <Camera className="size-4" />
            </button>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <ReadOnlyField
              label="Nombre de usuario"
              value={user?.username || "Sin usuario asignado"}
              icon={User}
              help="El nombre de usuario no se puede cambiar."
            />
            <ReadOnlyField
              label="Email"
              value={user?.email || ""}
              icon={Mail}
              help="El email no se puede cambiar."
            />

            <InputField label="Nombre y apellido" type="text" value={name} onChange={setName} placeholder="Nombre Apellido" icon={User} maxLength={FIELD_LIMITS.name} />
            <InputField label="Teléfono móvil" type="tel" value={phone} onChange={(value) => setPhone(onlyDigits(value, FIELD_LIMITS.phone))} placeholder="1100000000" icon={Phone} maxLength={FIELD_LIMITS.phone} inputMode="numeric" />
          </div>

          <div className="rounded-2xl border border-beyonix-blue-light/12 bg-black/30 p-3">
            <div className="mb-3">
              <p className="text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
                Dirección de entrega
              </p>
              <p className="mt-1 text-xs leading-5 text-white/42">
                Estos datos ayudan a preparar futuros envíos a domicilio con Andreani.
              </p>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <InputField label="Calle" type="text" value={street} onChange={setStreet} placeholder="San Martín" icon={MapPin} maxLength={60} />
              <InputField label="Número" type="text" value={streetNumber} onChange={(value) => setStreetNumber(onlyDigits(value, 8))} placeholder="1234" icon={Hash} maxLength={8} inputMode="numeric" />
              <InputField label="Piso opcional" type="text" value={floor} onChange={setFloor} placeholder="3" icon={Hash} maxLength={12} />
              <InputField label="Departamento opcional" type="text" value={apartment} onChange={setApartment} placeholder="B" icon={Hash} maxLength={12} />
              <InputField label="Código postal" type="tel" value={postalCode} onChange={(value) => setPostalCode(onlyDigits(value, FIELD_LIMITS.postalCode))} placeholder="2000" icon={Hash} maxLength={FIELD_LIMITS.postalCode} inputMode="numeric" />
              <InputField label="Localidad" type="text" value={locality} onChange={setLocality} placeholder="Rosario" icon={MapPin} maxLength={60} />
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold uppercase tracking-widest text-white/60">
                  Provincia / Región
                </label>
                <ProvinceSelect value={province} onChange={setProvince} />
              </div>
              <div className="md:col-span-2">
                <TextareaField
                  label="Referencias para llegar"
                  value={references}
                  onChange={setReferences}
                  placeholder="Entre calles, fachada blanca, portón negro, antes de llegar a la esquina."
                  icon={MapPin}
                  maxLength={FIELD_LIMITS.references}
                />
              </div>
            </div>
          </div>

          {profileError && (
            <div className="rounded-xl border border-red-500/20 bg-red-500/8 px-4 py-3">
              <p className="text-sm text-red-400">{profileError}</p>
            </div>
          )}

          <button
            type="submit"
            aria-label="Guardar cambios"
            title="Guardar cambios"
            className="h-11 w-full cursor-pointer rounded-xl border border-beyonix-blue-light/60 bg-beyonix-blue text-sm font-semibold text-white transition-colors hover:bg-beyonix-blue-light"
          >
            {saved ? "Guardado" : "Guardar cambios"}
          </button>
        </form>
      </div>
    </AccountViewFrame>
  )
}

function ProfilePanel({ initialView }: { initialView: ProfileView }) {
  const { user, logout, isAdmin } = useAuth()
  const router = useRouter()
  const [view, setView] = useState<ProfileView>(initialView)

  useEffect(() => {
    setView(initialView)
  }, [initialView])

  if (!user) return null

  const goToView = (nextView: ProfileView) => {
    setView(nextView)

    router.replace(
      nextView === "home"
        ? "/cuenta"
        : `/cuenta?tab=${nextView}`,
      { scroll: false }
    )
  }

  if (view === "ordenes") return <MisOrdenes onBack={() => goToView("home")} />
  if (view === "datos") return <MisDatos onBack={() => goToView("home")} />
  if (view === "seguridad") return <Seguridad onBack={() => goToView("home")} />

  const menuItems = [
    { icon: ShoppingBag, label: "Mis órdenes", sub: "Historial de compras", view: "ordenes" as ProfileView },
    { icon: User, label: "Mis datos", sub: "Nombre, email y dirección", view: "datos" as ProfileView },
    { icon: Lock, label: "Seguridad", sub: "Contraseña y acceso", view: "seguridad" as ProfileView },
  ]

  return (
    <div className="mx-auto max-w-md space-y-6">
      <div className="flex items-center gap-4 p-5 rounded-2xl border border-white/7 bg-white/2">
        <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/12 bg-white text-black">
          {user.avatarUrl ? (
            <img src={user.avatarUrl} alt="" className="size-full object-cover" />
          ) : (
            <User className="size-8" />
          )}
        </div>
        <div className="min-w-0">
          <p className="font-semibold text-white truncate">{user.name}</p>
          <p className="text-sm text-white/55 truncate">{user.email}</p>
          <p className="mt-1 text-11px text-beyonix-cyan font-medium">Cliente BEYONIX</p>
        </div>
      </div>

      <div className="space-y-2">
        {menuItems.map((item) => (
          <button
            key={item.label}
            type="button"
            aria-label={item.label}
            title={item.label}
            onClick={() => goToView(item.view)}
            className="w-full flex items-center gap-4 p-4 rounded-xl border border-white/6 bg-white/2 hover:bg-white/4 hover:border-white/10 transition-all group cursor-pointer text-left"
          >
            <div className="size-9 rounded-lg bg-beyonix-blue/50 border border-beyonix-blue-light/30 flex items-center justify-center shrink-0">
              <item.icon className="size-4 text-beyonix-cyan" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white">{item.label}</p>
              <p className="text-xs text-white/50">{item.sub}</p>
            </div>
            <ChevronRight className="size-4 text-white/25 group-hover:text-white/60 transition-colors shrink-0" />
          </button>
        ))}
      </div>

      {isAdmin && (
        <button
          type="button"
          aria-label="Ir al panel admin"
          title="Ir al panel admin"
          onClick={() => router.push("/admin")}
          className="w-full flex items-center gap-4 p-4 rounded-xl border border-beyonix-blue-light/25 bg-beyonix-account hover:bg-beyonix-blue hover:border-beyonix-blue-light/50 transition-all group cursor-pointer text-left"
        >
          <div className="size-9 rounded-lg bg-beyonix-blue/60 border border-beyonix-blue-light/40 flex items-center justify-center shrink-0">
            <Shield className="size-4 text-beyonix-cyan" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white">Panel Admin</p>
            <p className="text-xs text-white/55">Gestión de tienda</p>
          </div>
          <ChevronRight className="size-4 text-white/25 group-hover:text-white/70 transition-colors shrink-0" />
        </button>
      )}

      <button
        type="button"
        aria-label="Cerrar sesión"
        title="Cerrar sesión"
        onClick={() => { logout(); router.push("/") }}
        className="w-full flex items-center justify-center gap-2 h-11 rounded-xl border border-white/8 text-sm font-medium text-white/60 hover:text-white hover:border-white/20 transition-all cursor-pointer"
      >
        <LogOut className="size-4" />
        Cerrar sesión
      </button>
    </div>
  )
}

export function CuentaClient() {
  const { user, isLoading } = useAuth()
  const [tab, setTab] = useState<"login" | "register">("login")
  const searchParams = useSearchParams()

  const tabParam = searchParams.get("tab") as ProfileView | null
  const initialView: ProfileView =
    tabParam === "ordenes" ||
    tabParam === "datos" ||
    tabParam === "seguridad"
      ? tabParam
      : "home"

  useEffect(() => {
    if (user) setTab("login")
  }, [user])

  useEffect(() => {
    if (isLoading || user) return

    window.location.replace("/login?redirect=/cuenta")
  }, [isLoading, user])

  if (isLoading) {
    return (
      <main className="min-h-screen bg-black flex items-center justify-center pt-20">
        <div className="size-8 rounded-full border-2 border-white/10 border-t-white/60 animate-spin" />
      </main>
    )
  }

  if (!user) {
    return (
      <main className="min-h-screen bg-black flex items-center justify-center pt-20">
        <div className="size-8 rounded-full border-2 border-white/10 border-t-white/60 animate-spin" />
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-black pt-20">
      <div className="container mx-auto max-w-5xl px-4 py-12 lg:py-16">
        {user ? (
          <>
            <div className="mb-8">
              <p className="text-11px font-semibold uppercase tracking-widest text-beyonix-cyan mb-2">
                Mi cuenta
              </p>
              <h1 className="text-2xl font-bold text-white tracking-tight">
                Hola, {(user.username || user.name.split(" ")[0]).toUpperCase()}
              </h1>
            </div>
            <ProfilePanel initialView={initialView} />
          </>
        ) : null}
        {false && (
          <>
            <div className="mb-8 text-center">
              <p className="text-11px font-semibold uppercase tracking-widest text-beyonix-cyan mb-2">
                Mi cuenta
              </p>
              <h1 className="text-2xl font-bold text-white tracking-tight mb-1">
                {tab === "login" ? "Bienvenido de vuelta" : "Creá tu cuenta"}
              </h1>
              <p className="text-sm text-white/50">
                {tab === "login"
                  ? "Ingresá para ver tus órdenes y datos."
                  : "Registrate para comprar en BEYONIX."}
              </p>
            </div>

            <div className="flex rounded-xl border border-white/7 bg-white/2 p-1 mb-7">
              {(["login", "register"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-label={value === "login" ? "Iniciar sesión" : "Registrarse"}
                  title={value === "login" ? "Iniciar sesión" : "Registrarse"}
                  onClick={() => setTab(value)}
                  className={`flex-1 py-2.5 rounded-lg text-sm font-semibold transition-all cursor-pointer ${
                    tab === value
                      ? "bg-beyonix-blue border border-beyonix-blue-light/60 text-white shadow-sm"
                      : "text-white/50 hover:text-white/80"
                  }`}
                >
                  {value === "login" ? "Iniciar sesión" : "Registrarse"}
                </button>
              ))}
            </div>

            <div className="rounded-2xl border border-white/7 bg-beyonix-surface p-6">
              {tab === "login" ? (
                <LoginForm onSwitch={() => setTab("register")} />
              ) : (
                <RegisterForm onSwitch={() => setTab("login")} />
              )}
            </div>
          </>
        )}
      </div>
    </main>
  )
}
