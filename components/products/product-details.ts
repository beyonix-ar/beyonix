import type { SupabaseProducto } from "@/lib/supabase/types"

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

export interface ActiveProductDetails {
  product: SupabaseProducto
  selectedColor: string
  selectedImage: number
}