type FreeShippingMode = "full" | "off"

export const SITE_SETTINGS = {
  shipping: {
    // Costo de envio base usado por la tienda.
    defaultShippingCost: 15000,

    // El cliente accede a una bonificacion parcial de envio desde este monto.
    // Cambia este valor para activar o ajustar el beneficio.
    freeShippingMinAmount: 75000,

    // "full" = bonificacion activa al superar freeShippingMinAmount.
    // "off" = nunca aplicar bonificacion automatica.
    freeShippingMode: "full" as FreeShippingMode,
  },

  stock: {
    // Hasta esta cantidad, el stock se considera critico y se muestra en rojo.
    criticalStockThreshold: 3,

    // Desde stock critico + 1 hasta esta cantidad, se considera stock bajo y se muestra en amarillo.
    lowStockThreshold: 6,
  },

  filters: {
    // Muestra u oculta el filtro "Cuotas sin interes" en /productos.
    showInstallmentsFilter: true,

    // Muestra u oculta el filtro "Destacados".
    showFeaturedFilter: true,

    // Muestra u oculta el filtro "En oferta".
    showOfferFilter: true,

    // Muestra u oculta el filtro de precio.
    showPriceFilter: true,

    // Muestra u oculta el filtro de categorias.
    showCategoryFilter: true,
  },
} as const
