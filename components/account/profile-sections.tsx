"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import {
  Camera,
  Check,
  Eye,
  EyeOff,
  Hash,
  Lock,
  Mail,
  MapPin,
  Phone,
  User,
} from "lucide-react"

import { useAuth } from "@/context/auth-context"
import { AccountViewFrame } from "@/components/account/account-view-frame"
import { InputField, ReadOnlyField, TextareaField } from "@/components/account/account-form-fields"
import { ProvinceSelect } from "@/components/province-select"
import { supabase } from "@/lib/supabase/client"
import {
  buildDeliveryAddressDraft,
  nonEmptyAccountText,
  uppercaseAccountText,
  validateAccountPassword,
  validateDeliveryAddress,
} from "@/lib/account/account-utils"
import {
  FIELD_LIMITS,
  onlyDigits,
  validateProfilePayload,
} from "@/lib/validation/account-fields"
import { beyonixHoverBorder, cn } from "@/lib/utils"
const PASSWORD_CHANGE_COOLDOWN_DAYS = 15
const PASSWORD_CHANGE_COOLDOWN_MS =
  PASSWORD_CHANGE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000

function getPasswordCooldownMessage(lastChangedAt: string) {
  const availableAt =
    new Date(
      new Date(lastChangedAt).getTime() +
        PASSWORD_CHANGE_COOLDOWN_MS
    )

  return `La contraseña se puede cambiar una vez cada 15 días. Vas a poder cambiarla nuevamente el ${availableAt.toLocaleDateString("es-AR")}.`
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
      setError("Introduce tu contraseña actual.")
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
      setError("No se pudo validar la sesión. Inténtalo de nuevo.")
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
      setError("No se pudo actualizar la contraseña. Inténtalo de nuevo.")
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

export function Seguridad({ onBack }: { onBack: () => void }) {
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

export function MisDatos({ onBack }: { onBack: () => void }) {
  const { user, updateUser } = useAuth()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [phone, setPhone] = useState(user?.phone ?? "")
  const [province, setProvince] = useState(
    uppercaseAccountText(nonEmptyAccountText(user?.province) ?? "")
  )
  const [postalCode, setPostalCode] = useState(user?.postalCode ?? "")
  const [street, setStreet] = useState(
    uppercaseAccountText(nonEmptyAccountText(user?.street) ?? "")
  )
  const [streetNumber, setStreetNumber] = useState(
    user?.streetNumber ?? ""
  )
  const [floor, setFloor] = useState(
    uppercaseAccountText(nonEmptyAccountText(user?.floor) ?? "")
  )
  const [apartment, setApartment] = useState(
    uppercaseAccountText(
      nonEmptyAccountText(user?.apartment) ?? ""
    )
  )
  const [locality, setLocality] = useState(
    uppercaseAccountText(nonEmptyAccountText(user?.city) ?? "")
  )
  const [references, setReferences] = useState(
    uppercaseAccountText(user?.references ?? "")
  )
  const [avatarUrl, setAvatarUrl] = useState(user?.avatarUrl ?? "")
  const [saved, setSaved] = useState(false)
  const [profileError, setProfileError] = useState("")
  const [avatarLoading, setAvatarLoading] = useState(false)
  const [avatarError, setAvatarError] = useState("")
  const formSignature = [
    phone,
    province,
    postalCode,
    street,
    streetNumber,
    floor,
    apartment,
    locality,
    references,
  ].join("|")
  const savedSignatureRef = useRef("")

  useEffect(() => {
    setPhone(user?.phone ?? "")
    setProvince(uppercaseAccountText(nonEmptyAccountText(user?.province) ?? ""))
    setPostalCode(user?.postalCode ?? "")
    setStreet(
      uppercaseAccountText(nonEmptyAccountText(user?.street) ?? "")
    )
    setStreetNumber(user?.streetNumber ?? "")
    setFloor(
      uppercaseAccountText(nonEmptyAccountText(user?.floor) ?? "")
    )
    setApartment(
      uppercaseAccountText(
        nonEmptyAccountText(user?.apartment) ?? ""
      )
    )
    setLocality(
      uppercaseAccountText(nonEmptyAccountText(user?.city) ?? "")
    )
    setReferences(uppercaseAccountText(user?.references ?? ""))
    setAvatarUrl(user?.avatarUrl ?? "")
  }, [user])

  useEffect(() => {
    if (saved && savedSignatureRef.current !== formSignature) {
      setSaved(false)
    }
  }, [formSignature, saved])

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setProfileError("")

    const validationError = validateProfilePayload({
      name: user?.name ?? "",
      phone,
      calle: street,
      numero: streetNumber,
      piso: floor,
      departamento: apartment,
      localidad: locality,
      province,
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

    try {
      const normalizedProvince = uppercaseAccountText(province.trim())
      const normalizedStreet = uppercaseAccountText(street.trim())
      const normalizedFloor = uppercaseAccountText(floor.trim())
      const normalizedApartment = uppercaseAccountText(apartment.trim())
      const normalizedLocality = uppercaseAccountText(locality.trim())
      const normalizedReferences = uppercaseAccountText(references.trim())
      await updateUser({
        phone,
        province: normalizedProvince,
        street: normalizedStreet,
        streetNumber,
        floor: normalizedFloor,
        apartment: normalizedApartment,
        city: normalizedLocality,
        postalCode,
        references: normalizedReferences,
      })
      savedSignatureRef.current = [
        phone,
        normalizedProvince,
        postalCode,
        normalizedStreet,
        streetNumber,
        normalizedFloor,
        normalizedApartment,
        normalizedLocality,
        normalizedReferences,
      ].join("|")
      setSaved(true)
    } catch {
      setProfileError("No hemos podido guardar tus datos. Inténtalo de nuevo.")
    }
  }

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]

    if (!file || !user) return

    if (!file.type.startsWith("image/")) {
      setAvatarError("Sube una imagen válida.")
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
              value={uppercaseAccountText(user?.username ?? "")}
              icon={User}
              help="El nombre de usuario no se puede cambiar."
            />
            <ReadOnlyField
              label="Email"
              value={user?.email || ""}
              icon={Mail}
              help="El email no se puede cambiar."
            />

            <ReadOnlyField
              label="Nombre y apellido"
              value={uppercaseAccountText(user?.name ?? "")}
              icon={User}
              help="El nombre y apellido no se pueden cambiar."
            />
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
              <InputField label="Calle" type="text" value={street} onChange={(value) => setStreet(uppercaseAccountText(value))} placeholder="San Martín" icon={MapPin} maxLength={60} />
              <InputField label="Número" type="text" value={streetNumber} onChange={(value) => setStreetNumber(onlyDigits(value, 8))} placeholder="1234" icon={Hash} maxLength={8} inputMode="numeric" />
              <InputField label="Piso opcional" type="text" value={floor} onChange={(value) => setFloor(uppercaseAccountText(value))} placeholder="3" icon={Hash} maxLength={12} />
              <InputField label="Departamento opcional" type="text" value={apartment} onChange={(value) => setApartment(uppercaseAccountText(value))} placeholder="B" icon={Hash} maxLength={12} />
              <InputField label="Código postal" type="tel" value={postalCode} onChange={(value) => setPostalCode(onlyDigits(value, FIELD_LIMITS.postalCode))} placeholder="2000" icon={Hash} maxLength={FIELD_LIMITS.postalCode} inputMode="numeric" />
              <InputField label="Localidad" type="text" value={locality} onChange={(value) => setLocality(uppercaseAccountText(value))} placeholder="Rosario" icon={MapPin} maxLength={60} />
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold uppercase tracking-widest text-white/60">
                  Provincia / Región
                </label>
                <ProvinceSelect value={province} onChange={(value) => setProvince(uppercaseAccountText(value))} />
              </div>
              <div className="md:col-span-2">
                <TextareaField
                  label="Referencias para llegar"
                  value={references}
                  onChange={(value) => setReferences(uppercaseAccountText(value))}
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
            className={`flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border text-sm font-semibold text-white transition-colors ${
              saved
                ? "border-emerald-400/60 bg-emerald-600 hover:bg-emerald-600"
                : "border-beyonix-blue-light/60 bg-beyonix-blue hover:bg-beyonix-blue-light"
            }`}
          >
            {saved ? (
              <>
                <Check className="size-4" />
                Guardado
              </>
            ) : (
              "Guardar cambios"
            )}
          </button>
        </form>
      </div>
    </AccountViewFrame>
  )
}
