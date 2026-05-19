import { ProductItem } from "@/components/products/product-details"

function buildSequenceImages(basePath: string, filePrefix: string, total: number) {
  return Array.from({ length: total }, (_, i) => {
    const number = String(i + 1).padStart(2, "0")
    return `${basePath}/${filePrefix}-${number}.png`
  })
}

export const auricularMalibu: ProductItem = {
  id: 3,
  slug: "auricular-bluetooth-malibu",
  featured: false,
  name: "Auricular Bluetooth Malibu",
  category: "Audio",
  categorySlug: "audio-conectividad",
  price: 36900,
  originalPrice: 42900,
  colors: [
    {
      name: "Negro",
      value: "negro",
      images: buildSequenceImages(
        "/images/products/audioyconectividad/auriculares/malibu/negro",
        "AUMN01",
        3
      ),
    },
    {
      name: "Rosa",
      value: "rosaSalmon",
      images: buildSequenceImages(
        "/images/products/audioyconectividad/auriculares/malibu/rosa",
        "AUMR01",
        3
      ),
    },
    {
      name: "Verde",
      value: "verdeAqua",
      images: buildSequenceImages(
        "/images/products/audioyconectividad/auriculares/malibu/verde",
        "AUMV01",
        3
      ),
    },
  ],
}