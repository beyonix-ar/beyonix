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
        <p className="text-14px font-normal leading-1-8 text-white/70">
          {shortDescription}
        </p>
      )}

      {longDescription && (
        <p className="text-13px leading-7 text-white/60">
          {longDescription}
        </p>
      )}

      {features.length > 0 && (
        <div className="space-y-1.5">
          {features.map((feature, index) => (
            <div
              key={`${feature.title}-${index}`}
              className="rounded-lg border border-white/10 bg-white/4 px-4 py-3 transition-colors hover:border-white/15 hover:bg-white/7"
            >
              <p className="text-12-5px font-semibold text-white/90 leading-none mb-1">
                {feature.title}
              </p>
              <p className="text-12px leading-1-6 text-white/65">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
