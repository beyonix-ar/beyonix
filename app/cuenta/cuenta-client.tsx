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
import {
  FIELD_LIMITS,
  onlyDigits,
  validateRegisterPayload,
} from "@/lib/validation/account-fields"

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
        className={`relative flex items-center rounded-xl border bg-white/2 transition-colors focus-within:border-beyonix-blue-light focus-within:ring-2 focus-within:ring-beyonix-blue/40 ${
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
          className="w-full bg-transparent py-3 pl-10 pr-10 text-sm text-white placeholder:text-white/25 outline-none"
        />
        {rightElement && <div className="absolute right-3">{rightElement}</div>}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
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

type ProfileView = "home" | "ordenes" | "datos"

function MisOrdenes({ onBack }: { onBack: () => void }) {
  return (
    <div className="space-y-5">
      <button type="button" aria-label="Volver a mi cuenta" title="Volver a mi cuenta" onClick={onBack}
        className="flex items-center gap-1.5 text-sm text-white/60 hover:text-white transition-colors cursor-pointer">
        <ChevronLeft className="size-4" /> Volver a mi cuenta
      </button>

      <div>
        <p className="text-11px font-semibold uppercase tracking-widest text-beyonix-cyan mb-1">
          Mis órdenes
        </p>
        <h2 className="text-xl font-bold text-white">Historial de compras</h2>
      </div>

      <div className="rounded-2xl border border-white/7 bg-beyonix-surface p-8 text-center">
        <ShoppingBag className="size-10 text-white/15 mx-auto mb-3" />
        <p className="text-sm font-medium text-white/60">Todavía no realizaste ningún pedido.</p>
        <p className="text-xs text-white/40 mt-1">Cuando compres algo aparecerá acá.</p>
      </div>
    </div>
  )
}

function MisDatos({ onBack }: { onBack: () => void }) {
  const { user, updateUser } = useAuth()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(user?.name ?? "")
  const [phone, setPhone] = useState(user?.phone ?? "")
  const [province, setProvince] = useState(user?.province ?? "")
  const [address, setAddress] = useState(user?.address ?? "")
  const [postalCode, setPostalCode] = useState(user?.postalCode ?? "")
  const [avatarUrl, setAvatarUrl] = useState(user?.avatarUrl ?? "")
  const [saved, setSaved] = useState(false)
  const [avatarLoading, setAvatarLoading] = useState(false)
  const [avatarError, setAvatarError] = useState("")

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault()
    updateUser({ name, phone, province, address, postalCode })
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
    <div className="space-y-5">
      <button type="button" aria-label="Volver a mi cuenta" title="Volver a mi cuenta" onClick={onBack}
        className="flex items-center gap-1.5 text-sm text-white/60 hover:text-white transition-colors cursor-pointer">
        <ChevronLeft className="size-4" /> Volver a mi cuenta
      </button>

      <div>
        <p className="text-11px font-semibold uppercase tracking-widest text-beyonix-cyan mb-1">
          Mis datos
        </p>
        <h2 className="text-xl font-bold text-white">Tu información</h2>
      </div>

      <div className="rounded-2xl border border-white/7 bg-beyonix-surface p-6">
        <form onSubmit={handleSave} className="space-y-4">
          <div className="flex items-center gap-4 rounded-xl border border-white/7 bg-white/2 p-4">
            <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/12 bg-white text-black">
              {avatarUrl ? (
                <img src={avatarUrl} alt="" className="size-full object-cover" />
              ) : (
                <User className="size-9" />
              )}
            </div>

            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-white">Foto de perfil</p>
              <p className="mt-1 text-xs text-white/45">
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

          <div className="space-y-1.5">
            <label className="block text-xs font-semibold uppercase tracking-widest text-white/60">
              Email
            </label>
            <div className="flex items-center rounded-xl border border-white/5 bg-white/1 px-3.5 py-3 gap-2">
              <Mail className="size-4 text-white/20 shrink-0" />
              <span className="text-sm text-white/50">{user?.email}</span>
            </div>
            <p className="text-11px text-white/25">El email no se puede cambiar.</p>
          </div>

          <InputField label="Nombre y apellido" type="text" value={name} onChange={setName} placeholder="Nombre Apellido" icon={User} maxLength={FIELD_LIMITS.name} />
          <InputField label="Teléfono móvil" type="tel" value={phone} onChange={(value) => setPhone(onlyDigits(value, FIELD_LIMITS.phone))} placeholder="1100000000" icon={Phone} maxLength={FIELD_LIMITS.phone} inputMode="numeric" />
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold uppercase tracking-widest text-white/60">
              Provincia
            </label>
            <ProvinceSelect value={province} onChange={setProvince} />
          </div>
          <InputField label="Dirección" type="text" value={address} onChange={setAddress} placeholder="Calle 1234, piso/depto" icon={MapPin} maxLength={FIELD_LIMITS.address} />
          <InputField label="Código postal" type="tel" value={postalCode} onChange={(value) => setPostalCode(onlyDigits(value, FIELD_LIMITS.postalCode))} placeholder="1001" icon={Hash} maxLength={FIELD_LIMITS.postalCode} inputMode="numeric" />

          <button type="submit" aria-label="Guardar cambios" title="Guardar cambios"
            className="w-full h-10 rounded-xl bg-beyonix-blue border border-beyonix-blue-light/60 text-sm font-semibold text-white hover:bg-beyonix-blue-light transition-colors cursor-pointer mt-2">
            {saved ? "Guardado" : "Guardar cambios"}
          </button>
        </form>
      </div>
    </div>
  )
}

function ProfilePanel({ initialView }: { initialView: ProfileView }) {
  const { user, logout, isAdmin } = useAuth()
  const router = useRouter()
  const [view, setView] = useState<ProfileView>(initialView)

  if (!user) return null

  if (view === "ordenes") return <MisOrdenes onBack={() => setView("home")} />
  if (view === "datos") return <MisDatos onBack={() => setView("home")} />

  const menuItems = [
    { icon: ShoppingBag, label: "Mis órdenes", sub: "Historial de compras", view: "ordenes" as ProfileView },
    { icon: User, label: "Mis datos", sub: "Nombre, email y dirección", view: "datos" as ProfileView },
  ]

  return (
    <div className="space-y-6">
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
            onClick={() => setView(item.view)}
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
  const initialView: ProfileView = tabParam === "ordenes" ? "ordenes" : tabParam === "datos" ? "datos" : "home"

  useEffect(() => {
    if (user) setTab("login")
  }, [user])

  if (isLoading) {
    return (
      <main className="min-h-screen bg-black flex items-center justify-center pt-20">
        <div className="size-8 rounded-full border-2 border-white/10 border-t-white/60 animate-spin" />
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-black pt-20">
      <div className="container mx-auto px-4 py-12 lg:py-16 max-w-md">
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
        ) : (
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
