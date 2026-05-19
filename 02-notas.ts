/*
🛍️ PRODUCTOS Y PRECIOS BASE
- components/products-section.tsx

================================

🚚 ENVIOS
CONFIG GENERAL:
- lib/store-config.ts

LÓGICA DE ENVÍO (CARRITO):
- components/cart/cart-summary.tsx  // ✅ FREE_SHIPPING_MIN + cálculo dinámico

CHECKOUT:
- app/checkout/page.tsx

MERCADO PAGO BACKEND:
- app/api/create-preference/route.ts

================================

🛒 CARRITO (NUEVA ESTRUCTURA)
- context/cart-context.tsx        // estado global
- components/cart/cart-wrapper.tsx // conexión global
- components/cart/cart-drawer.tsx  // UI contenedor
- components/cart/cart-item.tsx    // items
- components/cart/cart-summary.tsx // totales + envío

================================

💳 DESCUENTO TRANSFERENCIA
CONFIG:
- lib/store-config.ts

CHECKOUT:
- app/checkout/page.tsx

BACKEND MP:
- app/api/create-preference/route.ts

================================

🎁 CAMPAÑAS FUTURAS
ACTIVAR / DESACTIVAR EVENTOS:
- lib/store-config.ts
  ACTIVE_SALE_EVENT = "cyber"

DESCUENTOS POR ID:
- lib/store-config.ts
  SALE_EVENTS

================================

🎯 NOTAS IMPORTANTES

- El carrito ahora usa:
  productId + color (NO index)

- El envío:
  se calcula automáticamente en cart-summary

- No usar:
  shipping manual ni total manual

- CartWrapper está montado globalmente en layout

*/