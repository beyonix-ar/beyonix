"use client"

import { PaymentMethodLogoTile } from "@/components/payments/payment-method-logo-tile"
import {
  MERCADOPAGO_CASH_MEDIA_DISCLAIMER,
  MERCADOPAGO_CASH_MEDIA_GROUPS,
} from "@/lib/payments/mercadopago-cash-media"
import { getCheckoutCashLogoGroups } from "@/lib/payments/payment-method-logos"
import { usePaymentMethodLogos } from "@/lib/payments/use-payment-method-logos"

/**
 * Contenido de "Mercado Pago en 1 pago → Ver medios". Con logos cargados en
 * Admin y disponibles según Mercado Pago, se muestran esos logos agrupados;
 * si todavía no hay ninguno, la referencia en texto (nunca bancos emisores ni
 * logos inventados).
 */
export function MercadoPagoCashMedia() {
  const logoGroups = getCheckoutCashLogoGroups(usePaymentMethodLogos() ?? [])

  return (
    <div data-mercadopago-cash-media data-media-source={logoGroups.length ? "mercadopago" : "reference"}>
      <p className="beyonix-modal-body text-[13px] font-semibold text-white/80">Podés pagar con:</p>
      <div className="mt-2 space-y-2.5">
        {logoGroups.length
          ? logoGroups.map((group) => (
              <section key={group.id} aria-label={group.label} data-media-group={group.id}>
                <h3 className="beyonix-modal-muted text-[10px] font-bold uppercase tracking-[0.12em] text-white/55">
                  {group.label}
                </h3>
                <ul className="mt-1.5 flex flex-wrap gap-1.5">
                  {group.logos.map((logo) => (
                    <li key={logo.key} className="flex">
                      <PaymentMethodLogoTile name={logo.name} imageUrl={logo.imageUrl} />
                    </li>
                  ))}
                </ul>
              </section>
            ))
          : MERCADOPAGO_CASH_MEDIA_GROUPS.map((group) => (
              <section key={group.id} aria-label={group.label} data-media-group={group.id}>
                <h3 className="beyonix-modal-muted text-[10px] font-bold uppercase tracking-[0.12em] text-white/55">
                  {group.label}
                </h3>
                <ul className="mt-1.5 flex flex-wrap gap-1.5">
                  {group.items.map((item) => (
                    <li
                      key={item}
                      className="rounded-md border border-[var(--account-border)] bg-[var(--account-surface-raised)] px-2 py-1 text-[12px] font-semibold leading-4 text-[var(--account-text-primary)]"
                    >
                      {item}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
      </div>
      <p className="beyonix-modal-muted mt-3 text-[11px] leading-4 text-white/55">
        {MERCADOPAGO_CASH_MEDIA_DISCLAIMER}
      </p>
    </div>
  )
}
