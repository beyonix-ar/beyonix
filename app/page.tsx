import { HomeClient } from "@/components/home-client"
import { getHomeCampaign } from "@/lib/banners/home-campaign-server"
import { getFeaturedProduct } from "@/lib/supabase/queries/store-server"

export const revalidate = 60

export default async function HomePage() {
  const [featuredResult, homeCampaign] = await Promise.all([
    getFeaturedProduct().then(
      (product) => product,
      (error: unknown) => {
        console.error("Error cargando el producto destacado del Home:", error)
        return null
      },
    ),
    // Nunca lanza: sin lectura confiable, el Home sigue sin campaña.
    getHomeCampaign(),
  ])

  return (
    <main className="min-h-screen beyonix-home-bg">
      <HomeClient featuredProduct={featuredResult} homeCampaign={homeCampaign} />
    </main>
  )
}
