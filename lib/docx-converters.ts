// Word documents. Reading goes through mammoth (BSD-2), which maps Word's
// styles to semantic HTML (headings, lists, tables, links, images inlined as
// data: URIs); every other format is reached from that HTML. Writing is
// lib/docx-writer.ts, from the same blocks the PDF typesetter uses.

import { ConversionError } from './errors';
import { escapeHtml } from './markup';
import { markdownBlocks } from './markdown-blocks';
import { renderPdf, textBlocks } from './pdf-layout';
import { blocksToDocx } from './docx-writer';
import { htmlStringToMarkdown } from './markdown-converters';
import { safeHtmlDocument } from './safe-html';

const stem = (name: string) => name.replace(/\.[^.]+$/, '');

type Mammoth = typeof import('mammoth');

async function mammoth(): Promise<Mammoth> {
  const mod = (await import('mammoth')) as Mammoth & { default?: Mammoth };
  return mod.default ?? mod;
}

// mammoth throws plain errors for a file that isn't a .docx (a zip without
// word/document.xml, an old binary .doc renamed): say so in our terms.
// The browser build takes { arrayBuffer }, the Node one (tests) { buffer };
// both hand it to JSZip, which takes an ArrayBuffer either way.
type Input = { arrayBuffer: ArrayBuffer };

async function read<T>(file: File, work: (m: Mammoth, input: Input) => Promise<T>) {
  const arrayBuffer = await file.arrayBuffer();
  try {
    return await work(await mammoth(), { arrayBuffer, buffer: arrayBuffer } as Input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConversionError(
      'corrupt-input',
      `Not a valid .docx (legacy .doc files aren't supported; re-save as .docx): ${message}`,
    );
  }
}

/** The document body as HTML: headings, lists, tables, links, inline images. */
async function docxHtml(file: File): Promise<string> {
  return read(file, async (m, input) => (await m.convertToHtml(input)).value);
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
</head>
<body>
${body}
</body>
</html>
`;
}

export async function docxToHtml(file: File): Promise<Blob> {
  return new Blob([safeHtmlDocument(stem(file.name), await docxHtml(file))], { type: 'text/html' });
}

export async function docxToTxt(file: File): Promise<Blob> {
  const text = await read(file, async (m, input) => (await m.extractRawText(input)).value);
  return new Blob([text.replace(/\n{3,}/g, '\n\n').trim() + '\n'], { type: 'text/plain' });
}

/** Via Turndown, so main thread. */
export async function docxToMd(file: File): Promise<Blob> {
  return new Blob([htmlStringToMarkdown(await docxHtml(file))], { type: 'text/markdown' });
}

/** Typeset from the Markdown, so headings, lists and tables survive. Main thread. */
export async function docxToPdf(file: File): Promise<Blob> {
  return renderPdf(markdownBlocks(htmlStringToMarkdown(await docxHtml(file))));
}

/** Through the HTML → EPUB path, which packages the inline images. Main thread. */
export async function docxToEpub(file: File): Promise<Blob> {
  const { htmlToEpub } = await import('./epub-converter');
  const html = new File([page(stem(file.name), await docxHtml(file))], `${stem(file.name)}.html`);
  return htmlToEpub(html, 'html', 'epub');
}

export async function mdToDocx(file: File): Promise<Blob> {
  return blocksToDocx(markdownBlocks(await file.text()), stem(file.name));
}

export async function txtToDocx(file: File): Promise<Blob> {
  return blocksToDocx(textBlocks(await file.text()), stem(file.name));
}

/** Via Turndown and the Markdown blocks. Main thread. */
export async function htmlToDocx(file: File): Promise<Blob> {
  return blocksToDocx(markdownBlocks(htmlStringToMarkdown(await file.text())), stem(file.name));
}
