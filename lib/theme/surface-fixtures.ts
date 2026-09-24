// Marcado de referencia para los tests visuales del sistema de superficies
// (lib/theme/surface-hierarchy.browser.test.tsx). Replica las clases reales
// de cada zona; el test verifica contra el código fuente que existan.

export const TAILWIND_SHIM = `
*, ::before, ::after { box-sizing: border-box; border-width: 0; border-style: solid; }
body { margin: 0; font-family: sans-serif; }
.rounded-xl { border-radius: .75rem; } .rounded-2xl { border-radius: 1rem; } .rounded-lg { border-radius: .5rem; }
.border { border-width: 1px; } .p-4 { padding: 1rem; } .p-3 { padding: .75rem; } .p-2 { padding: .5rem; }
.grid { display: grid; } .gap-3 { gap: .75rem; }
/* Utilidades arbitrarias tal como las emite Tailwind v4 (@theme inline). */
.bg-\\[\\#05070A\\] { background-color: #05070A; }
.bg-\\[\\#070C12\\] { background-color: #070C12; }
.bg-\\[\\#111820\\] { background-color: #111820; }
.bg-\\[\\#10151C\\] { background-color: #10151C; }
.bg-card { background-color: var(--card); }
.bg-beyonix-surface { background-color: var(--beyonix-surface-base); }
.bg-beyonix-page { background-color: var(--beyonix-page-background); }
.bg-beyonix-surface-3 { background-color: var(--beyonix-surface-interactive); }
.bg-\\[var\\(--account-surface\\)\\] { background-color: var(--account-surface); }
.bg-\\[var\\(--account-surface-raised\\)\\] { background-color: var(--account-surface-raised); }
.bg-\\[var\\(--account-input\\)\\] { background-color: var(--account-input); }
.border-\\[var\\(--account-border\\)\\] { border-color: var(--account-border); }
.border-\\[var\\(--account-border-subtle\\)\\] { border-color: var(--account-border-subtle); }
`

export interface SurfaceProbe {
  selector: string
  role: "page" | "section" | "card" | "raised" | "field"
}

export interface SurfaceFixture {
  name: string
  theme: "admin" | "account"
  markup: string
  probes: SurfaceProbe[]
}

// Admin: módulo (AdminSection) > card (AdminCard) > control; y un
// contenedor "legacy" [rounded][border] con otro anidado, sin clases
// semánticas, para comprobar que el mecanismo previo también usa los tokens.
const adminBase = `
<div class="beyonix-admin-shell">
  <main class="beyonix-admin-main" data-page>
    <div>
      <section class="admin-ds-card admin-ds-surface bx-surface bx-surface-section p-4" data-section>
        <div class="admin-ds-card admin-ds-surface bx-surface bx-surface-card p-4" data-card>
          <input class="admin-control-input admin-ds-control" data-field value="Ñandú" />
        </div>
      </section>
      <div class="rounded-xl border p-4" data-legacy-section>
        <div class="rounded-lg border p-3" data-legacy-card>Detalle</div>
      </div>
    </div>
  </main>
</div>`

// Detalle de pedido > Atención al cliente > Recepción del producto original.
const adminClaims = `
<div class="beyonix-admin-shell">
  <main class="beyonix-admin-main" data-page>
    <div>
      <div class="admin-order-detail-scope bx-surface bx-surface-section rounded-xl border bg-[#05070A]" data-order-module>
        <div class="bx-surface-inherit bg-[#05070A] p-3" data-order-body>
          <section class="admin-claim-manager admin-ds-surface bx-surface bx-surface-card" data-claims>
            <section class="admin-claim-card admin-claim-reception-panel bx-surface bx-surface-section p-4" data-reception>
              <div class="admin-claim-stepper-track" data-stepper>Pasos</div>
              <article class="admin-claim-reception-item" data-product>
                <button type="button" aria-pressed="false" class="admin-claim-choice admin-claim-flow-control is-restock" data-tile>Volver al stock</button>
                <textarea class="admin-claim-note" data-note></textarea>
              </article>
            </section>
          </section>
        </div>
      </div>
    </div>
  </main>
</div>`

const accountPage = `
<div data-account-page class="p-4" style="background: var(--account-background)">
  <div class="rounded-2xl border border-[var(--account-border)] bg-[var(--account-surface)] p-4" data-account-panel>
    <div class="rounded-2xl border border-[var(--account-border-subtle)] bg-[var(--account-surface-raised)] p-3" data-account-item>
      <input class="bg-[var(--account-input)]" data-account-input />
    </div>
  </div>
</div>`

// Checkout real: panel (checkoutFormPanelClassName) > opción de pago
// (checkoutOptionClassName) > campo. Sin clases bx-*: usa sus clases propias.
const checkout = `
<main class="checkout-page p-4" data-checkout-page>
  <section class="checkout-panel checkout-form-panel relative overflow-hidden rounded-xl border border-[#112A43] bg-[#070C12]" data-checkout-panel>
    <label class="checkout-option flex w-full cursor-pointer rounded-lg border border-beyonix-blue-light/16 bg-[#10151C] text-left checkout-choice items-start gap-3 p-4" data-checkout-card>Mercado Pago</label>
    <input class="beyonix-checkout-input" data-checkout-input />
  </section>
</main>`

// Catálogo y carrito reales: card de producto (category-product-card.tsx),
// ítem y resumen del carrito (cart-item.tsx / cart-summary.tsx) dentro del
// panel del carrito (bg-beyonix-surface).
const catalog = `
<div class="bg-beyonix-page p-4" data-catalog-page>
  <article class="bx-surface bx-surface-raised relative z-10 flex h-full min-h-screen-small flex-col rounded-lg border border-border bg-card transition-all duration-500 hover:border-muted-foreground/30" data-product-card>
    <div class="bx-surface bx-surface-raised flex flex-1 flex-col bg-beyonix-surface-3 px-4 pb-4 pt-3.5" data-product-body>Auricular Ñandú</div>
  </article>
  <aside class="beyonix-cart-drawer bg-beyonix-surface p-4" data-cart-panel>
    <div class="beyonix-cart-item bx-surface bx-surface-card relative flex gap-3 rounded-xl border border-white/10 bg-beyonix-surface-3 p-2 shadow-sm shadow-black/30" data-cart-item>Item del carrito</div>
  </aside>
</div>`

export const SURFACE_FIXTURES: SurfaceFixture[] = [
  {
    name: "admin-base",
    theme: "admin",
    markup: adminBase,
    probes: [
      { selector: "[data-page]", role: "page" },
      { selector: "[data-section]", role: "section" },
      { selector: "[data-card]", role: "card" },
      { selector: "[data-field]", role: "field" },
      { selector: "[data-legacy-section]", role: "section" },
      { selector: "[data-legacy-card]", role: "card" },
    ],
  },
  {
    name: "admin-claims",
    theme: "admin",
    markup: adminClaims,
    probes: [
      { selector: "[data-page]", role: "page" },
      { selector: "[data-order-module]", role: "section" },
      { selector: "[data-claims]", role: "card" },
      { selector: "[data-reception]", role: "section" },
      { selector: "[data-stepper]", role: "card" },
      { selector: "[data-product]", role: "card" },
      { selector: "[data-tile]", role: "raised" },
      { selector: "[data-note]", role: "field" },
    ],
  },
  {
    name: "account",
    theme: "account",
    markup: accountPage,
    probes: [
      { selector: "[data-account-page]", role: "page" },
      { selector: "[data-account-panel]", role: "section" },
      { selector: "[data-account-item]", role: "card" },
      { selector: "[data-account-input]", role: "field" },
    ],
  },
  {
    name: "checkout",
    theme: "account",
    markup: checkout,
    probes: [
      { selector: "[data-checkout-page]", role: "page" },
      { selector: "[data-checkout-panel]", role: "section" },
      { selector: "[data-checkout-card]", role: "card" },
      { selector: "[data-checkout-input]", role: "field" },
    ],
  },
  {
    name: "catalog",
    theme: "account",
    markup: catalog,
    probes: [
      { selector: "[data-catalog-page]", role: "page" },
      { selector: "[data-product-card]", role: "raised" },
      { selector: "[data-product-body]", role: "raised" },
      { selector: "[data-cart-panel]", role: "section" },
      { selector: "[data-cart-item]", role: "card" },
    ],
  },
]
