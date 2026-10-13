import JSZip from 'jszip';
import { marked } from 'marked';
import { escapeXml } from './markup';

// EPUB 3 output that passes W3C epubcheck (enforced in CI, see
// lib/__tests__/epub-converter.test.ts). The old builder failed it on every
// input, even plain text: no nav document, a date without time, HTML (<br>,
// DOCTYPE) where XHTML is required. Strict readers such as Apple Books and
// Kobo reject files like that.
//
// Markdown and HTML go through the DOM: DOMParser (inert), a sanitising pass
// down to what EPUB's XHTML allows, then XMLSerializer for well-formed
// output. That ties md/html → EPUB to the main thread (see runsOnMainThread).
// Plain text needs no DOM.

interface Chapter {
  title: string;
  /** XHTML body content, already serialised. */
  body: string;
}

interface PackagedImage {
  href: string; // relative to OEBPS/
  mediaType: string;
  data: Uint8Array;
}

interface Book {
  title: string;
  language: string;
  chapters: Chapter[];
  images: PackagedImage[];
}

function baseName(file: File): string {
  const dot = file.name.lastIndexOf('.');
  return dot > 0 ? file.name.slice(0, dot) : file.name;
}

// --- Language ----------------------------------------------------------------

// Readers use dc:language for hyphenation, fonts and text-to-speech, so a wrong
// "en" on a Japanese book is visible. An explicit lang wins; otherwise the
// dominant script decides, and "und" (undetermined, valid BCP 47) beats a guess.
export function detectLanguage(text: string, declared?: string | null): string {
  const lang = declared?.trim();
  if (lang && /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(lang)) return lang;

  const counts: Record<string, number> = {};
  const bump = (key: string) => (counts[key] = (counts[key] ?? 0) + 1);
  for (const ch of text.slice(0, 20_000)) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0x31f0 && cp <= 0x31ff)) bump('ja');
    else if (cp >= 0xac00 && cp <= 0xd7af) bump('ko');
    else if (cp >= 0x4e00 && cp <= 0x9fff) bump('zh');
    else if (cp >= 0x0400 && cp <= 0x04ff) bump('ru');
    else if (cp >= 0x0590 && cp <= 0x05ff) bump('he');
    else if (cp >= 0x0600 && cp <= 0x06ff) bump('ar');
    else if (cp >= 0x0e00 && cp <= 0x0e7f) bump('th');
    else if (cp >= 0x0900 && cp <= 0x097f) bump('hi');
    else if (/[A-Za-z]/.test(ch)) bump('latin');
  }
  // Any kana means Japanese even when kanji outnumber it.
  if ((counts.ja ?? 0) > 0 && (counts.ja ?? 0) + (counts.zh ?? 0) >= (counts.latin ?? 0)) {
    return 'ja';
  }
  const [top] = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!top) return 'und';
  // Latin script alone can't tell English from Spanish.
  return top[0] === 'latin' ? 'und' : top[0];
}

// --- Plain text --------------------------------------------------------------

function textToBody(text: string): string {
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return '<p/>';
  return paragraphs.map((p) => `<p>${p.split('\n').map(escapeXml).join('<br/>')}</p>`).join('\n');
}

// --- HTML → sanitised XHTML chapters -------------------------------------------

const XHTML_NS = 'http://www.w3.org/1999/xhtml';

// Removed with their content: executable, interactive or out-of-book.
const DROP = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'object',
  'embed',
  'applet',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'link',
  'meta',
  'base',
  'video',
  'audio',
  'source',
  'track',
  'canvas',
  'dialog',
  'frame',
  'frameset',
  'svg',
  'math',
  'title',
]);

// Obsolete or unknown elements keep their content under a valid name.
const RENAME: Record<string, string> = {
  center: 'div',
  font: 'span',
  big: 'span',
  tt: 'code',
  strike: 's',
  acronym: 'abbr',
  marquee: 'span',
  blink: 'span',
  listing: 'pre',
  xmp: 'pre',
  plaintext: 'pre',
  dir: 'ul',
  menu: 'ul',
  nobr: 'span',
  basefont: 'span',
  spacer: 'span',
};

// Content elements EPUB 3's XHTML accepts in a body, as-is.
const KEEP = new Set([
  'a',
  'abbr',
  'address',
  'article',
  'aside',
  'b',
  'bdi',
  'bdo',
  'blockquote',
  'br',
  'caption',
  'cite',
  'code',
  'col',
  'colgroup',
  'data',
  'dd',
  'del',
  'details',
  'dfn',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'i',
  'img',
  'ins',
  'kbd',
  'li',
  'main',
  'mark',
  'nav',
  'ol',
  'p',
  'picture',
  'pre',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'section',
  'small',
  'span',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'time',
  'tr',
  'u',
  'ul',
  'var',
  'wbr',
]);

const INLINE = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'br',
  'cite',
  'code',
  'data',
  'del',
  'dfn',
  'em',
  'i',
  'img',
  'ins',
  'kbd',
  'mark',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
  'var',
  'wbr',
]);

// Avoid preserving arbitrary inline CSS: EPUB readers may fetch url() resources.
const GLOBAL_ATTRS = new Set(['id', 'class', 'title', 'lang', 'dir']);
const ELEMENT_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href']),
  img: new Set(['src', 'alt', 'width', 'height']),
  ol: new Set(['start', 'reversed', 'type']),
  li: new Set(['value']),
  td: new Set(['colspan', 'rowspan', 'headers']),
  th: new Set(['colspan', 'rowspan', 'headers', 'scope', 'abbr']),
  col: new Set(['span']),
  colgroup: new Set(['span']),
  blockquote: new Set(['cite']),
  q: new Set(['cite']),
  del: new Set(['cite', 'datetime']),
  ins: new Set(['cite', 'datetime']),
  time: new Set(['datetime']),
  data: new Set(['value']),
};

const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

function decodeDataUri(uri: string): { mediaType: string; data: Uint8Array } | null {
  const match = uri.match(/^data:([^;,]+)(;base64)?,([\s\S]*)$/);
  if (!match || !IMAGE_TYPES[match[1].toLowerCase()]) return null;
  const mediaType = match[1].toLowerCase();
  try {
    if (match[2]) {
      const binary = atob(match[3].replace(/\s+/g, ''));
      return { mediaType, data: Uint8Array.from(binary, (c) => c.charCodeAt(0)) };
    }
    return { mediaType, data: new TextEncoder().encode(decodeURIComponent(match[3])) };
  } catch {
    return null;
  }
}

interface SanitiseContext {
  doc: Document;
  images: PackagedImage[];
  seenIds: Set<string>;
}

function hasBlockChild(el: Element): boolean {
  return Array.from(el.children).some((child) => !INLINE.has(child.localName));
}

function replaceWithChildren(el: Element): void {
  el.replaceWith(...Array.from(el.childNodes));
}

function sanitise(root: Element, ctx: SanitiseContext): void {
  // Children first, collected up front: sanitising mutates the tree.
  for (const child of Array.from(root.children)) sanitise(child, ctx);
  if (root.localName === 'body') return;

  let el = root;
  const tag = el.localName.toLowerCase();

  if (DROP.has(tag)) {
    el.remove();
    return;
  }

  if (!KEEP.has(tag)) {
    // Obsolete tags map to their modern equivalent; unknown or custom
    // elements become a neutral span or div around their content.
    const renamed = ctx.doc.createElement(RENAME[tag] ?? (hasBlockChild(el) ? 'div' : 'span'));
    renamed.append(...Array.from(el.childNodes));
    for (const attr of Array.from(el.attributes)) renamed.setAttribute(attr.name, attr.value);
    el.replaceWith(renamed);
    el = renamed;
  }

  const name = el.localName;
  const allowed = ELEMENT_ATTRS[name];
  for (const attr of Array.from(el.attributes)) {
    const attrName = attr.name.toLowerCase();
    const keep =
      GLOBAL_ATTRS.has(attrName) ||
      allowed?.has(attrName) ||
      (/^data-[a-z0-9_.-]+$/.test(attrName) && !/^data-xml/i.test(attrName));
    if (!keep) el.removeAttribute(attr.name);
  }

  // IDs must be unique within the book's documents and non-empty.
  const id = el.getAttribute('id');
  if (id !== null) {
    if (!id.trim() || /\s/.test(id) || ctx.seenIds.has(id)) el.removeAttribute('id');
    else ctx.seenIds.add(id);
  }

  if (name === 'img') {
    const src = el.getAttribute('src') ?? '';
    const image = src.startsWith('data:') ? decodeDataUri(src) : null;
    if (!image) {
      // Relative files aren't in the package and remote images would make
      // the reader fetch from the network, so keep what the image said.
      const alt = el.getAttribute('alt');
      if (alt) el.replaceWith(ctx.doc.createTextNode(alt));
      else el.remove();
      return;
    }
    const href = `images/image-${ctx.images.length + 1}.${IMAGE_TYPES[image.mediaType]}`;
    ctx.images.push({ href, mediaType: image.mediaType, data: image.data });
    el.setAttribute('src', href);
    if (!el.hasAttribute('alt')) el.setAttribute('alt', '');
  }

  if (name === 'picture') {
    replaceWithChildren(el);
    return;
  }

  if (name === 'a') {
    const href = el.getAttribute('href');
    if (href === null) return;
    // Fragment links are fixed up once chapters are known; web and mail links
    // stay. Anything else points at a file that isn't in the book.
    if (!href.startsWith('#') && !/^(https?:|mailto:)/i.test(href)) replaceWithChildren(el);
  }
}

// Markdown links to headings the GitHub way ([see](#part-two)), but marked
// emits headings without ids, so those links had no target. Headings that lack
// an id get GitHub's slug, made unique across the book.
function assignHeadingIds(body: Element, seen: Set<string>): void {
  for (const heading of Array.from(body.querySelectorAll('h1, h2, h3, h4, h5, h6'))) {
    if (heading.hasAttribute('id')) continue;
    const base =
      textOf(heading)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .replace(/\s/g, '-') || 'section';
    let id = base;
    for (let n = 1; seen.has(id); n++) id = `${base}-${n}`;
    seen.add(id);
    heading.setAttribute('id', id);
  }
}

function textOf(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Descend through lone wrappers (<main><article>…) to the element holding the headings. */
function contentRoot(body: Element): Element {
  let root = body;
  for (;;) {
    const elements = Array.from(root.children);
    const hasText = Array.from(root.childNodes).some(
      (n) => n.nodeType === 3 && (n.textContent ?? '').trim(),
    );
    if (elements.length !== 1 || hasText || /^h[1-6]$/.test(elements[0].localName)) return root;
    root = elements[0];
  }
}

function splitChapters(root: Element, fallbackTitle: string): { title: string; nodes: Node[] }[] {
  const chapters: { title: string; nodes: Node[] }[] = [];
  let current: { title: string; nodes: Node[] } | null = null;

  for (const node of Array.from(root.childNodes)) {
    const isHeading = node.nodeType === 1 && /^h[12]$/.test((node as Element).localName);
    if (isHeading) {
      // A chapter that is nothing but its heading (a book title right before
      // chapter one) merges into the next one instead of being a blank page.
      const onlyHeading =
        current !== null &&
        current.nodes.filter((n) => n.nodeType === 1 || (n.textContent ?? '').trim()).length === 1;
      const heading = textOf(node as Element) || fallbackTitle;
      if (current && onlyHeading) {
        // Merged: the chapter is named for the heading that starts its text.
        current.title = heading;
      } else {
        if (current) chapters.push(current);
        current = { title: heading, nodes: [] };
      }
    } else if (!current) {
      current = { title: fallbackTitle, nodes: [] };
    }
    current!.nodes.push(node);
  }
  if (current) chapters.push(current);
  return chapters.length > 0 ? chapters : [{ title: fallbackTitle, nodes: [] }];
}

function serialise(nodes: Node[], doc: Document): string {
  const serializer = new XMLSerializer();
  // Serialised inside a <div> of the XHTML namespace so each top-level
  // element doesn't carry its own xmlns; the wrapper's tags are cut off.
  const wrapper = doc.createElementNS(XHTML_NS, 'div');
  for (const node of nodes) wrapper.appendChild(node);
  if (!wrapper.hasChildNodes()) return '';
  const xml = serializer.serializeToString(wrapper);
  return xml.replace(/^<div[^>]*>/, '').replace(/<\/div>$/, '');
}

async function htmlToBook(html: string, fallbackTitle: string): Promise<Book> {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const firstH1 = doc.querySelector('h1');
  const title =
    doc.querySelector('head > title')?.textContent?.trim() ||
    (firstH1 && textOf(firstH1)) ||
    fallbackTitle;
  const language = detectLanguage(
    doc.body.textContent ?? '',
    doc.documentElement.getAttribute('lang'),
  );

  const ctx: SanitiseContext = { doc, images: [], seenIds: new Set() };
  sanitise(doc.body, ctx);

  assignHeadingIds(doc.body, ctx.seenIds);
  const parts = splitChapters(contentRoot(doc.body), title);

  // Which chapter file holds each id, so #fragment links survive the split.
  const idToFile = new Map<string, string>();
  parts.forEach((part, i) => {
    for (const node of part.nodes) {
      if (node.nodeType !== 1) continue;
      const el = node as Element;
      for (const withId of [el, ...Array.from(el.querySelectorAll('[id]'))]) {
        const id = withId.getAttribute('id');
        if (id) idToFile.set(id, chapterFile(i));
      }
    }
  });
  for (const part of parts) {
    for (const node of part.nodes) {
      if (node.nodeType !== 1) continue;
      const el = node as Element;
      for (const link of [el, ...Array.from(el.querySelectorAll('a[href^="#"]'))]) {
        if (link.localName !== 'a') continue;
        const href = link.getAttribute('href') ?? '';
        if (!href.startsWith('#')) continue;
        const file = idToFile.get(href.slice(1));
        if (file) link.setAttribute('href', `${file}${href}`);
        else replaceWithChildren(link); // target doesn't exist: keep the text
      }
    }
  }

  const chapters = parts.map((part) => ({ title: part.title, body: serialise(part.nodes, doc) }));
  return { title, language, chapters, images: ctx.images };
}

// --- Package -------------------------------------------------------------------

function chapterFile(index: number): string {
  return `chapter-${index + 1}.xhtml`;
}

function xhtmlDocument(title: string, language: string, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="${XHTML_NS}" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(language)}" xml:lang="${escapeXml(language)}">
<head><title>${escapeXml(title)}</title></head>
<body>
${body || '<p/>'}
</body>
</html>`;
}

function navDocument(book: Book): string {
  const items = book.chapters
    .map((c, i) => `      <li><a href="${chapterFile(i)}">${escapeXml(c.title)}</a></li>`)
    .join('\n');
  return xhtmlDocument(
    book.title,
    book.language,
    `<nav epub:type="toc" id="toc">
  <h1>${escapeXml(book.title)}</h1>
  <ol>
${items}
  </ol>
</nav>`,
  );
}

// EPUB 2 table of contents, for older reading systems (and Kindle's converter)
// that ignore the EPUB 3 nav document.
function ncxDocument(book: Book, id: string): string {
  const points = book.chapters
    .map(
      (c, i) => `    <navPoint id="nav-${i + 1}" playOrder="${i + 1}">
      <navLabel><text>${escapeXml(c.title)}</text></navLabel>
      <content src="${chapterFile(i)}"/>
    </navPoint>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:${id}"/></head>
  <docTitle><text>${escapeXml(book.title)}</text></docTitle>
  <navMap>
${points}
  </navMap>
</ncx>`;
}

function opfDocument(book: Book, id: string): string {
  // dcterms:modified must be CCYY-MM-DDThh:mm:ssZ exactly (no milliseconds).
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const chapterItems = book.chapters
    .map(
      (_, i) =>
        `    <item id="c${i + 1}" href="${chapterFile(i)}" media-type="application/xhtml+xml"/>`,
    )
    .join('\n');
  const imageItems = book.images
    .map(
      (img, i) => `    <item id="img${i + 1}" href="${img.href}" media-type="${img.mediaType}"/>`,
    )
    .join('\n');
  const spine = book.chapters.map((_, i) => `    <itemref idref="c${i + 1}"/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${escapeXml(book.language)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:uuid:${id}</dc:identifier>
    <dc:title>${escapeXml(book.title)}</dc:title>
    <dc:language>${escapeXml(book.language)}</dc:language>
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
${chapterItems}${imageItems ? `\n${imageItems}` : ''}
  </manifest>
  <spine toc="ncx">
${spine}
  </spine>
</package>`;
}

const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

async function buildEpub(book: Book): Promise<Blob> {
  const id = crypto.randomUUID();
  const zip = new JSZip();
  // `mimetype` must be the first entry and stored uncompressed.
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', CONTAINER);
  zip.file('OEBPS/content.opf', opfDocument(book, id));
  zip.file('OEBPS/nav.xhtml', navDocument(book));
  zip.file('OEBPS/toc.ncx', ncxDocument(book, id));
  book.chapters.forEach((chapter, i) => {
    zip.file(`OEBPS/${chapterFile(i)}`, xhtmlDocument(chapter.title, book.language, chapter.body));
  });
  for (const image of book.images) zip.file(`OEBPS/${image.href}`, image.data);
  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/epub+zip',
    compression: 'DEFLATE',
  });
}

// --- Converters ------------------------------------------------------------------

export async function txtToEpub(file: File, _sourceExt: string, _targetExt: string): Promise<Blob> {
  const text = await file.text();
  const title = baseName(file);
  return buildEpub({
    title,
    language: detectLanguage(text),
    chapters: [{ title, body: textToBody(text) }],
    images: [],
  });
}

export async function mdToEpub(file: File, _sourceExt: string, _targetExt: string): Promise<Blob> {
  const html = await marked.parse(await file.text());
  return buildEpub(await htmlToBook(html, baseName(file)));
}

export async function htmlToEpub(
  file: File,
  _sourceExt: string,
  _targetExt: string,
): Promise<Blob> {
  return buildEpub(await htmlToBook(await file.text(), baseName(file)));
}
