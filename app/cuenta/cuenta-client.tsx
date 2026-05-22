"use client"

import { useState, useEffect } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
  Eye,
  EyeOff,
  User,
  Mail,
  Lock,
  LogOut,
  ShoppingBag,
  ChevronRight,
  ChevronLeft,
  Shield,
} from "lucide-react"
import { useAuth } from "@/context/auth-context"

// ─── Input reutilizable ───────────────────────────────────────────────────────

function InputField({
  label,
  type,
  value,
  onChange,
  placeholder,
  icon: Icon,
  rightElement,
  error,
}: {
  label: string
  type: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  icon: React.ElementType
  rightElement?: React.ReactNode
  error?: string
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-semibold uppercase tracking-[0.15em] text-white/50">
        {label}
      </label>
      <div
        className={`relative flex items-center rounded-xl border bg-white/[2%] transition-colors focus-within:border-[#1E4D7B] focus-within:ring-2 focus-within:ring-[#112A43]/40 ${
          error ? "border-red-500/50" : "border-white/[8%] hover:border-white/[14%]"
        }`}
      >
        <Icon className="absolute left-3.5 size-4 text-white/30 pointer-events-none" />
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full bg-transparent py-3 pl-10 pr-10 text-sm text-white placeholder:text-white/25 outline-none"
        />
        {rightElement && <div className="absolute right-3">{rightElement}</div>}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  )
}

// ─── Formulario login ─────────────────────────────────────────────────────────

function LoginForm({ onSwitch }: { onSwitch: () => void }) {
  const { login } = useAuth()
  const router = useRouter()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [showPass, setShowPass] = useState(false)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    setLoading(true)
    const result = await login(email, password)
    setLoading(false)
    if (!result.ok) { setError(result.error || "Ocurrió un error."); return }
    router.push("/cuenta")
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <InputField label="Email" type="email" value={email} onChange={setEmail}
        placeholder="tu@email.com" icon={Mail} />
      <InputField label="Contraseña" type={showPass ? "text" : "password"}
        value={password} onChange={setPassword} placeholder="••••••••" icon={Lock}
        rightElement={
          <button type="button" onClick={() => setShowPass((v) => !v)}
            className="text-white/30 hover:text-white/60 transition-colors cursor-pointer">
            {showPass ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        } />
      {error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/8 px-4 py-3">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}
      <button type="submit" disabled={loading}
        className="w-full h-11 rounded-xl bg-white text-black text-sm font-semibold hover:bg-white/90 disabled:opacity-50 transition-all active:scale-[0.98] cursor-pointer">
        {loading ? "Ingresando..." : "Iniciar sesión"}
      </button>
      <p className="text-center text-sm text-white/40">
        ¿No tenés cuenta?{" "}
        <button type="button" onClick={onSwitch}
          className="text-[#4A90B8] hover:text-white transition-colors cursor-pointer font-medium">
          Registrate gratis
        </button>
      </p>
    </form>
  )
}

// ─── Formulario registro ──────────────────────────────────────────────────────

function RegisterForm({ onSwitch }: { onSwitch: () => void }) {
  const { register } = useAuth()
  const router = useRouter()
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [showPass, setShowPass] = useState(false)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    if (!name.trim()) { setError("Ingresá tu nombre."); return }
    setLoading(true)
    const result = await register(name, email, password)
    setLoading(false)
    if (!result.ok) { setError(result.error || "Ocurrió un error."); return }
    router.push("/cuenta")
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <InputField label="Nombre completo" type="text" value={name} onChange={setName}
        placeholder="Juan García" icon={User} />
      <InputField label="Email" type="email" value={email} onChange={setEmail}
        placeholder="tu@email.com" icon={Mail} />
      <InputField label="Contraseña" type={showPass ? "text" : "password"}
        value={password} onChange={setPassword} placeholder="Mínimo 6 caracteres" icon={Lock}
        rightElement={
          <button type="button" onClick={() => setShowPass((v) => !v)}
            className="text-white/30 hover:text-white/60 transition-colors cursor-pointer">
            {showPass ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        } />
      {error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/8 px-4 py-3">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}
      <button type="submit" disabled={loading}
        className="w-full h-11 rounded-xl bg-white text-black text-sm font-semibold hover:bg-white/90 disabled:opacity-50 transition-all active:scale-[0.98] cursor-pointer">
        {loading ? "Creando cuenta..." : "Crear cuenta"}
      </button>
      <p className="text-center text-sm text-white/40">
        ¿Ya tenés cuenta?{" "}
        <button type="button" onClick={onSwitch}
          className="text-[#4A90B8] hover:text-white transition-colors cursor-pointer font-medium">
          Iniciá sesión
        </button>
      </p>
    </form>
  )
}

// ─── Vista: Mis ordenes ───────────────────────────────────────────────────────

function Misordenes({ onBack }: { onBack: () => void }) {
  return (
    <div className="space-y-5">
      <button type="button" onClick={onBack}
        className="flex items-center gap-1.5 text-sm text-white/50 hover:text-white transition-colors cursor-pointer">
        <ChevronLeft className="size-4" /> Volver a mi cuenta
      </button>

      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.25em] text-[#4A90B8] mb-1">
          Mis ordenes
        </p>
        <h2 className="text-xl font-bold text-white">Historial de compras</h2>
      </div>

      <div className="rounded-2xl border border-white/[7%] bg-[#0A0A0A] p-8 text-center">
        <ShoppingBag className="size-10 text-white/15 mx-auto mb-3" />
        <p className="text-sm font-medium text-white/50">Todavía no realizaste ningún pedido.</p>
        <p className="text-xs text-white/30 mt-1">Cuando compres algo aparecerá acá.</p>
      </div>
    </div>
  )
}

// ─── Vista: Mis datos ─────────────────────────────────────────────────────────

function MisDatos({ onBack }: { onBack: () => void }) {
  const { user, updateUser } = useAuth()
  const [name, setName] = useState(user?.name ?? "")
  const [phone, setPhone] = useState(user?.phone ?? "")
  const [city, setCity] = useState(user?.city ?? "")
  const [address, setAddress] = useState(user?.address ?? "")
  const [saved, setSaved] = useState(false)

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault()
    updateUser({ name, phone, city, address })
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  return (
    <div className="space-y-5">
      <button type="button" onClick={onBack}
        className="flex items-center gap-1.5 text-sm text-white/50 hover:text-white transition-colors cursor-pointer">
        <ChevronLeft className="size-4" /> Volver a mi cuenta
      </button>

      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.25em] text-[#4A90B8] mb-1">
          Mis datos
        </p>
        <h2 className="text-xl font-bold text-white">Tu información</h2>
      </div>

      <div className="rounded-2xl border border-white/[7%] bg-[#0A0A0A] p-6">
        <form onSubmit={handleSave} className="space-y-4">
          {/* Email — solo lectura */}
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold uppercase tracking-[0.15em] text-white/50">
              Email
            </label>
            <div className="flex items-center rounded-xl border border-white/[5%] bg-white/[1%] px-3.5 py-3 gap-2">
              <Mail className="size-4 text-white/20 shrink-0" />
              <span className="text-sm text-white/40">{user?.email}</span>
            </div>
            <p className="text-[11px] text-white/25">El email no se puede cambiar.</p>
          </div>

          <InputField label="Nombre completo" type="text" value={name}
            onChange={setName} placeholder="Juan García" icon={User} />

          <InputField label="Teléfono" type="tel" value={phone}
            onChange={setPhone} placeholder="Ej: 3411234567 (sin el 0)" icon={User} />

          <InputField label="Ciudad" type="text" value={city}
            onChange={setCity} placeholder="Rosario" icon={User} />

          <InputField label="Dirección" type="text" value={address}
            onChange={setAddress} placeholder="Av. Siempreverde 1234, Piso 2" icon={User} />

          <button type="submit"
            className="w-full h-10 rounded-xl bg-[#112A43] border border-[#1E4D7B]/60 text-sm font-semibold text-white hover:bg-[#1E4D7B] transition-colors cursor-pointer mt-2">
            {saved ? "✓ Guardado" : "Guardar cambios"}
          </button>
        </form>
      </div>
    </div>
  )
}

// ─── Panel principal del perfil ───────────────────────────────────────────────

type ProfileView = "home" | "ordenes" | "datos"

function ProfilePanel({ initialView }: { initialView: ProfileView }) {
  const {
    user,
    logout,
    isAdmin,
  } = useAuth()
  const router = useRouter()
  const [view, setView] = useState<ProfileView>(initialView)

  if (!user) return null

  if (view === "ordenes") return <Misordenes onBack={() => setView("home")} />
  if (view === "datos") return <MisDatos onBack={() => setView("home")} />

  const initials = user.name
    .split(" ")
    .map((n: string) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2)

  const menuItems = [
    { icon: ShoppingBag, label: "Mis ordenes", sub: "Historial de compras", view: "ordenes" as ProfileView },
    { icon: User, label: "Mis datos", sub: "Nombre, email y dirección", view: "datos" as ProfileView },
  ]

  return (
    <div className="space-y-6">
      {/* Avatar */}
      <div className="flex items-center gap-4 p-5 rounded-2xl border border-white/[7%] bg-white/[2%]">
        <div className="size-14 rounded-xl bg-[#112A43] border border-[#1E4D7B]/50 flex items-center justify-center text-lg font-bold text-white shrink-0">
          {initials}
        </div>
        <div className="min-w-0">
          <p className="font-semibold text-white truncate">{user.name}</p>
          <p className="text-sm text-white/45 truncate">{user.email}</p>
          <p className="mt-1 text-[11px] text-[#4A90B8] font-medium">Cliente BEYONIX</p>
        </div>
      </div>

      {/* Menú */}
      <div className="space-y-2">
        {menuItems.map((item) => (
          <button
            key={item.label}
            type="button"
            onClick={() => setView(item.view)}
            className="w-full flex items-center gap-4 p-4 rounded-xl border border-white/[6%] bg-white/[2%] hover:bg-white/[4%] hover:border-white/[10%] transition-all group cursor-pointer text-left"
          >
            <div className="size-9 rounded-lg bg-[#112A43]/50 border border-[#1E4D7B]/30 flex items-center justify-center shrink-0">
              <item.icon className="size-4 text-[#4A90B8]" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white">{item.label}</p>
              <p className="text-xs text-white/40">{item.sub}</p>
            </div>
            <ChevronRight className="size-4 text-white/25 group-hover:text-white/50 transition-colors shrink-0" />
          </button>
        ))}
      </div>

      {/* Panel admin */}
      {isAdmin && (
        <button
          type="button"
          title="Ir al panel admin"
          onClick={() =>
            router.push("/admin")
          }
          className="w-full flex items-center gap-4 p-4 rounded-xl border border-[#1E4D7B]/25 bg-[#0A1624] hover:bg-[#112A43] hover:border-[#1E4D7B]/50 transition-all group cursor-pointer text-left"
        >
          <div className="size-9 rounded-lg bg-[#112A43]/60 border border-[#1E4D7B]/40 flex items-center justify-center shrink-0">
            <Shield className="size-4 text-[#4A90B8]" />
          </div>

          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white">
              Panel Admin
            </p>

            <p className="text-xs text-white/45">
              Gestión de tienda
            </p>
          </div>

          <ChevronRight className="size-4 text-white/25 group-hover:text-white/60 transition-colors shrink-0" />
        </button>
      )}

      {/* Cerrar sesión */}
      <button
        type="button"
        onClick={() => { logout(); router.push("/") }}
        className="w-full flex items-center justify-center gap-2 h-11 rounded-xl border border-white/[8%] text-sm font-medium text-white/50 hover:text-white hover:border-white/20 transition-all cursor-pointer"
      >
        <LogOut className="size-4" />
        Cerrar sesión
      </button>
    </div>
  )
}

// ─── Página principal ─────────────────────────────────────────────────────────

export function CuentaClient() {
  const { user, isLoading } = useAuth()
  const [tab, setTab] = useState<"login" | "register">("login")
  const searchParams = useSearchParams()

  // Lee ?tab=ordenes desde el navbar
  const tabParam = searchParams.get("tab") as ProfileView | null
  const initialView: ProfileView = tabParam === "ordenes" ? "ordenes" : tabParam === "datos" ? "datos" : "home"

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
              <p className="text-[11px] font-semibold uppercase tracking-[0.25em] text-[#4A90B8] mb-2">
                Mi cuenta
              </p>
              <h1 className="text-2xl font-bold text-white tracking-tight">
                Hola, {user.name.split(" ")[0]} 👋
              </h1>
            </div>
            <ProfilePanel initialView={initialView} />
          </>
        ) : (
          <>
            <div className="mb-8 text-center">
              <p className="text-[11px] font-semibold uppercase tracking-[0.25em] text-[#4A90B8] mb-2">
                Mi cuenta
              </p>
              <h1 className="text-2xl font-bold text-white tracking-tight mb-1">
                {tab === "login" ? "Bienvenido de vuelta" : "Creá tu cuenta"}
              </h1>
              <p className="text-sm text-white/40">
                {tab === "login"
                  ? "Ingresá para ver tus ordenes y datos."
                  : "Es gratis y tarda menos de un minuto."}
              </p>
            </div>

            {/* Tabs */}
            <div className="flex rounded-xl border border-white/[7%] bg-white/[2%] p-1 mb-7">
              {(["login", "register"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={`flex-1 py-2.5 rounded-lg text-sm font-semibold transition-all cursor-pointer ${
                    tab === t
                      ? "bg-[#112A43] border border-[#1E4D7B]/60 text-white shadow-sm"
                      : "text-white/40 hover:text-white/70"
                  }`}
                >
                  {t === "login" ? "Iniciar sesión" : "Registrarse"}
                </button>
              ))}
            </div>

            <div className="rounded-2xl border border-white/[7%] bg-[#0A0A0A] p-6">
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