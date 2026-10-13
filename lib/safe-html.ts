// Downloadable HTML is opened outside this application's CSP. Sanitize the
// generated artifact itself; React's safe in-app text preview is not enough.
import sanitizeHtml from 'sanitize-html';
import { escapeHtml } from './markup';

const SAFE_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,/i;

export function safeHtmlBody(untrusted: string): string {
  return sanitizeHtml(untrusted, {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      'img',
      'h1',
      'h2',
      'table',
      'thead',
      'tbody',
      'tr',
      'td',
      'th',
      'del',
    ],
    allowedAttributes: {
      a: ['href', 'title', 'name', 'rel'],
      img: ['src', 'alt', 'width', 'height'],
      th: ['colspan', 'rowspan'],
      td: ['colspan', 'rowspan'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['data'] },
    allowProtocolRelative: false,
    // Never include user-supplied CSS, remote images, SVG, scripts or forms.
    nonTextTags: ['script', 'style', 'textarea', 'option', 'iframe', 'object', 'svg', 'math'],
    exclusiveFilter: (frame) => frame.tag === 'img' && !SAFE_IMAGE.test(frame.attribs.src ?? ''),
    transformTags: {
      a: (_name, attrs) => ({
        tagName: 'a',
        attribs: {
          ...attrs,
          rel: 'noopener noreferrer',
        },
      }),
    },
  });
}

export function safeHtmlDocument(title: string, untrustedBody: string): string {
  const body = safeHtmlBody(untrustedBody);
  // Works for downloaded file:// documents as well as hosted HTML. A hostile
  // document cannot undo a restrictive CSP meta by adding another policy.
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(title)}</title>
</head>
<body>
${body}
</body>
</html>`;
}
