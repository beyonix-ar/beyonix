"use client"

import { useEffect, useId } from "react"
import type { InputHTMLAttributes } from "react"

import {
  ARGENTINA_PHONE_PREFIX,
  normalizeArgentineNationalPhone,
} from "@/lib/validation/phone-ar"
import { cn } from "@/lib/utils"

/**
 * Componente compartido para TODOS los campos de teléfono de BEYONIX
 * (Registro, Checkout, Mi Cuenta). Centraliza: prefijo +54 fijo, formato
 * visual, sanitización de lo pegado/tipeado, helper "no agregues el 0",
 * normalización al valor canónico (ver lib/validation/phone-ar.ts) y estados
 * disabled/error/focus. `value`/`onChange` siempre trabajan en el número
 * nacional canónico (sin +54, sin el 0) -- nunca hace falta que el consumidor
 * lo normalice antes o después.
 *
 * Sin colores propios fijos: usa los tokens --account-* (mismo sistema que
 * el resto del storefront, ya theme-aware en Light/Dark). Las pantallas con
 * su propio esquema de inputs (login/checkout, con clases dedicadas
 * `beyonix-login-input`/`beyonix-checkout-input`) pueden pasar
 * `inputClassName`/`prefixClassName`/`heightClassName` para heredar esa
 * apariencia en vez del default.
 */
export function ArgentinaPhoneInput({
  id,
  label = "Teléfono",
  value,
  onChange,
  required = true,
  disabled = false,
  error,
  placeholder = "341 1234567",
  autoComplete = "tel-national",
  name,
  className,
  labelClassName,
  heightClassName = "h-11",
  outerClassName,
  prefixClassName,
  inputClassName,
  helperClassName,
  hideHelper = false,
  inputMode = "numeric",
}: {
  id?: string
  label?: string | null
  value: string
  onChange: (nationalDigits: string) => void
  required?: boolean
  disabled?: boolean
  error?: string
  placeholder?: string
  autoComplete?: string
  name?: string
  className?: string
  labelClassName?: string
  heightClassName?: string
  /** Reemplaza por completo el borde/fondo del contenedor (prefijo + input) -- para páginas con su propio esquema de inputs (login/checkout). */
  outerClassName?: string
  prefixClassName?: string
  inputClassName?: string
  helperClassName?: string
  hideHelper?: boolean
  inputMode?: InputHTMLAttributes<HTMLInputElement>["inputMode"]
}) {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const displayValue = normalizeArgentineNationalPhone(value)

  useEffect(() => {
    // Autocorrección: si lo que llega por props no está ya en formato
    // canónico (ej.: un teléfono viejo guardado con "+54"/"0"/guiones), se
    // empuja la versión limpia hacia el estado del padre sin esperar a que
    // el usuario toque el campo -- así Mi Cuenta/Checkout siempre terminan
    // guardando el canónico, incluso si el usuario nunca edita el valor
    // precargado.
    if (value && displayValue !== value) {
      onChange(displayValue)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  return (
    <div className={cn("space-y-1", className)}>
      {label && (
        <label
          htmlFor={inputId}
          className={
            labelClassName ??
            "block text-11px font-semibold uppercase tracking-widest text-[var(--account-text-muted)]"
          }
        >
          {label}
        </label>
      )}
      <div
        className={cn(
          "flex items-stretch overflow-hidden rounded-xl transition-colors focus-within:ring-3 focus-within:ring-[var(--account-focus-ring)]",
          heightClassName,
          outerClassName ??
            cn(
              "border bg-[var(--account-input)]",
              error
                ? "border-[var(--account-danger-border)]"
                : "border-[var(--account-border)] focus-within:border-[var(--account-border-strong)] hover:border-[var(--account-border-strong)]",
            ),
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "flex shrink-0 select-none items-center justify-center border-r border-[var(--account-border)] px-3 text-sm font-semibold text-[var(--account-text-secondary)]",
            prefixClassName,
          )}
        >
          {ARGENTINA_PHONE_PREFIX}
        </span>
        <input
          id={inputId}
          name={name}
          type="tel"
          aria-label={label ?? "Teléfono"}
          required={required}
          disabled={disabled}
          value={displayValue}
          placeholder={placeholder}
          // OJO: no usar ARGENTINA_NATIONAL_PHONE_MAX_LENGTH acá -- el
          // maxLength nativo trunca los CARACTERES crudos tipeados/pegados
          // (incluye "+", espacios, guiones, paréntesis) antes de que
          // normalizeArgentineNationalPhone() pueda limpiarlos, así que un
          // pegado con símbolos + código de país nunca llegaba a sobrar lo
          // suficiente como para detectar y sacar el "54". El largo final ya
          // queda acotado dentro del normalizador (siempre corta a
          // ARGENTINA_NATIONAL_PHONE_MAX_LENGTH dígitos) -- este límite es
          // sólo un techo generoso contra pegados absurdamente largos.
          maxLength={32}
          inputMode={inputMode}
          autoComplete={autoComplete}
          onChange={(event) => onChange(normalizeArgentineNationalPhone(event.target.value))}
          className={cn(
            "min-w-0 flex-1 bg-transparent px-3 text-sm font-medium text-[var(--account-text-primary)] outline-none placeholder:text-[var(--account-text-muted)] disabled:cursor-not-allowed disabled:opacity-60",
            inputClassName,
          )}
        />
      </div>
      {!hideHelper && (
        <p
          className={
            helperClassName ?? "text-11px text-[var(--account-text-muted)]"
          }
        >
          Ejemplo: {placeholder} · No agregues el 0.
        </p>
      )}
      {error && <p className="text-xs text-[var(--account-danger-text)]">{error}</p>}
    </div>
  )
}
