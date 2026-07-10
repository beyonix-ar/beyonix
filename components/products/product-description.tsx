"use client"

import { ProductFeature } from "./product-details"

interface ProductDescriptionProps {
  shortDescription: string
  longDescription: string
  features: ProductFeature[]
}

export function ProductDescription({
  shortDescription,
  longDescription,
  features,
}: ProductDescriptionProps) {
  return (
    <div>

      {shortDescription && (
        <p className="text-15px font-normal leading-7 text-white/80">
          {shortDescription}
        </p>
      )}

      {longDescription && (
        <p className="text-14px leading-7 text-white/68">
          {longDescription}
        </p>
      )}

      {features.length > 0 && (
        <div className="space-y-1.5">
          {features.map((feature, index) => (
            <div
              key={`${feature.title}-${index}`}
              className="rounded-lg border border-beyonix-blue-light/16 bg-white/5 px-4 py-3 transition-colors hover:border-beyonix-blue-light/28 hover:bg-white/8"
            >
              <p className="mb-1 text-13px font-semibold leading-none text-white/92">
                {feature.title}
              </p>
              <p className="text-12px leading-5 text-white/70">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
