'use client';

import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';

type DocumentKind = 'docx' | 'pptx' | 'odt' | 'odp' | 'workbook' | 'pdf';
type Sheet = { name: string; rows: string[][]; truncated: boolean };
type Preview = { frame: string } | { sheets: Sheet[] };

// Rendered Office markup stays in a scriptless, opaque frame with no network access.
export function officeFrame(body: string, styles = '') {
  const template = document.createElement('template');
  template.innerHTML = body;
  template.content.querySelectorAll('script,iframe,frame,object,embed,link,meta,base,form,template,foreignObject,animate,animateTransform,set')
    .forEach((node) => node.remove());
  for (const node of template.content.querySelectorAll('*')) {
    for (const { name, value } of [...node.attributes]) {
      if (/^on/i.test(name) || /^(?:href|xlink:href|src|srcset|ping|action|formaction|background|poster)$/i.test(name)
        && !(/^(?:src|href|xlink:href)$/i.test(name) && /^data:image\/(?:png|jpeg|gif|webp|bmp);base64,/i.test(value))) {
        node.removeAttribute(name);
      }
    }
  }
  const page = template.content.querySelector<HTMLElement>('section.docx, .slide');
  const width = page?.style.width || page?.style.minWidth || '';
  const fit = /^\d+(?:\.\d+)?(?:px|pt|in|cm|mm)$/.test(width) ? ` style="--paper-width:${width}"` : '';
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'"><style>${styles.replace(/<\/style/gi, '<\\/style')}</style><style>
    body{margin:0;padding:8px;background:#e7e7e7;color:#171717;font:14px system-ui}
    .paper{width:max-content;margin-inline:auto}.paper[style]{zoom:clamp(.25,calc((100vw - 16px)/var(--paper-width)),1)}
    .docx-wrapper{padding:0!important;align-items:flex-start!important}
    .slide{isolation:isolate;margin-bottom:8px}
    .odf{background:white;padding:24px;margin:0 auto 8px;max-width:52rem;white-space:pre-wrap}
    </style><main${page ? ` class="paper"${fit}` : ''}>${template.innerHTML}</main>`;
}

async function archive(bytes: ArrayBuffer, onlyContent = false) {
  const { unzipSync } = await import('fflate');
  let size = 0, entries = 0;
  return unzipSync(new Uint8Array(bytes), { filter: (entry) => {
    if (++entries > 4000 || (size += entry.originalSize) > 32 * 1024 * 1024) throw new Error('Document is too large to preview.');
    return onlyContent && entry.name === 'content.xml';
  } });
}

export async function readDocument(kind: Exclude<DocumentKind, 'pdf'>, bytes: ArrayBuffer): Promise<Preview> {
  const zip = new Uint8Array(bytes)[0] === 0x50 && new Uint8Array(bytes)[1] === 0x4b;
  if (kind !== 'workbook' || zip) {
    const parts = await archive(bytes, kind === 'odt' || kind === 'odp');
    if (kind === 'odt' || kind === 'odp') {
      const content = parts['content.xml'];
      if (!content) throw new Error('OpenDocument content is missing.');
      const xml = new DOMParser().parseFromString(new TextDecoder().decode(content), 'application/xml');
      if (xml.querySelector('parsererror')) throw new Error('OpenDocument content is invalid.');
      const text = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
      const pages = kind === 'odp' ? [...xml.getElementsByTagNameNS('urn:oasis:names:tc:opendocument:xmlns:drawing:1.0', 'page')] : [xml];
      const body = document.createElement('div');
      for (const page of pages) {
        const section = document.createElement('section');
        section.className = 'odf';
        section.textContent = [...page.getElementsByTagNameNS(text, '*')].filter((node) => node.localName === 'p' || node.localName === 'h')
          .map((node) => node.textContent).join('\n\n');
        body.append(section);
      }
      if (!body.textContent?.trim()) throw new Error('No text to preview. Use Download to open the original.');
      return { frame: officeFrame(body.innerHTML) };
    }
  }
  if (kind === 'docx') {
    const { renderAsync } = await import('docx-preview');
    const inert = document.implementation.createHTMLDocument('');
    const body = inert.createElement('div'), styles = inert.createElement('div');
    await renderAsync(bytes, body, styles, { useBase64URL: true, renderAltChunks: false });
    return { frame: officeFrame(body.innerHTML, styles.textContent ?? '') };
  }
  if (kind === 'pptx') {
    const { pptxToHtml } = await import('@jvmr/pptx-to-html');
    const slides = await pptxToHtml(bytes);
    if (!slides.length) throw new Error('No slides to preview.');
    return { frame: officeFrame(slides.join('')) };
  }
  const { read, utils } = await import('xlsx');
  const book = read(bytes, { dense: true, sheetRows: 201, cellHTML: false, cellFormula: false, bookVBA: false });
  if (!book.SheetNames.length) throw new Error('No worksheets to preview.');
  return { sheets: book.SheetNames.map((name) => {
    const sheet = book.Sheets[name];
    const range = utils.decode_range(sheet?.['!ref'] ?? 'A1');
    const full = utils.decode_range(sheet?.['!fullref'] ?? sheet?.['!ref'] ?? 'A1');
    const rowCount = Math.min(200, range.e.r - range.s.r + 1), cols = Math.min(50, range.e.c - range.s.c + 1);
    return { name, truncated: full.e.r - full.s.r + 1 > rowCount || full.e.c - full.s.c + 1 > cols,
      rows: !sheet?.['!ref'] ? [] : Array.from({ length: rowCount }, (_, r) => Array.from({ length: cols }, (_, c) => {
        const cell = sheet['!data']?.[range.s.r + r]?.[range.s.c + c];
        return cell ? utils.format_cell(cell).slice(0, 1024) : '';
      })) };
  }) };
}

function PdfPreview({ bytes }: { bytes: ArrayBuffer }) {
  const [doc, setDoc] = useState<PDFDocumentProxy>();
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let stopped = false;
    let close: (() => Promise<void>) | undefined;
    void (async () => {
      const pdf = await import('pdfjs-dist');
      if (stopped) return;
      pdf.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
      const task = pdf.getDocument({ data: bytes.slice(0), enableXfa: false, maxImageSize: 16_000_000 });
      close = () => task.destroy();
      const result = await task.promise;
      if (!stopped) setDoc(result);
    })().catch(() => { if (!stopped) setError('PDF could not be opened.'); });
    return () => { stopped = true; void close?.().catch(() => {}); };
  }, [bytes]);
  useEffect(() => {
    if (!doc) return;
    let stopped = false;
    let cancel: (() => void) | undefined;
    void (async () => {
      const current = await doc.getPage(page), target = canvas.current;
      if (stopped || !target) return;
      const size = current.getViewport({ scale: 1 });
      const viewport = current.getViewport({ scale: Math.min(2, 1800 / Math.max(size.width, size.height)) });
      target.width = Math.ceil(viewport.width);
      target.height = Math.ceil(viewport.height);
      const task = current.render({ canvas: target, viewport });
      cancel = () => task.cancel();
      await task.promise;
      current.cleanup();
    })().catch(() => { if (!stopped) setError('PDF page could not be rendered.'); });
    return () => { stopped = true; cancel?.(); };
  }, [doc, page]);
  if (error) return <p role="alert" className="p-4">{error} Use Download to open the original.</p>;
  if (!doc) return <p role="status" className="p-4">Opening PDF…</p>;
  return <>
    <div className="sticky top-0 z-10 flex items-center justify-center gap-4 border-b bg-background p-2 text-sm">
      <button type="button" aria-label="Previous page" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</button>
      <span>Page {page} of {doc.numPages}</span>
      <button type="button" aria-label="Next page" disabled={page === doc.numPages} onClick={() => setPage(page + 1)}>Next</button>
    </div>
    <canvas key={page} ref={canvas} role="img" aria-label={`PDF page ${page}`} className="mx-auto block max-w-full bg-white" />
  </>;
}

export function DocumentPreview({ kind, bytes, name }: { kind: DocumentKind; bytes: ArrayBuffer; name: string }) {
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState('');
  const [sheet, setSheet] = useState(0);
  useEffect(() => {
    if (kind === 'pdf') return;
    let stopped = false;
    void readDocument(kind, bytes).then((value) => { if (!stopped) setPreview(value); },
      (failure: unknown) => { if (!stopped) setError(failure instanceof Error && failure.message === 'Document is too large to preview.' ? failure.message : 'Preview unavailable. Use Download to open the original.'); });
    return () => { stopped = true; };
  }, [kind, bytes]);
  if (kind === 'pdf') return <PdfPreview bytes={bytes} />;
  if (error) return <p role="alert" className="p-4">{error}</p>;
  if (!preview) return <p role="status" className="p-4">Preparing preview…</p>;
  if ('frame' in preview) return <iframe title={name} className="block size-full border-0" sandbox="" srcDoc={preview.frame} />;
  const active = preview.sheets[sheet]!;
  return <>
    <label className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background p-2 text-sm">
      Worksheet
      <select className="min-w-0 rounded border bg-background p-1" value={sheet} onChange={(event) => setSheet(Number(event.target.value))}>
        {preview.sheets.map(({ name }, index) => <option key={index} value={index}>{name}</option>)}
      </select>
    </label>
    {active.truncated && <p className="p-2 text-xs text-muted-foreground">Preview limited to 200 rows and 50 columns. Download for the complete worksheet.</p>}
    {active.rows.length ? <table aria-label={active.name} className="border-collapse text-sm">
      <tbody>{active.rows.map((row, index) => <tr key={index}>
        {row.map((value, column) => <td key={column} className="max-w-80 border px-2 py-1 whitespace-pre-wrap break-words">{value}</td>)}
      </tr>)}</tbody>
    </table> : <p className="p-4 text-sm">Empty worksheet.</p>}
  </>;
}
