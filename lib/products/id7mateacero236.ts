import { ProductItem } from "@/components/products/product-details"

function buildSequenceImages(basePath: string, filePrefix: string, total: number) {
  return Array.from({ length: total }, (_, i) => {
    const number = String(i + 1).padStart(2, "0")
    return `${basePath}/${filePrefix}-${number}.png`
  })
}

export const mateAcero236ml: ProductItem = {
  id: 7,
  slug: "mate-acero-inoxidable-236ml",
  featured: true,
  name: "Mate de Acero Inoxidable 236ml",
  category: "Confort y bienestar",
  categorySlug: "confort-bienestar",
  price: 14900,
  originalPrice: 19900,

  colors: [
    {
      name: "Negro",
      value: "negro",
      images: buildSequenceImages(
        "/images/products/confortybienestar/mates/mate1/negro",
        "MTN01",
        3
      ),
    },
    {
      name: "Verde",
      value: "verdeOscuro",
      images: buildSequenceImages(
        "/images/products/confortybienestar/mates/mate1/verde",
        "MTV01",
        3
      ),
    },
    {
      name: "Rosa",
      value: "rosaSalmon",
      images: buildSequenceImages(
        "/images/products/confortybienestar/mates/mate1/rosa",
        "MTR01",
        3
      ),
    },
  ],
}