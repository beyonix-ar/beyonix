export interface ProductVariant {
  name: string
  value: string
  images: string[]
}

export interface ProductFeature {
  title: string
  description: string
}

export interface ProductSpecification {
  label: string
  value: string
}

export interface ProductDetails {
  shortDescription: string
  longDescription: string
  features: ProductFeature[]
  specifications: ProductSpecification[]
}

export interface StoreProduct {
  id: number
  slug: string
  featured?: boolean
  name: string
  category: string
  categorySlug: string
  price: number
  originalPrice?: number
  colors: ProductVariant[]
  details?: ProductDetails
}