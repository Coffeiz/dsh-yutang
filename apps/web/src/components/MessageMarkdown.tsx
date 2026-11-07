import { useEffect, useMemo, useRef } from 'react';
import DOMPurify from 'dompurify';
import { Marked, type Tokens } from 'marked';
import hljs from 'highlight.js/lib/common';
import { bindMermaidControls, cleanupMermaidControl, copyMarkdownCode } from './markdownInteractions';

const escaped: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => escaped[character]);
const designToken = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
const markdown = new Marked({ breaks: true, gfm: true });
const renderedMarkdownCache = new Map<string, string>();
const RENDERED_MARKDOWN_CACHE_LIMIT = 150;

function readRenderedMarkdown(key: string) {
  const cached = renderedMarkdownCache.get(key);
  if (cached === undefined) return undefined;
  renderedMarkdownCache.delete(key);
  renderedMarkdownCache.set(key, cached);
  return cached;
}

function saveRenderedMarkdown(key: string, markup: string) {
  renderedMarkdownCache.delete(key);
  renderedMarkdownCache.set(key, markup);
  while (renderedMarkdownCache.size > RENDERED_MARKDOWN_CACHE_LIMIT) {
    const oldest = renderedMarkdownCache.keys().next().value;
    if (oldest === undefined) break;
    renderedMarkdownCache.delete(oldest);
  }
}

markdown.use({
  renderer: {
    code(token: Tokens.Code) {
      const language = String(token.lang || '').trim().toLowerCase();
      if (language === 'mermaid') {
        return `<pre class="md-mermaid-source"><code>${escapeHtml(token.text)}</code></pre>`;
      }
      if (language === 'tex' || language === 'latex') {
        return `<div class="md-tex-source">${escapeHtml(`$$\n${token.text}\n$$`)}</div>`;
      }
      const selected = language && hljs.getLanguage(language) ? language : '';
      const autoDetected = !selected && token.text.length <= 32_000 ? hljs.highlightAuto(token.text) : null;
      const detectedLanguage = autoDetected?.language || '';
      const displayLanguage = selected || detectedLanguage || language || 'code';
      const highlighted = selected
        ? hljs.highlight(token.text, { language: selected }).value
        : autoDetected?.value ?? escapeHtml(token.text);
      const classLanguage = selected || detectedLanguage;
      return `<div class="md-code-block"><div class="md-code-header"><span class="md-code-lang">${escapeHtml(displayLanguage)}</span><button class="md-copy-btn" type="button" title="复制代码" aria-label="复制代码">复制</button></div><pre><code${classLanguage ? ` class="hljs language-${escapeHtml(classLanguage)}"` : ''}>${highlighted}</code></pre></div>`;
    },
  },
});

function normalizeMathSource(source: string) {
  let fence: { char: string; size: number } | null = null;
  let delimiter: '$' | '$$' | null = null;
  let normalized = '';
  source.split(/(?<=\n)/).forEach(line => {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) fence = { char: marker[0], size: marker.length };
      else if (marker[0] === fence.char && marker.length >= fence.size && !line.slice(fenceMatch[0].length).trim()) fence = null;
      normalized += line;
      return;
    }
    if (fence) {
      normalized += line;
      return;
    }
    const parts = line.split(/(`+[^`\n]*`+)/g);
    const displayContinues = delimiter === '$$';
    const value = parts.map((part, index) => {
      if (index % 2) return part;
      const text = part.replace(/\\\[/g, '$$').replace(/\\\]/g, '$$').replace(/\\\(/g, '$').replace(/\\\)/g, '$');
      let output = '';
      for (let cursor = 0; cursor < text.length;) {
        if (text[cursor] === '$') {
          const mark = text[cursor + 1] === '$' ? '$$' : '$';
          if (delimiter === mark) delimiter = null;
          else if (!delimiter) delimiter = mark;
          output += mark;
          cursor += mark.length;
        } else {
          output += delimiter && text[cursor] === '_' ? '&#95;' : text[cursor];
          cursor++;
        }
      }
      return output;
    }).join('');
    if (displayContinues && value) normalized = normalized.replace(/\r?\n$/, '') + ' ' + value;
    else normalized += value;
    if (delimiter === '$') delimiter = null;
  });
  return normalized;
}

function renderSafeMarkdown(source: string) {
  const rendered = markdown.parse(normalizeMathSource(source)) as string;
  const root = document.createElement('div');
  root.innerHTML = DOMPurify.sanitize(rendered, { ADD_ATTR: ['target'] });
  root.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(link => {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  });
  return root.innerHTML;
}

export function MessageMarkdown({ content, cacheKey }: { content: string; cacheKey?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const renderedKey = cacheKey ?? content;
  const html = useMemo(() => readRenderedMarkdown(renderedKey) ?? renderSafeMarkdown(content), [content, renderedKey]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let cancelled = false;
    let mermaidContainers: HTMLElement[] = [];
    const handleCodeCopy = async (event: MouseEvent) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.md-copy-btn');
      const code = button?.closest('.md-code-block')?.querySelector('code');
      if (!button || !code) return;
      button.disabled = true;
      const copied = await copyMarkdownCode(code.textContent || '');
      button.textContent = copied ? '已复制 ✓' : '复制失败';
      window.setTimeout(() => {
        if (button.isConnected) {
          button.textContent = '复制';
          button.disabled = false;
        }
      }, 1200);
    };
    root.addEventListener('click', handleCodeCopy);

    const cachedMarkup = readRenderedMarkdown(renderedKey);
    if (cachedMarkup !== undefined) {
      root.innerHTML = cachedMarkup;
      mermaidContainers = [...root.querySelectorAll<HTMLElement>('.md-mermaid')];
      for (const container of mermaidContainers) bindMermaidControls(container);
      return () => {
        root.removeEventListener('click', handleCodeCopy);
        for (const container of mermaidContainers) cleanupMermaidControl(container);
      };
    }

    void (async () => {
      const mermaidSources = [...root.querySelectorAll<HTMLElement>('.md-mermaid-source')];
      mermaidSources.forEach(sourceBlock => {
        const container = document.createElement('div');
        container.className = 'md-mermaid';
        container.dataset.source = encodeURIComponent(sourceBlock.textContent || '');
        sourceBlock.replaceWith(container);
      });
      const mermaidBlocks = [...root.querySelectorAll<HTMLElement>('.md-mermaid[data-source]')];
      mermaidContainers = mermaidBlocks;
      if (mermaidBlocks.length) {
        const { default: mermaid } = await import('mermaid');
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          look: 'classic',
          htmlLabels: false,
          themeVariables: {
            background: designToken('--yt-md-mermaid-bg', '#171b23'),
            primaryColor: designToken('--yt-bg-selected', '#283142'),
            primaryTextColor: designToken('--yt-md-mermaid-text', '#e5e8ef'),
            nodeTextColor: designToken('--yt-md-mermaid-text', '#e5e8ef'),
            textColor: designToken('--yt-md-mermaid-text', '#e5e8ef'),
            primaryBorderColor: designToken('--yt-md-mermaid-border', '#65789a'),
            lineColor: designToken('--yt-md-mermaid-line', '#aab2c2'),
            edgeLabelBackground: designToken('--yt-bg-raised', '#202631'),
            secondaryColor: designToken('--yt-success-soft', '#26342f'),
            tertiaryColor: designToken('--yt-surface-soft', '#3a3328'),
            fontFamily: designToken('--yt-font-sans', 'system-ui, sans-serif'),
          },
        });
        for (const [index, container] of mermaidBlocks.entries()) {
          const source = decodeURIComponent(container.dataset.source || '');
          try {
            const { svg } = await mermaid.render(`yutang-mermaid-${crypto.randomUUID()}-${index}`, source);
            if (cancelled || !container.isConnected) return;
            container.innerHTML = DOMPurify.sanitize(svg);
          } catch {
            if (!cancelled && container.isConnected) {
              container.classList.add('md-mermaid-error');
              container.textContent = `流程图渲染失败\n\n${source}`;
            }
          }
        }
      }

      const texSources = [...root.querySelectorAll<HTMLElement>('.md-tex-source')];
      const hasTexSources = texSources.length > 0;
      texSources.forEach(node => {
        const span = document.createElement('span');
        span.textContent = node.textContent || '';
        node.replaceWith(span);
      });
      if (hasTexSources || /\$\$[\s\S]+?\$\$|\$[^$\n]+\$|\\\[[\s\S]+?\\\]|\\\([^\n]+?\\\)/.test(root.textContent || '')) {
        const { default: renderMathInElement } = await import('katex/contrib/auto-render');
        await import('katex/dist/katex.min.css');
        if (!cancelled && root.isConnected) {
          renderMathInElement(root, {
            delimiters: [
              { left: '$$', right: '$$', display: true },
              { left: '\\[', right: '\\]', display: true },
              { left: '\\(', right: '\\)', display: false },
              { left: '$', right: '$', display: false },
            ],
            ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'option'],
            trust: false,
            throwOnError: false,
            maxExpand: 500,
            maxSize: 20,
          });
        }
      }
      if (cancelled || !root.isConnected) return;
      saveRenderedMarkdown(renderedKey, root.innerHTML);
      mermaidContainers = [...root.querySelectorAll<HTMLElement>('.md-mermaid')];
      for (const container of mermaidContainers) bindMermaidControls(container);
    })().catch(() => {});

    return () => {
      cancelled = true;
      root.removeEventListener('click', handleCodeCopy);
      for (const container of mermaidContainers) cleanupMermaidControl(container);
    };
  }, [html, renderedKey]);

  return <div ref={rootRef} className="message-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
