import type { Metadata } from "next"
import { MobileBundleControl } from "./mobile-bundle-control"

export const metadata: Metadata = { title: "Control del Bulto" }

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <MobileBundleControl id={id} />
}
