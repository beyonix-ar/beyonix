"use client"

import type { ReactNode } from "react"
import { Check, CreditCard, Landmark, Wallet, type LucideIcon } from "lucide-react"

import { PaymentMethodLogoTile } from "@/components/payments/payment-method-logo-tile"
import {
  MERCADOPAGO_CASH_MEDIA_DISCLAIMER,
  MERCADOPAGO_CASH_MEDIA_GROUPS,
} from "@/lib/payments/mercadopago-cash-media"
import {
  findCreditLogo,
  getCheckoutCashLogoGroups,
  type PublicPaymentMethodLogo,
} from "@/lib/payments/payment-method-logos"
import { usePaymentMethodLogos } from "@/lib/payments/use-payment-method-logos"
import { cn } from "@/lib/utils"

export type CheckoutPaymentOption = "transferencia" | "mercadopago_cash" | "mercadopago_installments"

export const checkoutOptionClassName =
  "checkout-option flex w-full cursor-pointer rounded-lg border border-beyonix-blue-light/16 bg-[#10151C] text-left transition-all hover:border-beyonix-blue-light/55 hover:bg-[#112A43]/38 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-beyonix-blue-light/22"

export const checkoutOptionSelectedClassName =
  "checkout-option-selected border-beyonix-blue-light/70 bg-[#112A43] shadow-[inset_0_1px_0_rgba(255,255,255,0.045),0_0_0_1px_rgba(79,131,173,0.18)]"

export function CheckoutPaymentOptionCard({
  option,
  checked,
  onSelect,
  icon: Icon,
  title,
  description,
  badge,
  highlight,
  amountLabel,
  amount,
  disabled = false,
}: {
  option: CheckoutPaymentOption
  checked: boolean
  onSelect: (option: CheckoutPaymentOption) => void
  icon: LucideIcon
  title: string
  description: string
  badge?: ReactNode
  highlight?: ReactNode
  amountLabel?: string
  amount?: string
  disabled?: boolean
}) {
  return (
    <label
      data-payment-option={option}
      data-disabled={disabled ? "true" : undefined}
      aria-disabled={disabled || undefined}
      className={cn(
        checkoutOptionClassName,
        "checkout-choice items-start gap-2.5 px-3 py-2.5 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-beyonix-blue-light/40",
        checked && checkoutOptionSelectedClassName,
        disabled && "cursor-not-allowed",
      )}
    >
      <input
        type="radio"
        name="checkout-payment-option"
        value={option}
        checked={checked}
        disabled={disabled}
        onChange={() => onSelect(option)}
        className="sr-only"
      />
      <span className="mt-0.5"><CheckoutRadioIndicator checked={checked} /></span>
      <span className="checkout-choice-icon flex size-8 shrink-0 items-center justify-center rounded-lg bg-black/35 text-white/65">
        <Icon aria-hidden="true" className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-semibold text-white">{title}</span>
          {badge}
        </span>
        <span className="mt-0.5 block text-sm text-white/55">{description}</span>
        {highlight && <span className="mt-0.5 block text-sm text-white/55">{highlight}</span>}
      </span>
      {amount ? (
        <span className="checkout-choice-total ml-auto shrink-0 text-right">
          <span className="block text-11px text-white/55">{amountLabel}</span>
          <strong className="block text-sm tabular-nums text-white">{amount}</strong>
        </span>
      ) : null}
    </label>
  )
}

function CheckoutRadioIndicator({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      data-checked={checked ? "true" : "false"}
      className={cn(
        "checkout-choice-radio flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
        checked
          ? "border-[var(--checkout-choice-indicator)] bg-[var(--checkout-choice-indicator)]"
          : "border-[var(--checkout-choice-indicator-idle)]",
      )}
    >
      {checked && <Check strokeWidth={3.5} className="checkout-choice-radio-check size-3 text-[var(--checkout-choice-indicator-dot)]" />}
    </span>
  )
}

const INSTALLMENT_BRANDS: Record<string, string> = {
  visa: "Visa",
  master: "Mastercard",
}

/** Marca como texto (sin logo inventado) o con el logo cargado en Admin. */
function MediaBrand({ name, logo = null, confirmed = false }: { name: string; logo?: PublicPaymentMethodLogo | null; confirmed?: boolean }) {
  const label = name === "Naranja" ? "Naranja X" : name

  return (
    <li className="checkout-media-brand" data-media-brand={name} data-confirmed={confirmed || undefined} data-has-logo={logo ? "true" : undefined}>
      {logo ? <PaymentMethodLogoTile name={logo.name} imageUrl={logo.imageUrl} nameFallback={false} /> : null}
      <span>{label}</span>
    </li>
  )
}

const PANEL_TITLES: Record<CheckoutPaymentOption, string> = {
  transferencia: "Transferencia bancaria",
  mercadopago_cash: "Mercado Pago · 1 pago",
  mercadopago_installments: "Mercado Pago · Cuotas sin interés",
}

export function CheckoutPaymentMediaPanel({
  option,
  installmentBrands,
  transferDiscountPercent,
}: {
  option: CheckoutPaymentOption | null
  installmentBrands: readonly string[]
  /** Descuento vigente de la tienda (siteSettings.pricing), el mismo que usa el total. */
  transferDiscountPercent: number
}) {
  const confirmedBrands = installmentBrands.filter((brand) => brand === "visa" || brand === "master")
  const logos = usePaymentMethodLogos() ?? []
  const cashLogoGroups = getCheckoutCashLogoGroups(logos)
  const transferDiscount = Number.isFinite(transferDiscountPercent) && transferDiscountPercent > 0
    ? transferDiscountPercent.toLocaleString("es-AR", { maximumFractionDigits: 2 })
    : null

  return (
    <aside className="checkout-payment-media" data-payment-media={option ?? "none"} aria-label="Medios de pago">
      <div className="checkout-payment-media-heading">
        <p className="checkout-payment-media-kicker">Medios de pago</p>
        {option ? <h3>{PANEL_TITLES[option]}</h3> : null}
      </div>

      {option === "transferencia" ? (
        <div className="checkout-payment-media-content" data-media-transfer>
          {transferDiscount ? (
            <div className="checkout-payment-media-benefit" data-transfer-benefit>
              <p className="checkout-payment-media-benefit-value">{transferDiscount}% DE DESCUENTO</p>
              <p className="checkout-payment-media-benefit-text">
                Pagando por transferencia tenés {transferDiscount}% OFF sobre los productos.
              </p>
            </div>
          ) : null}
          <ul className="checkout-payment-media-points">
            <li><Landmark aria-hidden="true" className="size-4 shrink-0" />Los datos bancarios se muestran después de confirmar el pedido.</li>
            <li><Wallet aria-hidden="true" className="size-4 shrink-0" />Podés transferir desde una cuenta bancaria o billetera virtual.</li>
          </ul>
        </div>
      ) : option === "mercadopago_installments" ? (
        <div className="checkout-payment-media-content" data-media-installments>
          <p className="checkout-payment-media-title">Tarjetas de crédito con cuotas confirmadas</p>
          {confirmedBrands.length > 0 ? (
            <ul className="checkout-payment-media-brands" aria-label="Tarjetas con cuotas sin interés confirmadas">
              {confirmedBrands.map((brand) => (
                <MediaBrand key={brand} name={INSTALLMENT_BRANDS[brand]} logo={findCreditLogo(logos, brand)} confirmed />
              ))}
            </ul>
          ) : (
            <p className="checkout-payment-media-muted">Mercado Pago todavía no confirmó tarjetas para este total.</p>
          )}
          <p className="checkout-payment-media-note">La cantidad de cuotas se elige en Mercado Pago.</p>
        </div>
      ) : option === "mercadopago_cash" ? (
        <div className="checkout-payment-media-content" data-media-cash data-media-source={cashLogoGroups.length ? "mercadopago" : "reference"}>
          {cashLogoGroups.length ? (
            // Logos cargados en Admin y disponibles hoy según Mercado Pago.
            cashLogoGroups.map((group) => (
              <section key={group.id} className="checkout-payment-media-group" data-media-group={group.id}>
                <h4>{group.label}</h4>
                <ul className="checkout-payment-media-logos">
                  {group.logos.map((logo) => (
                    <li key={logo.key} data-media-logo={logo.providerMethodId ?? logo.key}>
                      <PaymentMethodLogoTile name={logo.name} imageUrl={logo.imageUrl} size="md" />
                    </li>
                  ))}
                </ul>
              </section>
            ))
          ) : (
            MERCADOPAGO_CASH_MEDIA_GROUPS.map((group) => (
              <section key={group.id} className="checkout-payment-media-group" data-media-group={group.id}>
                <h4>{group.label}</h4>
                {group.id === "mercadopago" ? (
                  <div className="checkout-payment-media-wallet">
                    <span>Dinero disponible en tu cuenta</span>
                  </div>
                ) : (
                  <ul className="checkout-payment-media-brands">
                    {group.items.map((name) => <MediaBrand key={name} name={name} />)}
                  </ul>
                )}
              </section>
            ))
          )}
          <p className="checkout-payment-media-note">Y más medios de pago disponibles en Mercado Pago.</p>
          <p className="checkout-payment-media-muted">{MERCADOPAGO_CASH_MEDIA_DISCLAIMER}</p>
        </div>
      ) : (
        <div className="checkout-payment-media-empty" data-media-empty>
          <span className="checkout-payment-media-empty-icon"><CreditCard aria-hidden="true" className="size-5" /></span>
          <p className="checkout-payment-media-empty-title">
            Seleccioná un método de pago <span>y descubrí sus beneficios</span>
          </p>
          <p className="checkout-payment-media-empty-text">
            Elegí una opción para ver los medios disponibles, descuentos y condiciones.
          </p>
        </div>
      )}
    </aside>
  )
}
