import { marked } from 'marked';
import DOMPurify from 'dompurify';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }: { text: string; lang?: string }) {
      const language = (lang || '').trim().split(/\s+/)[0] || '';
      const langLabel = language ? `<span class="code-lang">${escapeHtml(language)}</span>` : '';
      const codeClass = language ? ` class="language-${escapeHtml(language)}"` : '';
      return `<div class="code-block"><div class="code-header">${langLabel}<button class="code-copy-btn" type="button" aria-label="Copy code">Copy</button></div><pre><code${codeClass}>${escapeHtml(text)}</code></pre></div>`;
    },
    link({ href, title, text }: { href: string; title?: string | null; text: string }) {
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      return `<a href="${escapeHtml(href)}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
  },
});

// Configure DOMPurify to ensure links have secure targets and rel attributes.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

/**
 * Parses markdown into sanitized HTML safe for rendering in chat bubbles.
 */
export function renderMarkdown(markdown: string): string {
  if (!markdown) return '';
  const rawHtml = marked.parse(markdown, { async: false }) as string;
  return DOMPurify.sanitize(rawHtml.trim(), {
    ADD_TAGS: ['button'],
    ADD_ATTR: ['target', 'rel', 'type', 'aria-label'],
  });
}

/**
 * Renders markdown directly into the target container element.
 */
export function renderMarkdownInto(container: HTMLElement, markdown: string): void {
  container.innerHTML = renderMarkdown(markdown);
}
