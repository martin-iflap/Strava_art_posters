/** Rasterise an SVG string to a PNG blob at its width/height attributes. Uses only blob: URLs (allowed by the CSP). */
export async function svgToPng(svg: string, width: number, height: number): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    img.width = width;
    img.height = height;
    await new Promise<void>((ok, err) => { img.onload = () => ok(); img.onerror = () => err(new Error('Could not render the poster')); img.src = url; });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas is not available');
    ctx.drawImage(img, 0, 0, width, height);
    return await new Promise<Blob>((ok, err) => canvas.toBlob((b) => (b ? ok(b) : err(new Error('PNG encoding failed'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}
