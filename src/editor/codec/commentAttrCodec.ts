/**
 * Codec utilities for encoding and decoding inline comment attributes inside
 * `<span data-comment="..." data-id="..." data-time="...">...</span>` in Markdown.
 *
 * Keeps all CJK and UTF-8 prose directly readable on disk for external AI Agents
 * and Source Mode while escaping HTML delimiters, GFM table pipes (`|`), and newlines.
 */

const UNESCAPE_ENTITY_RE =
  /&(?:(amp)|(quot)|#34|#x22|(apos)|#39|#x27|(lt)|#60|#x3c|(gt)|#62|#x3e|#124|#x7c|#10|#x0*a|#38|#x26);/gi;

export function escapeCommentAttr(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '&#124;')
    .replace(/\r\n|\r|\n/g, '&#10;');
}

export function unescapeCommentAttr(encoded: string): string {
  if (!encoded) return '';
  return encoded.replace(UNESCAPE_ENTITY_RE, (full) => {
    const lower = full.toLowerCase();
    switch (lower) {
      case '&#10;':
      case '&#x0a;':
      case '&#xa;':
        return '\n';
      case '&#124;':
      case '&#x7c;':
        return '|';
      case '&quot;':
      case '&#34;':
      case '&#x22;':
        return '"';
      case '&apos;':
      case '&#39;':
      case '&#x27;':
        return "'";
      case '&lt;':
      case '&#60;':
      case '&#x3c;':
        return '<';
      case '&gt;':
      case '&#62;':
      case '&#x3e;':
        return '>';
      case '&amp;':
      case '&#38;':
      case '&#x26;':
        return '&';
      default:
        if (/^&#x0*a;$/i.test(lower)) {
          return '\n';
        }
        return full;
    }
  });
}
