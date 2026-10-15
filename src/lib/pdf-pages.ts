// Client-side only: turn a PDF into one JPEG per page, so a PDF infographic can be attached to a
// notice like any other picture. Rendering happens in the admin's browser; the server never parses PDFs.
const MAX_BYTES = 4 * 1024 * 1024;

export class PdfTooLong extends Error { constructor(public pages: number) { super("pdf_too_long"); } }

export async function pdfToImages(file: File, maxPages: number): Promise<File[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf");
  pdfjs.GlobalWorkerOptions.workerSrc = `${process.env.NEXT_PUBLIC_BASE_PATH || ""}/pdfjs/pdf.worker.min.js`;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  try {
    if (doc.numPages > maxPages) throw new PdfTooLong(doc.numPages);
    const base = file.name.replace(/\.pdf$/i, "");
    const out: File[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const natural = page.getViewport({ scale: 1 });
      let blob: Blob | null = null;
      for (const [width, q] of [[1600, 0.88], [1400, 0.8], [1100, 0.7]] as const) {
        const viewport = page.getViewport({ scale: width / natural.width });
        const c = document.createElement("canvas");
        c.width = Math.round(viewport.width); c.height = Math.round(viewport.height);
        const ctx = c.getContext("2d");
        if (!ctx) throw new Error("no_canvas");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);   // PDFs are transparent by default
        await page.render({ canvasContext: ctx, viewport }).promise;
        blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, "image/jpeg", q));
        if (blob && blob.size <= MAX_BYTES) break;
        blob = null;
      }
      if (!blob) throw new Error("page_too_large");
      out.push(new File([blob], `${base}-${String(n).padStart(2, "0")}.jpg`, { type: "image/jpeg" }));
    }
    return out;
  } finally { void doc.destroy(); }
}
