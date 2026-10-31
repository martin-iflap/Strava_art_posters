export type ImageKind = 'png' | 'jpeg';

export const IMAGE_KINDS: { id: ImageKind; label: string; mime: string; ext: string }[] = [
  { id: 'png', label: 'PNG', mime: 'image/png', ext: 'png' },
  { id: 'jpeg', label: 'JPEG', mime: 'image/jpeg', ext: 'jpg' },
];

/** JPEG quality: visually lossless for posters, roughly a third of the PNG size. */
const JPEG_QUALITY = 0.92;

/**
 * Rasterise an SVG string to a PNG or JPEG blob. Uses only blob: URLs (allowed by the CSP).
 * JPEG has no transparency, so the canvas is filled with `background` (the poster's paper colour) first.
 * Some browsers (notably Safari/iOS) refuse canvases above ~16.7 megapixels, so if the full-size
 * render fails it is retried at 75 % and 50 % of the size. The returned size says what was produced.
 */
export async function svgToImage(svg: string, width: number, height: number, kind: ImageKind = 'png', background = '#ffffff'): Promise<{ blob: Blob; width: number; height: number }> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  const mime = kind === 'jpeg' ? 'image/jpeg' : 'image/png';
  try {
    const img = new Image();
    img.width = width;
    img.height = height;
    await new Promise<void>((ok, err) => { img.onload = () => ok(); img.onerror = () => err(new Error('Could not render the poster')); img.src = url; });
    for (const scale of [1, 0.75, 0.5]) {
      const w = Math.round(width * scale), h = Math.round(height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      if (kind === 'jpeg') { ctx.fillStyle = background; ctx.fillRect(0, 0, w, h); }
      ctx.drawImage(img, 0, 0, w, h);
      const blob = await new Promise<Blob | null>((ok) => canvas.toBlob((b) => ok(b), mime, kind === 'jpeg' ? JPEG_QUALITY : undefined));
      if (blob && blob.size > 0 && blob.type === mime) return { blob, width: w, height: h };
    }
    throw new Error(`This browser could not create a ${kind.toUpperCase()} of that size. Try the SVG download or a smaller size.`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** PNG shorthand. */
export const svgToPng = (svg: string, width: number, height: number) => svgToImage(svg, width, height, 'png');
