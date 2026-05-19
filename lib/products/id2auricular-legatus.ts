import { ProductItem } from "@/components/products/product-details"

function buildSequenceImages(basePath: string, filePrefix: string, total: number) {
  return Array.from({ length: total }, (_, i) => {
    const number = String(i + 1).padStart(2, "0")
    return `${basePath}/${filePrefix}-${number}.png`
  })
}

export const auricularLegatus: ProductItem = {
  id: 2,
  slug: "auricular-bluetooth-inalambrico-legatus",
  featured: true,
  name: "Auricular Inalámbrico Bluetooth Legatus",
  category: "Audio",
  categorySlug: "audio-conectividad",
  price: 22000,
  originalPrice: 29900,

  colors: [
    {
      name: "Azul",
      value: "azulLavanda",
      images: buildSequenceImages(
        "/images/products/audioyconectividad/auriculares/legatus/azul",
        "ALEGA01",
        3
      ),
    },
    {
      name: "Rosa",
      value: "rosaSalmon",
      images: buildSequenceImages(
        "/images/products/audioyconectividad/auriculares/legatus/rosa",
        "ALEGR01",
        3
      ),
    },
  ],

  details: {
    shortDescription:
      "Auricular inalámbrico Bluetooth Legatus con diseño moderno, cómodo y sonido claro para el uso diario.",

    longDescription:
      "El auricular Bluetooth Legatus combina comodidad, estilo y rendimiento. Diseñado para uso diario, ofrece una conexión estable, buena autonomía y un sonido equilibrado ideal para música, llamadas y contenido multimedia. Su estructura liviana y almohadillas suaves permiten utilizarlo durante largos períodos sin molestias.",

    features: [
      {
        title: "Conectividad Bluetooth",
        description: "Emparejamiento rápido y conexión estable.",
      },
      {
        title: "Diseño liviano",
        description: "Cómodo para uso prolongado sin fatiga.",
      },
      {
        title: "Sonido claro",
        description: "Buen balance entre graves y agudos.",
      },
    ],

    specifications: [
      { label: "Versión Bluetooth", value: "5.0" },
      { label: "Autonomía", value: "5-6 horas" },
      { label: "Tiempo de carga", value: "2 horas" },
      { label: "Puerto de carga", value: "USB-C" },
      { label: "Alcance", value: "10 metros" },
      { label: "Compatibilidad", value: "Android / iOS / PC" },
    ],
  },
}