/**
 * Turns an uploaded PDF into one image file per page.
 *
 * Vouchers arrive as multi-page PDFs — a scanner run over a stack of गोश्वरा
 * भौचर produces one file holding several unrelated vouchers, each with its own
 * date and its own जम्मा totals. They are split here, in the browser, at upload
 * time, so that everything downstream keeps seeing exactly what it saw before:
 * one receipt is one image is one voucher.
 *
 * Splitting later — in the extraction worker — was the other option and is
 * worse. The Excel exporter emits one Tally voucher block per receipt and dates
 * it from that receipt's first row (ExcelExporter.tsx), so a receipt holding six
 * vouchers would export as a single voucher under one wrong date. Keeping the
 * one-image-one-voucher invariant is what avoids that, and it needs no database
 * change, no exporter change, and no backend change.
 */

/** Page cap. A runaway PDF would otherwise queue unbounded Vision extractions,
 *  each costing several model calls. Anything larger is rejected outright rather
 *  than silently truncated — dropping vouchers on the floor is the one outcome
 *  worse than refusing the file. */
export const MAX_PDF_PAGES = 50;

/** Long edge, in pixels, that each rendered page is aimed at.
 *
 *  Handwritten paisa digits are the hardest thing on these vouchers to read, and
 *  they are what the totals check turns on, so the render has to stay generous.
 *  A 2000px long edge keeps a full page comfortably above the resolution where
 *  OpenAI's `detail: "high"` tiling starts losing thin pen strokes, while
 *  staying small enough to base64 into a request without trouble. */
const TARGET_LONG_EDGE = 2000;

/** Guards against a PDF that declares an absurd page size; a 20000px canvas
 *  fails to allocate on mobile Safari and takes the whole upload with it. */
const MAX_RENDER_SCALE = 4;

/** JPEG rather than PNG: a scanned page is photographic, and PNG runs several
 *  times larger for no gain in what the model can read. 0.92 is high enough to
 *  leave pen strokes intact. */
const JPEG_QUALITY = 0.92;

export function isPdfFile(file: Pick<File, 'name' | 'type'>): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

/** `document.pdf` + page 3 of 6 -> `document - page 3 of 6.jpg` */
function pageFileName(pdfName: string, page: number, total: number): string {
  const base = pdfName.replace(/\.pdf$/i, '').trim() || 'voucher';
  return total === 1 ? `${base}.jpg` : `${base} - page ${page} of ${total}.jpg`;
}

/** Loaded on demand. pdf.js is a large dependency and most uploads are plain
 *  photographs that never need it, so it stays out of the initial bundle. */
async function loadPdfJs() {
  const pdfjs = await import('pdfjs-dist');
  // Vite rewrites this to the hashed asset URL at build time, which is what
  // makes the worker resolve on Vercel as well as on the dev server.
  const workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  return pdfjs;
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => (blob ? resolve(blob) : reject(new Error('This page could not be converted to an image.'))),
      'image/jpeg',
      JPEG_QUALITY,
    );
  });
}

/**
 * Renders every page of `file` to a JPEG.
 *
 * Throws when the PDF cannot be opened at all (encrypted, truncated, not really
 * a PDF) or when it exceeds {@link MAX_PDF_PAGES}, so the caller can report the
 * whole file as skipped instead of uploading a partial stack of vouchers.
 */
export async function splitPdfIntoPageImages(
  file: File,
  onProgress?: (page: number, total: number) => void,
): Promise<File[]> {
  const pdfjs = await loadPdfJs();

  let document;
  try {
    document = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  } catch (err: any) {
    if (err?.name === 'PasswordException') {
      throw new Error('This PDF is password protected. Remove the password and upload it again.');
    }
    throw new Error('This PDF could not be opened. It may be damaged or incomplete.');
  }

  try {
    const total = document.numPages;
    if (total > MAX_PDF_PAGES) {
      throw new Error(
        `This PDF has ${total} pages. Please split it into files of ${MAX_PDF_PAGES} pages or fewer.`,
      );
    }

    const pages: File[] = [];
    for (let pageNumber = 1; pageNumber <= total; pageNumber++) {
      onProgress?.(pageNumber, total);
      const page = await document.getPage(pageNumber);
      try {
        const unscaled = page.getViewport({ scale: 1 });
        const scale = Math.min(
          MAX_RENDER_SCALE,
          TARGET_LONG_EDGE / Math.max(unscaled.width, unscaled.height),
        );
        // Never render below the PDF's own size — upscaling a low-DPI scan adds
        // nothing, but downscaling a high-DPI one throws away pen strokes.
        const viewport = page.getViewport({ scale: Math.max(scale, 1) });

        const canvas = window.document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('This browser could not render the PDF pages.');

        // Scanned pages carry transparent margins; without this they flatten to
        // black in a JPEG and the model reads a dark frame around the voucher.
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);

        await page.render({ canvasContext: context, viewport }).promise;
        const blob = await canvasToJpeg(canvas);
        pages.push(
          new File([blob], pageFileName(file.name, pageNumber, total), { type: 'image/jpeg' }),
        );

        // Frees the backing bitmap now rather than at the next GC. A 50-page
        // stack of 2000px canvases is hundreds of megabytes if they all linger.
        canvas.width = 0;
        canvas.height = 0;
      } finally {
        page.cleanup();
      }
    }
    return pages;
  } finally {
    await document.destroy();
  }
}
