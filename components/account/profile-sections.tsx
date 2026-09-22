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
import { ArgentinaPhoneInput } from "@/components/phone/argentina-phone-input"
import { PasswordRequirements } from "@/components/password-requirements"
import { GeographicSelect } from "@/components/checkout/geographic-select"
import { useTerritorialSelector } from "@/hooks/use-territorial-selector"
import { supabase } from "@/lib/supabase/client"
import { getPasswordUpdateErrorMessage } from "@/lib/auth/password-update-messages"
import {
  buildDeliveryAddressDraft,
  nonEmptyAccountText,
  uppercaseAccountText,
  validateDeliveryAddress,
} from "@/lib/account/account-utils"
import {
  FIELD_LIMITS,
  meetsPasswordRequirements,
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
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [showNew, setShowNew] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")
  // Gate síncrono contra doble click/doble submit (mismo patrón que
  // lib/auth/reset-password-submit.ts): se fija ANTES de cualquier `await`,
  // así que no depende de que React ya haya aplicado `disabled={loading}`
  // en el próximo render.
  const submittingRef = useRef(false)

  const isPasswordValid =
    newPassword.length > 0 && meetsPasswordRequirements(newPassword)
  const confirmHasValue = confirmPassword.length > 0
  const passwordsMatch = confirmHasValue && newPassword === confirmPassword
  const passwordsMismatch = confirmHasValue && newPassword !== confirmPassword
  const canSubmit = isPasswordValid && passwordsMatch

  const handleSubmit = async () => {
    if (submittingRef.current) return
    submittingRef.current = true

    try {
      setError("")
      setSuccess("")

      if (!meetsPasswordRequirements(newPassword)) {
        setError("La contraseña no cumple los requisitos.")
        return
      }

      if (newPassword !== confirmPassword) {
        setError("Las contraseñas no coinciden.")
        return
      }

      setLoading(true)

      // supabase.auth.updateUser() opera sobre la sesión activa del usuario
      // autenticado (JWT de la cookie/localStorage de Supabase) -- es el
      // flujo correcto para que un usuario ya logueado cambie su propia
      // contraseña sin reingresar la actual. GoTrue rechaza la llamada si no
      // hay sesión válida, así que un usuario no autenticado nunca puede
      // llegar a este punto (y este componente sólo se renderiza dentro de
      // /cuenta, que ya exige sesión).
      const {
        data: authUserData,
        error: authUserError,
      } = await supabase.auth.getUser()

      if (authUserError) {
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
        setError(getPasswordCooldownMessage(lastPasswordChangedAt))
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

      if (updateError) {
        setError(getPasswordUpdateErrorMessage(updateError.message))
        return
      }

      // Best-effort: la contraseña ya cambió (lo crítico). Mismo criterio
      // que la recuperación (lib/auth/reset-password-submit.ts, que hace
      // esto server-side con admin.auth.admin.signOut(token, "others")) --
      // acá alcanza con el client-side signOut({scope:"others"}) porque ya
      // hay una sesión propia autenticada. Un fallo acá nunca debe mostrarse
      // como si el cambio de contraseña hubiera fallado.
      try {
        await supabase.auth.signOut({ scope: "others" })
      } catch {
        // Ignorado a propósito -- ver comentario arriba.
      }

      setNewPassword("")
      setConfirmPassword("")
      setSuccess("Contraseña actualizada correctamente.")
      setTimeout(() => setSuccess(""), 3500)
    } finally {
      // Se libera SIEMPRE (éxito, error, o cualquier return temprano) --
      // antes quedaba en `true` para siempre tras el primer submit (bug: ni
      // un reintento legítimo tras corregir un error volvía a funcionar).
      setLoading(false)
      submittingRef.current = false
    }
  }

  return (
    <div className="space-y-4">
      <div>
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
        <PasswordRequirements password={newPassword} />
      </div>

      <InputField
        label="Confirmar nueva contraseña"
        type={showConfirm ? "text" : "password"}
        value={confirmPassword}
        onChange={setConfirmPassword}
        placeholder="Repetí la nueva contraseña"
        icon={Lock}
        maxLength={FIELD_LIMITS.password}
        error={passwordsMismatch ? "Las contraseñas no coinciden." : undefined}
        success={passwordsMatch}
        rightElement={
          <div className="flex items-center gap-1">
            {passwordsMatch && (
              <Check
                aria-hidden="true"
                className="size-4 text-[var(--account-success-text)]"
                strokeWidth={2.5}
              />
            )}
            <button
              type="button"
              aria-label="Mostrar u ocultar confirmación"
              onClick={() => setShowConfirm((value) => !value)}
              className="flex size-7 cursor-pointer items-center justify-center rounded-lg text-[var(--account-text-muted)] transition-colors hover:bg-[var(--account-surface-hover)] hover:text-[var(--account-text-primary)]"
            >
              {showConfirm ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
        }
      />

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
        disabled={loading || !canSubmit}
        onClick={handleSubmit}
        size="lg"
        fullWidth
      >
        {loading ? "Actualizando..." : "Cambiar contraseña"}
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
  // Mismo sistema que Registrarse/Checkout (hooks/use-territorial-selector.ts
  // + components/checkout/geographic-select.tsx): provincia sólo puede venir
  // del listado de Andreani, localidad/CP se resuelven automáticamente por
  // catálogo con fallback manual explícito. Se hidrata UNA sola vez con el
  // valor histórico guardado -- si no matchea contra el catálogo actual, el
  // hook pasa solo a modo manual conservando el valor (nunca lo pisa).
  const territorial = useTerritorialSelector({
    province: uppercaseAccountText(nonEmptyAccountText(user?.province) ?? ""),
    locality: uppercaseAccountText(nonEmptyAccountText(user?.city) ?? ""),
    postalCode: user?.postalCode ?? "",
  })
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
    territorial.province,
    territorial.postalCode,
    street,
    streetNumber,
    floor,
    apartment,
    territorial.locality,
    references,
  ].join("|")
  const savedSignatureRef = useRef("")

  useEffect(() => {
    setPhone(user?.phone ?? "")
    setDni(onlyDigits(user?.dni ?? "", FIELD_LIMITS.dni))
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
      localidad: territorial.locality,
      province: territorial.province,
      postalCode: territorial.postalCode,
      references,
    })

    if (validationError) {
      setProfileError(validationError)
      return
    }

    const deliveryAddress = buildDeliveryAddressDraft({
      postalCode: territorial.postalCode,
      street,
      streetNumber,
      floor,
      apartment,
      locality: territorial.locality,
      province: territorial.province,
    })
    const deliveryError = validateDeliveryAddress(deliveryAddress)

    if (deliveryError) {
      setProfileError(deliveryError)
      return
    }

    try {
      const normalizedProvince = uppercaseAccountText(territorial.province.trim())
      const normalizedStreet = uppercaseAccountText(street.trim())
      const normalizedFloor = uppercaseAccountText(floor.trim())
      const normalizedApartment = uppercaseAccountText(apartment.trim())
      const normalizedLocality = uppercaseAccountText(territorial.locality.trim())
      const normalizedReferences = uppercaseAccountText(references.trim())
      const normalizedPostalCode = territorial.postalCode.trim()
      await updateUser({
        phone,
        dni: normalizedDni,
        province: normalizedProvince,
        street: normalizedStreet,
        streetNumber,
        floor: normalizedFloor,
        apartment: normalizedApartment,
        city: normalizedLocality,
        postalCode: normalizedPostalCode,
        references: normalizedReferences,
      })
      savedSignatureRef.current = [
        phone,
        normalizedDni,
        normalizedProvince,
        normalizedPostalCode,
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
                <ArgentinaPhoneInput
                  id="profile-phone"
                  label="Teléfono móvil"
                  value={phone}
                  onChange={setPhone}
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
              <div className="space-y-1 md:col-span-2 xl:col-span-3">
                <label className="block text-11px font-semibold uppercase tracking-widest text-[var(--account-text-muted)]">
                  Provincia
                </label>
                <GeographicSelect
                  id="mis-datos-provincia"
                  value={territorial.province}
                  options={territorial.provinceOptions}
                  onChange={territorial.handleProvinceChange}
                  placeholder="Seleccioná una provincia"
                  ariaLabel="Seleccionar provincia"
                />
              </div>

              <div className="space-y-1 md:col-span-4 xl:col-span-4">
                {territorial.manualLocalityMode ? (
                  <>
                    <InputField
                      label="Localidad"
                      type="text"
                      value={territorial.locality}
                      onChange={(value) => territorial.setLocality(uppercaseAccountText(value))}
                      placeholder="Rosario"
                      icon={MapPin}
                      maxLength={60}
                    />
                    <button
                      type="button"
                      onClick={territorial.disableManualLocality}
                      className="cursor-pointer text-11px font-semibold text-[var(--account-accent-soft)] transition-colors hover:text-[var(--account-text-primary)]"
                    >
                      Volver a selección automática
                    </button>
                  </>
                ) : (
                  <>
                    <label className="block text-11px font-semibold uppercase tracking-widest text-[var(--account-text-muted)]">
                      Localidad
                    </label>
                    <GeographicSelect
                      id="mis-datos-localidad"
                      value={territorial.locality}
                      options={territorial.localityOptions}
                      onChange={territorial.handleLocalityChange}
                      placeholder="Seleccioná una localidad"
                      loading={territorial.localitiesLoading}
                      loadingLabel="Cargando localidades…"
                      disabled={!territorial.province || territorial.localitiesLoading}
                      searchable
                      emptyLabel="No hay localidades disponibles para esta provincia."
                      errorMessage={territorial.localityLoadError}
                      ariaLabel="Seleccionar localidad"
                    />
                    {territorial.localityLoadError && (
                      <p className="text-11px font-semibold text-[var(--account-danger-text)]">
                        {territorial.localityLoadError}
                      </p>
                    )}
                    {territorial.province && (
                      <button
                        type="button"
                        onClick={territorial.enableManualLocality}
                        className="cursor-pointer text-11px font-semibold text-[var(--account-accent-soft)] transition-colors hover:text-[var(--account-text-primary)]"
                      >
                        ¿No encontrás tu localidad? Ingresar manualmente
                      </button>
                    )}
                  </>
                )}
              </div>

              <div className="space-y-1 md:col-span-2 xl:col-span-2">
                {territorial.cpEntryIsManual ? (
                  <InputField
                    label="Código postal"
                    type="tel"
                    value={territorial.postalCode}
                    onChange={(value) => territorial.handlePostalCodeChange(onlyDigits(value, FIELD_LIMITS.postalCode))}
                    placeholder="2000"
                    icon={Hash}
                    maxLength={FIELD_LIMITS.postalCode}
                    inputMode="numeric"
                  />
                ) : (
                  <>
                    <label className="block text-11px font-semibold uppercase tracking-widest text-[var(--account-text-muted)]">
                      Código postal
                    </label>
                    <GeographicSelect
                      id="mis-datos-cp"
                      value={territorial.postalCode}
                      options={territorial.postalCodeOptions}
                      onChange={territorial.handlePostalCodeChange}
                      placeholder={
                        territorial.postalCodeLoadError
                          ? "No disponible"
                          : territorial.showManualPostalCodeOption
                            ? "Sin códigos disponibles"
                            : "Seleccioná un código postal"
                      }
                      loading={territorial.postalCodesLoading}
                      loadingLabel="Cargando códigos postales…"
                      disabled={
                        !territorial.locality ||
                        territorial.postalCodesLoading ||
                        territorial.postalCodeOptions.length === 0
                      }
                      locked={territorial.postalCodeOptions.length === 1}
                      compact
                      errorMessage={territorial.postalCodeLoadError}
                      ariaLabel="Seleccionar código postal"
                    />
                    {territorial.postalCodeLoadError && (
                      <div className="space-y-0.5">
                        <p className="text-11px font-semibold text-[var(--account-danger-text)]">
                          {territorial.postalCodeLoadError}
                        </p>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                          <button
                            type="button"
                            onClick={territorial.retryPostalCodes}
                            className="cursor-pointer text-11px font-semibold text-[var(--account-accent-soft)] transition-colors hover:text-[var(--account-text-primary)]"
                          >
                            Reintentar
                          </button>
                          <button
                            type="button"
                            onClick={territorial.enableManualPostalCode}
                            className="cursor-pointer text-11px font-semibold text-[var(--account-accent-soft)] transition-colors hover:text-[var(--account-text-primary)]"
                          >
                            Ingresar manualmente
                          </button>
                        </div>
                      </div>
                    )}
                    {territorial.showManualPostalCodeOption && (
                      <div className="space-y-0.5">
                        <p className="text-11px leading-4 text-[var(--account-text-muted)]">
                          No encontramos códigos postales para esta localidad.
                        </p>
                        <button
                          type="button"
                          onClick={territorial.enableManualPostalCode}
                          className="cursor-pointer text-11px font-semibold text-[var(--account-accent-soft)] transition-colors hover:text-[var(--account-text-primary)]"
                        >
                          Ingresar código postal manualmente
                        </button>
                      </div>
                    )}
                  </>
                )}
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
