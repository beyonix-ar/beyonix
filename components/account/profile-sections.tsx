"use client"

import { useEffect, useRef, useState } from "react"
import {
  Camera,
  Check,
  Eye,
  EyeOff,
  Hash,
  IdCard,
  Lock,
  Mail,
  MapPin,
  Phone,
  ShieldCheck,
  User,
} from "lucide-react"

import { useAuth } from "@/context/auth-context"
import {
  AccountCard,
  BeyonixButton,
  IconContainer,
} from "@/components/account/account-ui"
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
            onClick={() => setShowCurrent((value) => !value)}
            className="flex size-7 cursor-pointer items-center justify-center rounded-lg text-[var(--account-text-muted)] transition-colors hover:bg-[var(--account-surface-hover)] hover:text-[var(--account-text-primary)]"
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
            onClick={() => setShowNew((value) => !value)}
            className="flex size-7 cursor-pointer items-center justify-center rounded-lg text-[var(--account-text-muted)] transition-colors hover:bg-[var(--account-surface-hover)] hover:text-[var(--account-text-primary)]"
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
            onClick={() => setShowConfirm((value) => !value)}
            className="flex size-7 cursor-pointer items-center justify-center rounded-lg text-[var(--account-text-muted)] transition-colors hover:bg-[var(--account-surface-hover)] hover:text-[var(--account-text-primary)]"
          >
            {showConfirm ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        }
      />

      <div className="rounded-xl border border-[var(--account-border-subtle)] bg-[var(--account-surface-raised)] p-3">
        <p className="text-11px font-semibold uppercase tracking-widest text-[var(--account-text-muted)]">
          Requisitos
        </p>
        <p className="mt-2 text-sm leading-6 text-[var(--account-text-secondary)]">
          Mínimo 8 caracteres, una mayúscula y al menos un número. Puede cambiarse una vez cada 15 días.
        </p>
      </div>

      {error && (
        <AccountCard padding="sm" className="border-[var(--account-danger-border)] bg-[var(--account-danger-bg)]">
          <p className="text-sm text-[var(--account-danger-text)]">{error}</p>
        </AccountCard>
      )}

      {success && (
        <AccountCard padding="sm" className="border-[var(--account-success-border)] bg-[var(--account-success-bg)]">
          <p className="text-sm text-[var(--account-success-text)]">{success}</p>
        </AccountCard>
      )}

      <BeyonixButton
        type="button"
        aria-label="Cambiar contraseña"
        disabled={loading}
        onClick={handleSubmit}
        size="lg"
        fullWidth
      >
        {loading ? "Validando..." : "Cambiar contraseña"}
      </BeyonixButton>
    </div>
  )
}

export function Seguridad({ onBack }: { onBack: () => void }) {
  return (
    <AccountViewFrame
      onBack={onBack}
      kicker="Seguridad"
      title="Cambiar contraseña"
      description="Actualizá tu acceso con los mismos controles seguros del área de cliente."
      headingClassName="mx-auto w-full max-w-[920px] items-center justify-center gap-2 py-4 text-center sm:flex-col sm:items-center sm:justify-center sm:py-4 [&_p]:mx-auto [&_p]:max-w-none"
    >
      <AccountCard
        variant="form"
        padding="lg"
        className="mx-auto w-full max-w-[920px]"
      >
        <div className="grid gap-6 lg:grid-cols-[minmax(0,0.64fr)_minmax(230px,0.36fr)] lg:items-start">
          <ChangePasswordForm />

          <aside className="border-t border-[var(--account-border-subtle)] pt-5 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
            <IconContainer size="md" tone="highlight" className="mb-4">
              <ShieldCheck className="size-6" />
            </IconContainer>
            <p className="text-lg font-semibold text-[var(--account-text-primary)]">
              Acceso protegido
            </p>
            <p className="mt-3 text-sm leading-6 text-[var(--account-text-secondary)]">
              Usá una contraseña única y evitá compartirla. Por seguridad, el
              cambio puede realizarse una vez cada 15 días.
            </p>

            <div className="mt-5 rounded-xl bg-[var(--account-surface-raised)] px-4 py-3">
              <p className="text-11px font-semibold uppercase tracking-widest text-[var(--account-text-muted)]">
                Recomendación
              </p>
              <p className="mt-2 text-sm leading-6 text-[var(--account-text-secondary)]">
                Combiná letras, números y una frase fácil de recordar para vos.
              </p>
            </div>
          </aside>
        </div>
      </AccountCard>
    </AccountViewFrame>
  )
}

export function MisDatos({ onBack }: { onBack: () => void }) {
  const { user, updateUser } = useAuth()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [phone, setPhone] = useState(user?.phone ?? "")
  const [dni, setDni] = useState(
    onlyDigits(user?.dni ?? "", FIELD_LIMITS.dni)
  )
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
  const storedDni = onlyDigits(user?.dni ?? "", FIELD_LIMITS.dni)
  const canEditDni = storedDni.length === 0
  const formSignature = [
    phone,
    dni,
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
    setDni(onlyDigits(user?.dni ?? "", FIELD_LIMITS.dni))
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
    const normalizedDni = canEditDni ? dni : storedDni

    const validationError = validateProfilePayload({
      name: user?.name ?? "",
      phone,
      dni: normalizedDni,
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
        dni: normalizedDni,
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
        normalizedDni,
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
    } catch (error) {
      setProfileError(
        error instanceof Error
          ? error.message
          : "No hemos podido guardar tus datos. Inténtalo de nuevo."
      )
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
      description="Gestioná tu teléfono, dirección de entrega y foto de perfil."
      className="max-w-[1160px] space-y-3"
      headingClassName="mx-auto w-full max-w-[1160px] py-4 sm:py-4"
    >
      <AccountCard variant="form" padding="sm" className="mx-auto w-full max-w-[1160px]">
        <form onSubmit={handleSave} className="space-y-3">
          <div className="rounded-2xl bg-[var(--account-surface-raised)] p-3 sm:p-4">
            <div className="grid gap-4 lg:grid-cols-[minmax(220px,0.32fr)_minmax(0,0.68fr)] lg:items-center">
              <div className="flex min-w-0 items-center gap-3">
                <div className="relative shrink-0">
                  <div className="flex size-16 items-center justify-center overflow-hidden rounded-full border border-white/14 bg-white text-black shadow-sm shadow-black/40 sm:size-18">
                    {avatarUrl ? (
                      <img src={avatarUrl} alt="" className="size-full object-cover" />
                    ) : (
                      <User className="size-8 sm:size-9" />
                    )}
                  </div>

                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleAvatarChange}
                    className="hidden"
                    aria-label="Cambiar foto de perfil"
                  />

                  <button
                    type="button"
                    aria-label="Subir foto de perfil"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={avatarLoading}
                    className="absolute -bottom-1 -right-1 flex size-7 cursor-pointer items-center justify-center rounded-lg border border-[var(--account-border-strong)] bg-[var(--account-surface)] text-[var(--account-text-primary)] shadow-[0_8px_18px_rgba(0,0,0,0.28)] transition-colors hover:border-[var(--account-accent-soft)] disabled:opacity-50"
                  >
                    <Camera className="size-3.5" />
                  </button>
                </div>

                <div className="min-w-0">
                  <p className="truncate text-base font-semibold text-[var(--account-text-primary)]">
                    {user?.name}
                  </p>
                  <p className="truncate text-sm text-[var(--account-text-secondary)]">{user?.email}</p>
                  <p className="mt-1 text-11px font-medium uppercase tracking-widest text-[var(--account-accent-soft)]">
                    Cliente BEYONIX
                  </p>
                  <p className="mt-2 text-xs leading-5 text-[var(--account-text-muted)]">
                    Imagen JPG o PNG, hasta 2 MB.
                  </p>
                  {avatarError && (
                    <p className="mt-1 text-xs text-[var(--account-danger-text)]">{avatarError}</p>
                  )}
                </div>
              </div>

              <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
                <ReadOnlyField
                  label="Usuario"
                  value={uppercaseAccountText(user?.username ?? "")}
                  icon={User}
                />
                <ReadOnlyField
                  label="Nombre y apellido"
                  value={uppercaseAccountText(user?.name ?? "")}
                  icon={User}
                />
                {canEditDni ? (
                  <InputField
                    label="DNI"
                    type="tel"
                    value={dni}
                    onChange={(value) =>
                      setDni(onlyDigits(value, FIELD_LIMITS.dni))
                    }
                    placeholder="12345678"
                    icon={IdCard}
                    maxLength={FIELD_LIMITS.dni}
                    inputMode="numeric"
                  />
                ) : (
                  <ReadOnlyField
                    label="DNI"
                    value={storedDni}
                    icon={IdCard}
                  />
                )}
                <ReadOnlyField
                  label="Email"
                  value={user?.email || ""}
                  icon={Mail}
                />
                <InputField
                  label="Teléfono móvil"
                  type="tel"
                  value={phone}
                  onChange={(value) =>
                    setPhone(onlyDigits(value, FIELD_LIMITS.phone))
                  }
                  placeholder="1100000000"
                  icon={Phone}
                  maxLength={FIELD_LIMITS.phone}
                  inputMode="numeric"
                />
              </div>
            </div>
          </div>

          <div className="border-t border-[var(--account-border-subtle)] pt-3">
            <div className="mb-2 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-11px font-semibold uppercase tracking-widest text-[var(--account-accent-soft)]">
                  Dirección de entrega
                </p>
                <p className="mt-1 text-xs leading-5 text-[var(--account-text-muted)]">
                  Datos para preparar futuros envíos a domicilio con Andreani.
                </p>
              </div>
            </div>

            <div className="grid gap-2.5 md:grid-cols-6 xl:grid-cols-12">
              <InputField className="md:col-span-4 xl:col-span-5" label="Calle" type="text" value={street} onChange={(value) => setStreet(uppercaseAccountText(value))} placeholder="San Martín" icon={MapPin} maxLength={FIELD_LIMITS.street} />
              <InputField className="md:col-span-2 xl:col-span-2" label="Número" type="text" value={streetNumber} onChange={(value) => setStreetNumber(onlyDigits(value, 8))} placeholder="1234" icon={Hash} maxLength={8} inputMode="numeric" />
              <InputField className="md:col-span-2 xl:col-span-2" label="Piso opcional" type="text" value={floor} onChange={(value) => setFloor(uppercaseAccountText(value))} placeholder="3" icon={Hash} maxLength={12} />
              <InputField className="md:col-span-2 xl:col-span-3" label="Departamento opcional" type="text" value={apartment} onChange={(value) => setApartment(uppercaseAccountText(value))} placeholder="B" icon={Hash} maxLength={12} />
              <InputField className="md:col-span-2 xl:col-span-2" label="Código postal" type="tel" value={postalCode} onChange={(value) => setPostalCode(onlyDigits(value, FIELD_LIMITS.postalCode))} placeholder="2000" icon={Hash} maxLength={FIELD_LIMITS.postalCode} inputMode="numeric" />
              <InputField className="md:col-span-4 xl:col-span-4" label="Localidad" type="text" value={locality} onChange={(value) => setLocality(uppercaseAccountText(value))} placeholder="Rosario" icon={MapPin} maxLength={60} />
              <div className="space-y-1 md:col-span-2 xl:col-span-3">
                <label className="block text-11px font-semibold uppercase tracking-widest text-[var(--account-text-muted)]">
                  Provincia / Región
                </label>
                <ProvinceSelect value={province} onChange={(value) => setProvince(uppercaseAccountText(value))} />
              </div>
              <TextareaField
                className="md:col-span-6 xl:col-span-12"
                label="Referencias para llegar"
                value={references}
                onChange={(value) => setReferences(uppercaseAccountText(value))}
                placeholder="Entre calles, fachada blanca, portón negro, antes de llegar a la esquina."
                icon={MapPin}
                maxLength={FIELD_LIMITS.references}
              />
            </div>
          </div>

          {profileError && (
            <AccountCard padding="sm" className="border-[var(--account-danger-border)] bg-[var(--account-danger-bg)]">
              <p className="text-sm text-[var(--account-danger-text)]">{profileError}</p>
            </AccountCard>
          )}

          <div className="flex justify-center pt-1">
            <BeyonixButton
              type="submit"
              aria-label="Guardar cambios"
              size="lg"
              className={
                saved
                  ? "w-full border-[var(--account-success-border)] bg-[var(--account-success-bg)] text-[var(--account-success-text)] hover:bg-[var(--account-success-bg)] sm:w-auto sm:min-w-[220px]"
                  : "w-full sm:w-auto sm:min-w-[220px]"
              }
            >
              {saved ? (
                <>
                  <Check className="size-4" />
                  Guardado
                </>
              ) : (
                "Guardar cambios"
              )}
            </BeyonixButton>
          </div>
        </form>
      </AccountCard>
    </AccountViewFrame>
  )
}
