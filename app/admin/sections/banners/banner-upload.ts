import { supabase } from "@/lib/supabase/client"
import {
  BANNER_MAX_FILE_BYTES,
  BANNER_MIME_EXTENSIONS,
  BANNER_STORAGE_BUCKET,
  BANNER_FORMATS_LABEL,
  detectBannerImageMime,
  isBannerMimeAllowed,
} from "@/lib/banners/site-banners"

/** Selector de archivos por ubicación (la firma real se vuelve a validar al subir y en la API). */
export const BANNER_FILE_ACCEPT: Record<"home" | "products", string> = {
  home: "image/jpeg,image/png,image/webp,image/avif",
  products: "image/jpeg,image/png,image/webp,image/avif,image/gif",
}

export type BannerUploadResult =
  | { ok: true; url: string; width: number | null; height: number | null }
  | { ok: false; error: string }

function cleanFileName(fileName: string) {
  return fileName
    .replace(/\.[^.]+$/, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase()
    .slice(0, 80) || "banner"
}

async function imageSize(file: File) {
  try {
    const bitmap = await createImageBitmap(file)
    const size = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return size
  } catch {
    return { width: null, height: null }
  }
}

/**
 * Sube una imagen al bucket público de banners. Antes de subir valida el
 * tamaño y el tipo REAL (firma del archivo; Home: JPG, PNG, WebP o AVIF;
 * Productos además GIF; nunca SVG); el bucket y la API lo vuelven a exigir.
 * La extensión sale del tipo real.
 */
export async function uploadBannerImage(file: File, folder: string, placement: "home" | "products"): Promise<BannerUploadResult> {
  if (file.size > BANNER_MAX_FILE_BYTES) return { ok: false, error: "La imagen supera los 5 MB." }
  const mime = detectBannerImageMime(new Uint8Array(await file.slice(0, 64).arrayBuffer()))
  if (!mime || !isBannerMimeAllowed(mime, placement)) return { ok: false, error: `Formato no admitido. Usá ${BANNER_FORMATS_LABEL[placement]}.` }

  const path = `${folder}/${Date.now()}-${cleanFileName(file.name)}.${BANNER_MIME_EXTENSIONS[mime]}`
  const { error } = await supabase.storage.from(BANNER_STORAGE_BUCKET).upload(path, file, {
    cacheControl: "3600",
    contentType: mime,
    upsert: false,
  })
  if (error) return { ok: false, error: "No se pudo subir la imagen. Intentá de nuevo." }

  const { data } = supabase.storage.from(BANNER_STORAGE_BUCKET).getPublicUrl(path)
  return { ok: true, url: data.publicUrl, ...(await imageSize(file)) }
}
