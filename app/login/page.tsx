"use client"

import {
  useState,
} from "react"

import {
  useRouter,
  useSearchParams,
} from "next/navigation"

import { Loader2 } from "lucide-react"

import { useAuth } from "@/context/auth-context"

export default function LoginPage() {
  const router = useRouter()

  const searchParams =
    useSearchParams()

  const {
    login,
    register,
  } = useAuth()

  const [mode, setMode] =
    useState<
      "login" | "register"
    >("login")

  const [name, setName] =
    useState("")

  const [email, setEmail] =
    useState("")

  const [password, setPassword] =
    useState("")

  const [error, setError] =
    useState("")

  const [success, setSuccess] =
    useState("")

  const [loading, setLoading] =
    useState(false)

  const handleSubmit = async (
    e: React.FormEvent
  ) => {
    e.preventDefault()

    setError("")
    setSuccess("")

    setLoading(true)

    if (mode === "login") {
      const result =
        await login(
          email,
          password
        )

      setLoading(false)

      if (!result.ok) {
        setError(
          result.error ||
            "Error al iniciar sesión"
        )

        return
      }

      const redirect =
        searchParams.get(
          "redirect"
        )

      router.push(
        redirect || "/"
      )

      return
    }

    const result =
      await register(
        name,
        email,
        password
      )

    setLoading(false)

    if (!result.ok) {
      setError(
        result.error ||
          "Error al crear cuenta"
      )

      return
    }

    setSuccess(
      "Cuenta creada correctamente."
    )

    const redirect =
      searchParams.get(
        "redirect"
      )

    router.push(
      redirect || "/"
    )
  }

  const handleForgotPassword =
    async () => {
      if (!email) {
        setError(
          "Ingresá tu email primero."
        )

        return
      }

      setError("")
      setSuccess("")

      const response =
        await fetch(
          "/api/auth/reset-password",
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",
            },

            body: JSON.stringify({
              email,
            }),
          }
        )

      const data =
        await response.json()

      if (!response.ok) {
        setError(
          data.error ||
            "No se pudo enviar el email."
        )

        return
      }

      setSuccess(
        "Te enviamos un email para restablecer tu contraseña."
      )
    }

  return (
    <main className="flex min-h-screen items-center justify-center bg-black px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0f0f0f] p-8 shadow-2xl">
        <div className="mb-8">
          <p className="mb-2 text-11px font-medium uppercase tracking-[0.3em] text-[#3b82f6]">
            BEYONIX
          </p>

          <h1 className="text-3xl font-bold text-white">
            {mode === "login"
              ? "Iniciar sesión"
              : "Crear cuenta"}
          </h1>

          <p className="mt-2 text-sm text-white/55">
            {mode === "login"
              ? "Accedé a tu cuenta para continuar la compra."
              : "Registrate para comprar en BEYONIX."}
          </p>
        </div>

        {/* Tabs */}
        <div className="mb-6 grid grid-cols-2 rounded-xl border border-white/10 bg-black p-1">
          <button
            type="button"
            aria-label="Iniciar sesión"
            title="Iniciar sesión"
            onClick={() =>
              setMode("login")
            }
            className={`h-11 rounded-lg text-sm font-medium transition-all ${
              mode === "login"
                ? "bg-white text-black"
                : "text-white/60 hover:text-white"
            }`}
          >
            Iniciar sesión
          </button>

          <button
            type="button"
            aria-label="Registrarme"
            title="Registrarme"
            onClick={() =>
              setMode(
                "register"
              )
            }
            className={`h-11 rounded-lg text-sm font-medium transition-all ${
              mode === "register"
                ? "bg-white text-black"
                : "text-white/60 hover:text-white"
            }`}
          >
            Registrarme
          </button>
        </div>

        <form
          onSubmit={
            handleSubmit
          }
          className="space-y-5"
        >
          {mode ===
            "register" && (
            <div>
              <label className="mb-2 block text-sm text-white/70">
                Nombre
              </label>

              <input
                type="text"
                aria-label="Nombre"
                title="Nombre"
                required
                value={name}
                onChange={(e) =>
                  setName(
                    e.target.value
                  )
                }
                className="h-12 w-full rounded-xl border border-white/10 bg-black px-4 text-white outline-none transition-colors focus:border-[#3b82f6]"
              />
            </div>
          )}

          <div>
            <label className="mb-2 block text-sm text-white/70">
              Email
            </label>

            <input
              type="email"
              aria-label="Email"
              title="Email"
              required
              value={email}
              onChange={(e) =>
                setEmail(
                  e.target.value
                )
              }
              className="h-12 w-full rounded-xl border border-white/10 bg-black px-4 text-white outline-none transition-colors focus:border-[#3b82f6]"
            />
          </div>

          <div>
            <label className="mb-2 block text-sm text-white/70">
              Contraseña
            </label>

            <input
              type="password"
              aria-label="Contraseña"
              title="Contraseña"
              required
              value={password}
              onChange={(e) =>
                setPassword(
                  e.target.value
                )
              }
              className="h-12 w-full rounded-xl border border-white/10 bg-black px-4 text-white outline-none transition-colors focus:border-[#3b82f6]"
            />
          </div>

          {mode === "login" && (
            <button
              type="button"
              aria-label="Olvidé mi contraseña"
              title="Olvidé mi contraseña"
              onClick={
                handleForgotPassword
              }
              className="text-sm text-[#3b82f6] transition-opacity hover:opacity-80"
            >
              ¿Olvidaste tu contraseña?
            </button>
          )}

          {error && (
            <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              {error}
            </div>
          )}

          {success && (
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-400">
              {success}
            </div>
          )}

          <button
            type="submit"
            aria-label={
              mode === "login"
                ? "Ingresar"
                : "Crear cuenta"
            }
            title={
              mode === "login"
                ? "Ingresar"
                : "Crear cuenta"
            }
            disabled={loading}
            className="flex h-12 w-full items-center justify-center rounded-xl bg-white font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {loading ? (
              <Loader2 className="size-5 animate-spin" />
            ) : mode ===
              "login" ? (
              "Ingresar"
            ) : (
              "Crear cuenta"
            )}
          </button>
        </form>
      </div>
    </main>
  )
}