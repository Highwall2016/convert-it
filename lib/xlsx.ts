import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { escapeXml } from './markup';

// A small XLSX (SpreadsheetML) reader and writer on jszip + fast-xml-parser,
// both already in the bundle. It replaces SheetJS: the npm `xlsx` package is
// frozen at 0.18.5 with unfixed prototype-pollution (GHSA-4r6h-8v6p-xvw6) and
// ReDoS (GHSA-5pgg-2g8v-p4x9) advisories. It parsed every untrusted .xlsx, and
// patched builds exist only on SheetJS's own CDN. exceljs was considered and
// rejected: it pulls archiver/glob/uuid advisories and roughly 1 MB of code.
//
// The scope is exactly what the converters need: cell values (shared/inline/
// rich strings, numbers, booleans, errors, formula results, dates via the cell's
// number format) from every sheet, and writing one plain sheet. Formatting,
// merged cells and charts are ignored on read and never written.

export type CellValue = string | number | boolean | Date | null;

export interface Sheet {
  name: string;
  /** Dense rows from A1; missing cells are null. */
  rows: CellValue[][];
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const ARRAY_TAGS = new Set(['sheet', 'Relationship', 'row', 'c', 'si', 'r', 'numFmt', 'xf']);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  removeNSPrefix: true,
  // Keep every value a string: "007" is text, and numbers are converted here
  // according to the cell type rather than guessed by the parser.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
  htmlEntities: false,
  isArray: (tag) => ARRAY_TAGS.has(tag),
});

type XmlNode = Record<string, unknown>;

function text(node: unknown): string {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (typeof node === 'object' && '#text' in (node as XmlNode))
    return String((node as XmlNode)['#text']);
  return '';
}

/** `<si>` / `<is>`: either a single `<t>` or rich-text runs `<r><t>…</t></r>`. */
function stringItem(node: unknown): string {
  if (!node || typeof node !== 'object') return text(node);
  const item = node as XmlNode;
  if (item.t !== undefined) return text(item.t);
  if (Array.isArray(item.r)) return item.r.map((run) => text((run as XmlNode).t)).join('');
  return '';
}

// Enforce limits while decompressing. Checking File.size or waiting until
// entry.async('string') finishes does not stop a tiny XLSX ZIP bomb.
const MAX_XML_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_XML_TOTAL_BYTES = 32 * 1024 * 1024;
type XmlBudget = { remaining: number };

async function readXml(zip: JSZip, path: string, budget: XmlBudget): Promise<XmlNode | null> {
  const entry = zip.file(path);
  if (!entry) return null;
  const xml = await new Promise<string>((resolve, reject) => {
    // JSZip's browser stream API exists at runtime, but its TypeScript
    // declarations expose only the eager async() and Node-only nodeStream().
    // Use a small local interface so decompression can be interrupted early.
    interface ZipStream {
      on(event: 'data', cb: (chunk: Uint8Array) => void): ZipStream;
      on(event: 'error', cb: (error: Error) => void): ZipStream;
      on(event: 'end', cb: () => void): ZipStream;
      pause(): void;
      resume(): void;
    }
    const stream = (
      entry as JSZip.JSZipObject & { internalStream(type: 'uint8array'): ZipStream }
    ).internalStream('uint8array');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const parts: string[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      stream.pause();
      reject(error);
    };
    stream.on('data', (chunk: Uint8Array) => {
      if (settled) return;
      size += chunk.byteLength;
      budget.remaining -= chunk.byteLength;
      if (size > MAX_XML_ENTRY_BYTES || budget.remaining < 0) {
        fail(new Error('Spreadsheet XML exceeds the safe decompressed-size limit'));
        return;
      }
      try {
        parts.push(decoder.decode(chunk, { stream: true }));
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    stream.on('error', (error: Error) => fail(error));
    stream.on('end', () => {
      if (settled) return;
      try {
        parts.push(decoder.decode());
        settled = true;
        resolve(parts.join(''));
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    stream.resume();
  });
  return parser.parse(xml) as XmlNode;
}

function resolveTarget(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const segment of target.split('/')) {
    if (segment === '..') parts.pop();
    else if (segment !== '.') parts.push(segment);
  }
  return parts.join('/');
}

async function relationships(
  zip: JSZip,
  partPath: string,
  budget: XmlBudget,
): Promise<{ id: string; type: string; target: string }[]> {
  const dir = partPath.split('/').slice(0, -1).join('/');
  const name = partPath.split('/').pop();
  const relsPath = `${dir ? `${dir}/` : ''}_rels/${name}.rels`;
  const rels = await readXml(zip, relsPath, budget);
  const list =
    ((rels?.Relationships as XmlNode | undefined)?.Relationship as XmlNode[] | undefined) ?? [];
  return list.map((rel) => ({
    id: String(rel['@_Id'] ?? ''),
    type: String(rel['@_Type'] ?? ''),
    target: resolveTarget(partPath, String(rel['@_Target'] ?? '')),
  }));
}

// Built-in number formats that render as dates or times (ECMA-376 §18.8.30,
// plus the 50–58 range the CJK locales use).
const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51,
  52, 53, 54, 55, 56, 57, 58,
]);

function isDateFormat(code: string): boolean {
  const stripped = code
    .replace(/"[^"]*"/g, '') // quoted literals
    .replace(/\\./g, '') // escaped characters
    .replace(/\[(?![hms]+\])[^\]]*\]/gi, ''); // [Red], [$-409], but not elapsed [h]/[mm]/[ss]
  return /[dmyhs]/i.test(stripped) && !/^general$/i.test(stripped.trim());
}

async function dateStyles(
  zip: JSZip,
  stylesPath: string | undefined,
  budget: XmlBudget,
): Promise<Set<number>> {
  const dated = new Set<number>();
  if (!stylesPath) return dated;
  const styles = (await readXml(zip, stylesPath, budget))?.styleSheet as XmlNode | undefined;
  if (!styles) return dated;

  const custom = new Map<number, string>();
  for (const fmt of ((styles.numFmts as XmlNode | undefined)?.numFmt as XmlNode[] | undefined) ??
    []) {
    custom.set(Number(fmt['@_numFmtId']), String(fmt['@_formatCode'] ?? ''));
  }
  const xfs = ((styles.cellXfs as XmlNode | undefined)?.xf as XmlNode[] | undefined) ?? [];
  xfs.forEach((xf, index) => {
    const id = Number(xf['@_numFmtId'] ?? 0);
    const code = custom.get(id);
    if (code !== undefined ? isDateFormat(code) : BUILTIN_DATE_FORMATS.has(id)) dated.add(index);
  });
  return dated;
}

const DAY_MS = 86_400_000;
// Serial 0 is 1899-12-30 in the 1900 system: this absorbs Excel's phantom
// 1900-02-29 for every date after it, which is every date anyone stores.
const EPOCH_1900 = Date.UTC(1899, 11, 30);
const EPOCH_1904 = Date.UTC(1904, 0, 1);

function serialToDate(serial: number, date1904: boolean): Date {
  return new Date(Math.round(serial * DAY_MS) + (date1904 ? EPOCH_1904 : EPOCH_1900));
}

function columnIndex(ref: string): number {
  let col = 0;
  for (const ch of ref.toUpperCase()) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) break;
    col = col * 26 + (code - 64);
  }
  return col - 1;
}

function rowIndex(ref: string): number {
  const digits = ref.replace(/^[A-Za-z]+/, '');
  return digits ? Number(digits) - 1 : -1;
}

// Excel stores doubles with 17 significant digits but shows 15, so
// 0.1 + 0.2 is "0.30000000000000004" in the file and 0.3 in the grid.
function excelNumber(raw: string): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Number(n.toPrecision(15)) : n;
}

// Bound materialised *rectangular* cells, not just non-empty entries.
// A two-cell XFD1048576 workbook must never allocate 17 billion slots.
const MAX_CELLS = 1_000_000;
const MAX_ROWS = 100_000;

export async function readWorkbook(data: ArrayBuffer | Uint8Array): Promise<Sheet[]> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    throw new Error(
      'Not a valid .xlsx file (it is not a zip archive; legacy .xls is not supported)',
    );
  }

  const budget: XmlBudget = { remaining: MAX_XML_TOTAL_BYTES };
  const rootRels = await relationships(zip, '', budget);
  const workbookPath =
    rootRels.find((rel) => rel.type.endsWith('/officeDocument'))?.target ?? 'xl/workbook.xml';
  const workbook = (await readXml(zip, workbookPath, budget))?.workbook as XmlNode | undefined;
  if (!workbook) throw new Error('Not a valid .xlsx file (no workbook part)');

  const wbRels = await relationships(zip, workbookPath, budget);
  const byId = new Map(wbRels.map((rel) => [rel.id, rel]));
  const sharedPath = wbRels.find((rel) => rel.type.endsWith('/sharedStrings'))?.target;
  const stylesPath = wbRels.find((rel) => rel.type.endsWith('/styles'))?.target;

  const date1904Attr = (workbook.workbookPr as XmlNode | undefined)?.['@_date1904'];
  const date1904 = date1904Attr === 'true' || date1904Attr === '1';

  const sst = sharedPath ? (await readXml(zip, sharedPath, budget))?.sst : undefined;
  const shared = (((sst as XmlNode | undefined)?.si as unknown[]) ?? []).map(stringItem);
  const dated = await dateStyles(zip, stylesPath, budget);

  const sheetNodes =
    ((workbook.sheets as XmlNode | undefined)?.sheet as XmlNode[] | undefined) ?? [];
  const sheets: Sheet[] = [];
  let cellBudget = MAX_CELLS;
  let gridBudget = MAX_CELLS;

  for (const sheetNode of sheetNodes) {
    const rel = byId.get(String(sheetNode['@_id'] ?? ''));
    // Chartsheets and dialog sheets have no cell grid.
    if (!rel || !rel.type.endsWith('/worksheet')) continue;
    const worksheet = (await readXml(zip, rel.target, budget))?.worksheet as XmlNode | undefined;
    const rowNodes =
      ((worksheet?.sheetData as XmlNode | undefined)?.row as XmlNode[] | undefined) ?? [];

    const rows: CellValue[][] = [];
    let sheetHeight = 0;
    let sheetWidth = 0;
    let sheetSlots = 0;
    let nextRow = 0;
    for (const rowNode of rowNodes) {
      const r = rowNode['@_r'] !== undefined ? Number(rowNode['@_r']) - 1 : nextRow;
      nextRow = r + 1;
      let nextCol = 0;
      for (const cell of (rowNode.c as XmlNode[] | undefined) ?? []) {
        const ref = cell['@_r'] !== undefined ? String(cell['@_r']) : '';
        const col = ref ? columnIndex(ref) : nextCol;
        const cellRow = ref && rowIndex(ref) >= 0 ? rowIndex(ref) : r;
        nextCol = col + 1;
        if (!Number.isSafeInteger(col) || !Number.isSafeInteger(cellRow)) continue;
        if (col < 0 || col > 16_383 || cellRow < 0 || cellRow > 1_048_575) continue;

        const value = decodeCell(cell, shared, dated, date1904);
        if (value === null) continue;
        const requiredHeight = Math.max(sheetHeight, cellRow + 1);
        const requiredWidth = Math.max(sheetWidth, col + 1);
        const requiredSlots = requiredHeight * requiredWidth;
        const extraSlots = requiredSlots - sheetSlots;
        // Check BEFORE extending arrays, including the final rectangular padding.
        if (
          requiredHeight > MAX_ROWS ||
          requiredSlots > MAX_CELLS ||
          extraSlots > gridBudget ||
          --cellBudget < 0
        ) {
          throw new Error('Spreadsheet is too large to convert safely in the browser');
        }
        gridBudget -= extraSlots;
        sheetHeight = requiredHeight;
        sheetWidth = requiredWidth;
        sheetSlots = requiredSlots;
        while (rows.length <= cellRow) rows.push([]);
        const row = rows[cellRow];
        while (row.length < col) row.push(null);
        row[col] = value;
      }
    }

    const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
    for (const row of rows) while (row.length < width) row.push(null);
    sheets.push({ name: String(sheetNode['@_name'] ?? `Sheet${sheets.length + 1}`), rows });
  }

  if (sheets.length === 0) throw new Error('This workbook has no worksheets');
  return sheets;
}

function decodeCell(
  cell: XmlNode,
  shared: string[],
  dated: Set<number>,
  date1904: boolean,
): CellValue {
  const type = String(cell['@_t'] ?? 'n');
  const raw = text(cell.v);

  switch (type) {
    case 's': {
      if (raw === '') return null;
      return shared[Number(raw)] ?? '';
    }
    case 'inlineStr':
      return stringItem(cell.is);
    case 'str':
      return raw;
    case 'b':
      return raw === '' ? null : raw === '1' || raw.toLowerCase() === 'true';
    case 'e':
      return raw;
    case 'd': {
      const date = new Date(raw);
      return Number.isNaN(date.getTime()) ? raw : date;
    }
    default: {
      if (raw === '') return null;
      const n = excelNumber(raw);
      if (!Number.isFinite(n)) return raw;
      return dated.has(Number(cell['@_s'] ?? 0)) ? serialToDate(n, date1904) : n;
    }
  }
}

/** A cell as CSV/text shows it: dates as ISO `YYYY-MM-DD[ HH:MM:SS]`, booleans as TRUE/FALSE. */
export function cellToText(value: CellValue): string {
  if (value === null) return '';
  if (value instanceof Date) {
    const iso = value.toISOString();
    const [day, time] = [iso.slice(0, 10), iso.slice(11, 19)];
    return time === '00:00:00' ? day : `${day} ${time}`;
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value);
}

/**
 * Header row → objects, like SheetJS's sheet_to_json: empty cells are left
 * out, fully empty rows are skipped, a blank header becomes `__EMPTY` and a
 * repeated one `name_1`.
 */
export function sheetToObjects(sheet: Sheet): Record<string, CellValue>[] {
  const [header, ...body] = sheet.rows;
  if (!header) return [];
  const seen = new Map<string, number>();
  const keys = header.map((cell) => {
    const base = cell === null || cellToText(cell) === '' ? '__EMPTY' : cellToText(cell);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count}`;
  });

  const out: Record<string, CellValue>[] = [];
  for (const row of body) {
    const obj: Record<string, CellValue> = {};
    let any = false;
    row.forEach((value, i) => {
      if (value === null || i >= keys.length) return;
      obj[keys[i]] = value;
      any = true;
    });
    if (any) out.push(obj);
  }
  return out;
}

// --- Writing -----------------------------------------------------------------

function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

// Characters XML 1.0 forbids outright. One stray \x0B from a pasted cell makes
// Excel reject the whole file as corrupt.
const XML_ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

const MAX_CELL_CHARS = 32_767; // Excel's per-cell text limit

function cellXml(ref: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number' && Number.isFinite(value))
    return `<c r="${ref}"><v>${value}</v></c>`;
  if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  const str = (typeof value === 'object' ? JSON.stringify(value) : String(value))
    .replace(XML_ILLEGAL, '')
    .slice(0, MAX_CELL_CHARS);
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(str)}</t></is></c>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

// The minimum stylesheet Excel accepts without offering to "repair" the file.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/** One-sheet workbook from rows of plain values (strings, numbers, booleans; objects become JSON). */
export async function writeWorkbook(rows: unknown[][], sheetName = 'Sheet1'): Promise<Blob> {
  const sheetRows = rows
    .map((row, r) => {
      const cells = row.map((value, c) => cellXml(`${columnName(c)}${r + 1}`, value)).join('');
      return cells ? `<row r="${r + 1}">${cells}</row>` : '';
    })
    .join('');

  // Sheet names: max 31 chars, none of : \ / ? * [ ]
  const name = sheetName.replace(/[:\\/?*[\]]/g, '_').slice(0, 31) || 'Sheet1';

  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', ROOT_RELS);
  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapeXml(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  );
  zip.file('xl/_rels/workbook.xml.rels', WORKBOOK_RELS);
  zip.file('xl/styles.xml', STYLES);
  zip.file(
    'xl/worksheets/sheet1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
  );

  return zip.generateAsync({ type: 'blob', mimeType: XLSX_MIME, compression: 'DEFLATE' });
}
