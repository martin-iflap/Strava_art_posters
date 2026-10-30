/**
 * Rasterise an SVG string to a PNG blob. Uses only blob: URLs (allowed by the CSP).
 * Some browsers (notably Safari/iOS) refuse canvases above ~16.7 megapixels, so if the full-size
 * render fails it is retried at 75 % and 50 % of the size. The returned size says what was produced.
 */
export async function svgToPng(svg: string, width: number, height: number): Promise<{ blob: Blob; width: number; height: number }> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
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
      ctx.drawImage(img, 0, 0, w, h);
      const blob = await new Promise<Blob | null>((ok) => canvas.toBlob((b) => ok(b), 'image/png'));
      if (blob && blob.size > 0) return { blob, width: w, height: h };
    }
    throw new Error('This browser could not create a PNG of that size. Try the SVG download or a smaller size.');
  } finally {
    URL.revokeObjectURL(url);
  }
}
