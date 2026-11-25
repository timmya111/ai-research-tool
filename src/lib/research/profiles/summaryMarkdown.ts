/**
 * Markdown → sanitized HTML for profile overview summaries.
 * Uses marked for structure and isomorphic-dompurify against XSS.
 */
import DOMPurify from 'isomorphic-dompurify';
import { marked, Renderer, type Tokens } from 'marked';

const renderer = new Renderer();

renderer.strong = function strong(this: Renderer, { tokens }: Tokens.Strong) {
	const inner = tokens?.length ? this.parser.parseInline(tokens) : '';
	return `<strong class="font-bold text-white">${inner}</strong>`;
};

renderer.em = function em(this: Renderer, { tokens }: Tokens.Em) {
	const inner = tokens?.length ? this.parser.parseInline(tokens) : '';
	return `<em class="italic text-white/95">${inner}</em>`;
};

renderer.link = function link(this: Renderer, { href, title, tokens }: Tokens.Link) {
	const inner = tokens?.length ? this.parser.parseInline(tokens) : '';
	const safeHref = String(href || '').trim();
	if (!/^https?:\/\//i.test(safeHref) && !safeHref.startsWith('/') && !safeHref.startsWith('#')) {
		return inner;
	}
	const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
	return `<a href="${escapeAttr(safeHref)}" target="_blank" rel="noreferrer" class="break-all text-sky-300 underline"${titleAttr}>${inner}</a>`;
};

renderer.paragraph = function paragraph(this: Renderer, { tokens }: Tokens.Paragraph) {
	const inner = tokens?.length ? this.parser.parseInline(tokens) : '';
	return `<p class="m-0 text-[12px] leading-relaxed text-white">${inner}</p>`;
};

renderer.list = function list(this: Renderer, token: Tokens.List) {
	const body = token.items.map((item) => this.listitem(item)).join('');
	const tag = token.ordered ? 'ol' : 'ul';
	return `<${tag} class="m-0 list-disc space-y-1 pl-4 text-[12px] text-white/90">${body}</${tag}>`;
};

renderer.listitem = function listitem(this: Renderer, item: Tokens.ListItem) {
	const inner = item.tokens?.length ? this.parser.parse(item.tokens) : '';
	return `<li class="leading-snug">${inner.replace(/^<p class="[^"]*">/, '').replace(/<\/p>$/, '')}</li>`;
};

renderer.codespan = ({ text }: Tokens.Codespan) =>
	`<code class="rounded bg-white/10 px-1 py-0.5 font-mono text-[11px] text-sky-200">${escapeHtml(text)}</code>`;

renderer.code = ({ text }: Tokens.Code) =>
	`<pre class="m-0 whitespace-pre rounded border border-white/10 bg-black/35 p-2.5 font-mono text-[11px] leading-snug text-sky-100/95"><code class="font-mono text-[11px] text-sky-100/95">${escapeHtml(text)}</code></pre>`;

marked.use({
	renderer,
	gfm: true,
	breaks: false,
});

const ALLOWED_TAGS = [
	'p',
	'br',
	'strong',
	'em',
	'b',
	'i',
	'a',
	'ul',
	'ol',
	'li',
	'code',
	'pre',
	'span',
	'h1',
	'h2',
	'h3',
	'h4',
];
const ALLOWED_ATTR = ['href', 'title', 'target', 'rel', 'class'];

function escapeHtml(s: string): string {
	return String(s || '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function escapeAttr(s: string): string {
	return escapeHtml(s).replace(/'/g, '&#39;');
}

export function summaryMarkdownToHtml(markdown: string, { inline = false }: { inline?: boolean } = {}): string {
	const src = String(markdown || '').trim();
	if (!src) return '';
	const raw = inline ? marked.parseInline(src, { async: false }) : marked.parse(src, { async: false });
	return DOMPurify.sanitize(String(raw || ''), {
		ALLOWED_TAGS,
		ALLOWED_ATTR,
		ALLOW_DATA_ATTR: false,
	});
}
