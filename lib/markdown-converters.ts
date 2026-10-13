import { marked } from 'marked';
import TurndownService from 'turndown';

import type { ConversionSettings } from './types';
import { htmlToPlainText } from './html-text';
import { escapeHtml } from './markup';
import { safeHtmlDocument } from './safe-html';

export function mdToHtml(
  file: File,
  _s: string,
  _t: string,
  _settings?: ConversionSettings,
): Promise<Blob> {
  return file.text().then(async (text) => {
    const htmlBody = await marked.parse(text);
    const html = safeHtmlDocument(file.name, htmlBody);
    return new Blob([html], { type: 'text/html' });
  });
}

/** HTML to Markdown with Turndown. Needs the DOM, so main thread only. */
export function htmlStringToMarkdown(html: string): string {
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  // Turndown has no table rule: every cell became its own paragraph. Tables
  // become GFM pipe tables instead (the first row is the header), cells
  // converted inline, with pipes escaped and line breaks as <br>.
  turndown.addRule('table', {
    filter: 'table',
    replacement: (_content, node) => {
      const rows = Array.from((node as HTMLTableElement).rows);
      if (!rows.length) return '';
      const cell = (el: Element) =>
        turndown
          .turndown(el.innerHTML)
          .replace(/ *\n+ */g, '<br>')
          .replace(/\|/g, '\\|')
          .trim() || ' ';
      const width = Math.max(...rows.map((r) => r.cells.length));
      const line = (cells: string[]) =>
        `| ${Array.from({ length: width }, (_, i) => cells[i] ?? ' ').join(' | ')} |`;
      const [head, ...body] = rows.map((r) => Array.from(r.cells).map(cell));
      return `\n\n${[line(head), line(Array(width).fill('---')), ...body.map(line)].join('\n')}\n\n`;
    },
  });
  return turndown.turndown(html);
}

export function htmlToMd(
  file: File,
  _s: string,
  _t: string,
  _settings?: ConversionSettings,
): Promise<Blob> {
  return file
    .text()
    .then((text) => new Blob([htmlStringToMarkdown(text)], { type: 'text/markdown' }));
}

export function htmlToTxt(
  file: File,
  _s: string,
  _t: string,
  _settings?: ConversionSettings,
): Promise<Blob> {
  return file.text().then((text) => {
    return new Blob([htmlToPlainText(text)], { type: 'text/plain' });
  });
}

export function txtToHtml(
  file: File,
  _s: string,
  _t: string,
  _settings?: ConversionSettings,
): Promise<Blob> {
  return file.text().then((text) => {
    const paragraphs = text
      .split('\n')
      .map((line) => `<p>${escapeHtml(line)}</p>`)
      .join('\n');
    const html = `<!DOCTYPE html>\n<html>\n<head>\n  <meta charset="utf-8">\n</head>\n<body>\n${paragraphs}\n</body>\n</html>`;
    return new Blob([html], { type: 'text/html' });
  });
}

export function txtToMd(
  file: File,
  _s: string,
  _t: string,
  _settings?: ConversionSettings,
): Promise<Blob> {
  return file.text().then((text) => {
    return new Blob([text], { type: 'text/markdown' });
  });
}

export function jsonToTxt(
  file: File,
  _s: string,
  _t: string,
  _settings?: ConversionSettings,
): Promise<Blob> {
  return file.text().then((text) => {
    const data = JSON.parse(text);
    return new Blob([JSON.stringify(data, null, 2)], { type: 'text/plain' });
  });
}

export async function jsonToMd(
  file: File,
  _s: string,
  _t: string,
  _settings?: ConversionSettings,
): Promise<Blob> {
  const text = await file.text();
  const data = JSON.parse(text);
  const arr = Array.isArray(data) ? data : [data];
  if (arr.length === 0) return new Blob([''], { type: 'text/markdown' });

  const headers = Object.keys(arr[0] as Record<string, unknown>);
  const headerRow = '| ' + headers.join(' | ') + ' |';
  const sepRow = '| ' + headers.map(() => '---').join(' | ') + ' |';
  const bodyRows = arr.map((row: Record<string, unknown>) => {
    return '| ' + headers.map((h) => String(row[h] ?? '')).join(' | ') + ' |';
  });

  const md = [headerRow, sepRow, ...bodyRows].join('\n');
  return new Blob([md], { type: 'text/markdown' });
}
