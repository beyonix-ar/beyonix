export interface ProductVariant {
  name: string
  value: string
  images: string[]
}

export interface ProductSpecification {
  label: string
  value: string
}

export interface ProductFeature {
  title: string
  description: string
}

export interface ProductDetailsContent {
  shortDescription: string
  longDescription: string
  features: ProductFeature[]
  specifications: ProductSpecification[]
}

export interface ProductItem {
  id: number
  name: string
  category: string
  price: number
  originalPrice?: number
  colors: ProductVariant[]
  slug: string
  categorySlug: string
  featured?: boolean
  details?: ProductDetailsContent
}

export interface ActiveProductDetails {
  product: ProductItem
  selectedColor: string
  selectedImage: number
}