import { ProductItem } from "@/components/products/product-details"

function buildSequenceImages(basePath: string, filePrefix: string, total: number) {
  return Array.from({ length: total }, (_, i) => {
    const number = String(i + 1).padStart(2, "0")
    return `${basePath}/${filePrefix}-${number}.png`
  })
}

export const apoyabrazosEscritorio: ProductItem = {
  id: 8,
  slug: "apoyabrazos-escritorio-ergonomico",
  featured: true,
  name: "Apoyabrazos Ergonómico para Escritorio",
  category: "Setup y escritorio",
  categorySlug: "setup-escritorio",
  price: 18900,
  originalPrice: 24900,

  colors: [
    {
      name: "Negro",
      value: "negro",
      images: buildSequenceImages(
        "/images/products/setupyescritorio/apoyabrazos",
        "AP01",
        3
      ),
    },
  ],

  details: {
    shortDescription:
      "Apoyabrazos ergonómico para escritorio que reduce la tensión en muñeca y hombro durante largas jornadas.",

    longDescription:
      "Diseñado para mejorar la postura y brindar mayor comodidad al trabajar o usar la computadora, este apoyabrazos ergonómico se adapta fácilmente a distintos escritorios. Ideal para oficina, home office o gaming, ayuda a reducir la fatiga muscular y prevenir molestias en el brazo y la muñeca.",

    features: [
      {
        title: "Diseño ergonómico",
        description: "Reduce la tensión en brazo, hombro y muñeca.",
      },
      {
        title: "Fácil instalación",
        description: "Se ajusta rápidamente a la mayoría de escritorios.",
      },
      {
        title: "Material resistente",
        description: "Construcción sólida y duradera para uso diario.",
      },
    ],

    specifications: [
      { label: "Material", value: "Metal con plástico reforzado" },
      { label: "Compatibilidad", value: "Escritorios estándar" },
      { label: "Instalación", value: "Ajuste con abrazadera" },
      { label: "Uso", value: "Oficina / Gaming / Estudio" },
      { label: "Color", value: "Negro" },
    ],
  },
}