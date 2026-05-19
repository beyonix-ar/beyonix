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
    <div className="space-y-5">

      {shortDescription && (
        <p className="text-[13.5px] leading-[1.8] text-white/65 font-normal">
          {shortDescription}
        </p>
      )}

      {longDescription && (
        <p className="text-[13px] leading-7 text-white/50">
          {longDescription}
        </p>
      )}

      {features.length > 0 && (
        <div className="space-y-1.5">
          {features.map((feature, index) => (
            <div
              key={`${feature.title}-${index}`}
              className="rounded-lg border border-white/[0.1] bg-white/[0.04] px-4 py-3 transition-colors hover:border-white/[0.15] hover:bg-white/[0.07]"
            >
              <p className="text-[12.5px] font-semibold text-white/90 leading-none mb-1">
                {feature.title}
              </p>
              <p className="text-[12px] leading-[1.6] text-white/55">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}