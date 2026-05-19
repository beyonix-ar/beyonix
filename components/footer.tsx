"use client"

import { useState } from "react"
import { Instagram, Mail, MapPin, Phone } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

const footerLinks = {
  tienda: [
    { id: "productos", label: "Audio y accesorios" },
    { id: "productos", label: "Celulares y soportes" },
    { id: "productos", label: "Iluminación LED" },
    { id: "productos", label: "Hogar inteligente" },
    { id: "productos", label: "Mate y comodidad" },
  ],
  info: [
    { id: "inicio", label: "Sobre nosotros" },
    { id: "contacto", label: "Contacto" },
    { id: "beneficios", label: "Envíos y entregas" },
    { id: "beneficios", label: "Devoluciones" },
    { id: "beneficios", label: "Preguntas frecuentes" },
  ],
}

export function Footer() {
  const [email, setEmail] = useState("")

  const scrollToSection = (id: string) => {
    const element = document.getElementById(id)
    if (element) {
      element.scrollIntoView({ behavior: "smooth" })
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    // Handle newsletter signup
    setEmail("")
    alert("¡Gracias por suscribirte!")
  }

  return (
    <footer className="bg-card border-t border-border">
      <div className="container mx-auto px-4 lg:px-8 py-12 lg:py-16">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8 lg:gap-12">
          {/* Brand */}
          <div className="sm:col-span-2 lg:col-span-1">
            <button onClick={() => scrollToSection("inicio")} className="inline-block mb-4">
              <span className="text-2xl font-bold tracking-tight text-foreground">
                BEYONIX
              </span>
            </button>
            <p className="text-sm text-muted-foreground mb-6 max-w-xs">
              Tecnología para tu comodidad. Productos premium para mejorar tu día a día.
            </p>
            
            {/* Social */}
            <div className="flex gap-3">
              <a
                href="https://instagram.com/beyonix.ar"
                target="_blank"
                rel="noopener noreferrer"
                className="size-10 rounded-full bg-secondary flex items-center justify-center text-foreground hover:bg-accent transition-colors"
                aria-label="Instagram"
              >
                <Instagram className="size-4" />
              </a>
              <a
                href="mailto:hola@beyonix.com.ar"
                className="size-10 rounded-full bg-secondary flex items-center justify-center text-foreground hover:bg-accent transition-colors"
                aria-label="Email"
              >
                <Mail className="size-4" />
              </a>
            </div>
          </div>

          {/* Tienda Links */}
          <div>
            <h3 className="font-semibold text-foreground mb-4">Tienda</h3>
            <ul className="space-y-3">
              {footerLinks.tienda.map((link, index) => (
                <li key={`tienda-${index}`}>
                  <button
                    onClick={() => scrollToSection(link.id)}
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors text-left"
                  >
                    {link.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {/* Info Links */}
          <div>
            <h3 className="font-semibold text-foreground mb-4">Información</h3>
            <ul className="space-y-3">
              {footerLinks.info.map((link, index) => (
                <li key={`info-${index}`}>
                  <button
                    onClick={() => scrollToSection(link.id)}
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors text-left"
                  >
                    {link.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {/* Newsletter */}
          <div>
            <h3 className="font-semibold text-foreground mb-4">Newsletter</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Suscribite para recibir ofertas exclusivas y novedades.
            </p>
            <form onSubmit={handleSubmit} className="flex gap-2">
              <Input
                type="email"
                placeholder="tu@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="flex-1"
              />
              <Button type="submit">OK</Button>
            </form>

            {/* Contact Info */}
            <div className="mt-6 space-y-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Phone className="size-4" />
                <span>+54 341 2626 527</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <MapPin className="size-4" />
                <span>Rosario, Santa Fe</span>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Bar */}
        <div className="mt-12 pt-8 border-t border-border flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            © {new Date().getFullYear()} BEYONIX. Todos los derechos reservados.
          </p>
          <div className="flex gap-4">
            <span className="text-sm text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
              Términos y condiciones
            </span>
            <span className="text-sm text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
              Política de privacidad
            </span>
          </div>
        </div>
      </div>
    </footer>
  )
}
