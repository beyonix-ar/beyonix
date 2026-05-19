import { ProductItem } from "@/components/products/product-details"

function buildSequenceImages(basePath: string, filePrefix: string, total: number) {
  return Array.from({ length: total }, (_, i) => {
    const number = String(i + 1).padStart(2, "0")
    return `${basePath}/${filePrefix}-${number}.png`
  })
}

export const auricularC2237: ProductItem = {
  id: 1,
  slug: "auriculares-bluetooth-c2237",
  featured: true,
  name: "Auriculares Bluetooth C-2237",
  category: "Audio",
  categorySlug: "audio-conectividad",
  price: 15700,
  originalPrice: 24900,

  colors: [
    {
      name: "Negro",
      value: "negro",
      images: buildSequenceImages(
        "/images/products/audioyconectividad/auriculares/auricularc-2237/negro",
        "AUCN01",
        3
      ),
    },
    {
      name: "Rosa",
      value: "rosaSalmon",
      images: buildSequenceImages(
        "/images/products/audioyconectividad/auriculares/auricularc-2237/rosa",
        "AUCR01",
        3
      ),
    },
    {
      name: "Verde",
      value: "verdeSage",
      images: buildSequenceImages(
        "/images/products/audioyconectividad/auriculares/auricularc-2237/verde",
        "AUCV01",
        3
      ),
    },
  ],

  details: {
    shortDescription:
      "Auriculares Bluetooth C-2237 con diseño moderno, sonido envolvente y máxima comodidad para el uso diario.",

    longDescription:
      "Auriculares inalámbricos diseñados para ofrecer una experiencia de sonido envolvente con excelente comodidad. Ideales para uso diario, trabajo, estudio o entretenimiento. Su conectividad Bluetooth asegura una conexión estable y rápida con múltiples dispositivos, mientras que su diseño ergonómico permite utilizarlos durante largas jornadas sin molestias.",

    features: [
      {
        title: "Bluetooth estable",
        description: "Conexión rápida y sin cortes.",
      },
      {
        title: "Diseño cómodo",
        description: "Vincha acolchada y almohadillas suaves.",
      },
      {
        title: "Sonido equilibrado",
        description: "Audio claro con graves definidos.",
      },
    ],

    specifications: [
      { label: "Versión Bluetooth", value: "5.0" },
      { label: "Autonomía", value: "6 horas" },
      { label: "Tiempo de carga", value: "2 horas" },
      { label: "Conector de carga", value: "USB-C" },
      { label: "Alcance", value: "10 metros" },
      { label: "Compatibilidad", value: "Android / iOS / PC" },
    ],
  },
}