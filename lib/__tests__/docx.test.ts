import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { docxToHtml, docxToTxt, mdToDocx, txtToDocx } from '@/lib/docx-converters';

// Writer output read back by mammoth, an independent DOCX reader: what Word
// structure we wrote is what a reader finds.

const MD = `# Quarterly report

Intro with **bold**, *italic*, \`code\` and a [link](https://example.com/a?b=1&c=2).

## Findings

- first point
- second point
  1. nested numbered
  2. and another
- third point

1. one
2. two

> A quoted line.

\`\`\`
const x = 1;
  indented()
\`\`\`

| Name | Qty |
| ---- | --- |
| widget | 3 |
| gadget | 12 |
`;

const md = (text: string, name = 'report.md') => new File([text], name);
const asFile = (blob: Blob, name = 'out.docx') => new File([blob], name);

async function html(markdown: string): Promise<string> {
  return (await docxToHtml(asFile(await mdToDocx(md(markdown))))).text();
}

describe('Markdown → DOCX, read back by mammoth', () => {
  it('headings, emphasis, code and links', async () => {
    const out = await html(MD);
    expect(out).toContain('<h1>Quarterly report</h1>');
    expect(out).toContain('<h2>Findings</h2>');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<em>italic</em>');
    expect(out).toContain(
      '<a href="https://example.com/a?b=1&amp;c=2" rel="noopener noreferrer">link</a>',
    );
  });

  it('bulleted, numbered and nested lists', async () => {
    const out = await html(MD);
    expect(out).toMatch(
      /<ul><li>first point<\/li><li>second point<ol><li>nested numbered<\/li><li>and another<\/li><\/ol><\/li><li>third point<\/li><\/ul>/,
    );
    expect(out).toContain('<ol><li>one</li><li>two</li></ol>');
  });

  it('tables keep their cells', async () => {
    const out = await html(MD);
    expect(out).toMatch(/<table>.*Name.*Qty.*widget.*3.*gadget.*12.*<\/table>/s);
  });

  it('a numbered list starting at 3 starts at 3', async () => {
    const blob = await mdToDocx(md('3. three\n4. four\n'));
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const numbering = await zip.file('word/numbering.xml')!.async('string');
    expect(numbering).toMatch(/<w:lvl w:ilvl="0"><w:start w:val="3"\/><w:numFmt w:val="decimal"/);
  });

  it('is a well-formed package: content types, relationships, parts', async () => {
    const zip = await JSZip.loadAsync(await (await mdToDocx(md(MD))).arrayBuffer());
    for (const part of [
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
      'word/styles.xml',
      'word/numbering.xml',
      'word/_rels/document.xml.rels',
      'docProps/core.xml',
    ]) {
      expect(zip.file(part), part).not.toBeNull();
      const text = await zip.file(part)!.async('string');
      const doc = new DOMParser().parseFromString(text, 'application/xml');
      expect(doc.getElementsByTagName('parsererror').length, part).toBe(0);
    }
    const rels = await zip.file('word/_rels/document.xml.rels')!.async('string');
    expect(rels).toContain('Target="https://example.com/a?b=1&amp;c=2" TargetMode="External"');
  });

  it('control characters XML forbids are dropped, not written', async () => {
    const out = await html('bell\u0007 and nul\u0000 gone');
    expect(out).toContain('bell and nul gone');
  });

  it('non-Latin text survives', async () => {
    const out = await html('# 報告\n\nΚαλημέρα, привет, 안녕하세요');
    expect(out).toContain('<h1>報告</h1>');
    expect(out).toContain('Καλημέρα, привет, 안녕하세요');
  });
});

describe('text → DOCX', () => {
  it('keeps every line and its indentation', async () => {
    const blob = await txtToDocx(new File(['line one\n    indented\n\nafter blank'], 'n.txt'));
    const text = await (await docxToTxt(asFile(blob))).text();
    expect(text).toContain('line one');
    expect(text).toContain('    indented');
    expect(text).toContain('after blank');
  });
});

describe('DOCX input', () => {
  it('DOCX → HTML is a full page titled after the file', async () => {
    const out = await (await docxToHtml(asFile(await mdToDocx(md('# Hi')), 'Minutes.docx'))).text();
    expect(out).toMatch(/^<!DOCTYPE html>/);
    expect(out).toContain('<title>Minutes</title>');
    expect(out).toContain('<meta charset="utf-8">');
  });

  it('a file that is not a .docx is reported as such', async () => {
    await expect(docxToHtml(new File(['PK not really'], 'x.docx'))).rejects.toMatchObject({
      code: 'corrupt-input',
      message: expect.stringMatching(/legacy \.doc/),
    });
  });
});

describe('schema element order (Word rejects files that break it)', () => {
  // Children of w:pPr and w:rPr in the order the OOXML schema requires,
  // limited to the elements the writer uses.
  const ORDER: Record<string, string[]> = {
    pPr: [
      'pStyle',
      'keepNext',
      'numPr',
      'pBdr',
      'shd',
      'spacing',
      'ind',
      'contextualSpacing',
      'outlineLvl',
    ],
    rPr: ['rStyle', 'rFonts', 'b', 'i', 'color', 'sz', 'u', 'shd', 'lang'],
  };

  it('every pPr and rPr lists its children in schema order', async () => {
    const zip = await JSZip.loadAsync(await (await mdToDocx(md(MD))).arrayBuffer());
    for (const part of ['word/document.xml', 'word/styles.xml', 'word/numbering.xml']) {
      const doc = new DOMParser().parseFromString(
        await zip.file(part)!.async('string'),
        'application/xml',
      );
      for (const [name, order] of Object.entries(ORDER)) {
        for (const el of Array.from(doc.getElementsByTagName(`w:${name}`))) {
          const children = Array.from(el.children).map((c) => c.localName);
          for (const child of children)
            expect(order, `${part} ${name} has ${child}`).toContain(child);
          const ranks = children.map((c) => order.indexOf(c));
          expect(ranks, `${part} ${name}: ${children.join(',')}`).toEqual(
            [...ranks].sort((a, b) => a - b),
          );
          expect(new Set(children).size, `${part} duplicate in ${name}`).toBe(children.length);
        }
      }
    }
  });
});

describe('a DOCX from another producer (python-docx, on Word’s default template)', () => {
  const sample = async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const bytes = readFileSync(join(__dirname, 'fixtures', 'python-docx-sample.docx'));
    return new File([bytes], 'notes.docx');
  };

  it('→ HTML keeps headings, emphasis, the list and the table', async () => {
    const out = await (await docxToHtml(await sample())).text();
    expect(out).toContain('<h1>Meeting notes</h1>');
    expect(out).toContain('<strong>ship it</strong>');
    expect(out).toContain('<em>Friday</em>');
    expect(out).toContain('<ul><li>Write the release notes</li><li>Tag the build</li></ul>');
    expect(out).toMatch(/<table>.*Owner.*Task.*Ana.*QA pass.*<\/table>/s);
    expect(out).toContain('日本語 · Ελληνικά');
  });

  it('→ Markdown and → text', async () => {
    const { docxToMd } = await import('@/lib/docx-converters');
    const markdown = await (await docxToMd(await sample())).text();
    expect(markdown).toMatch(/^# Meeting notes/m);
    expect(markdown).toContain('**ship it**');
    expect(markdown).toMatch(/^[-*]\s+Write the release notes/m);
    expect(markdown).toContain('| Owner | Task |\n| --- | --- |\n| Ana | QA pass |');
    const text = await (await docxToTxt(await sample())).text();
    expect(text).toContain('Meeting notes');
    expect(text).toContain('QA pass');
  });

  it('→ DOCX again: what we write reads back the same', async () => {
    const { docxToMd } = await import('@/lib/docx-converters');
    const markdown = await (await docxToMd(await sample())).text();
    const again = await (await docxToHtml(asFile(await mdToDocx(md(markdown))))).text();
    expect(again).toContain('<h1>Meeting notes</h1>');
    expect(again).toContain('<strong>ship it</strong>');
    expect(again).toMatch(/<table>.*Owner.*QA pass.*<\/table>/s);
  });
});
