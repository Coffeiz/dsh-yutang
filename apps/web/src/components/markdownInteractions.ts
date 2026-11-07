const MIN_SCALE = 0.5;
const MAX_SCALE = 3;
const MAX_PREVIEW_SCALE = 8;
const MAX_SVG_BYTES = 1_000_000;
const MAX_PNG_BYTES = 8_000_000;
const MAX_PNG_PIXELS = 16_000_000;
const MAX_PNG_DIMENSION = 8192;

type MermaidBinding = { cleanup: () => void };
const bindings = new WeakMap<HTMLElement, MermaidBinding>();

function makeButton(action: string, label: string, iconName: string, text?: string) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'md-action-button';
  button.dataset.mermaidAction = action;
  button.title = label;
  button.setAttribute('aria-label', label);
  if (text) button.textContent = text;
  else {
    const icon = document.createElement('i');
    icon.className = iconName;
    icon.setAttribute('aria-hidden', 'true');
    button.append(icon);
  }
  return button;
}

function decodeSource(container: HTMLElement) {
  try { return decodeURIComponent(container.dataset.source || ''); }
  catch { return container.dataset.source || ''; }
}

async function svgToPngBlob(svg: SVGSVGElement) {
  const serialized = new XMLSerializer().serializeToString(svg);
  if (new Blob([serialized]).size > MAX_SVG_BYTES) throw new Error('png_too_large');
  for (const image of svg.querySelectorAll('image')) {
    const href = image.getAttribute('href') || image.getAttribute('xlink:href') || '';
    if (href && !href.startsWith('data:image/')) throw new Error('external_svg_resource');
  }

  const viewBox = svg.viewBox.baseVal;
  const sourceWidth = viewBox.width || Number.parseFloat(svg.getAttribute('width') || '');
  const sourceHeight = viewBox.height || Number.parseFloat(svg.getAttribute('height') || '');
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error('invalid_svg_size');
  }
  const scale = Math.min(
    2,
    MAX_PNG_DIMENSION / sourceWidth,
    MAX_PNG_DIMENSION / sourceHeight,
    Math.sqrt(MAX_PNG_PIXELS / (sourceWidth * sourceHeight)),
  );
  const width = Math.max(1, Math.floor(sourceWidth * scale));
  const height = Math.max(1, Math.floor(sourceHeight * scale));
  if (!Number.isFinite(scale) || scale <= 0 || width * height > MAX_PNG_PIXELS) throw new Error('png_too_large');

  const url = URL.createObjectURL(new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('svg_image_load_failed'));
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas_unavailable');
    context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--yt-md-mermaid-bg').trim() || '#171b23';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('png_encode_failed');
    if (blob.size > MAX_PNG_BYTES) throw new Error('png_too_large');
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function downloadPng(svg: SVGSVGElement) {
  const cleanSvg = svg.cloneNode(true) as SVGSVGElement;
  cleanSvg.removeAttribute('hidden');
  cleanSvg.style.removeProperty('transform');
  cleanSvg.style.removeProperty('transform-origin');
  cleanSvg.style.removeProperty('cursor');
  const blob = await svgToPngBlob(cleanSvg);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `mermaid-diagram-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function setSourceView(container: HTMLElement, show: boolean) {
  const svg = container.querySelector<SVGSVGElement>('svg');
  if (!svg) return;
  let sourceView = container.querySelector<HTMLElement>('.md-mermaid-source-view');
  if (!sourceView) {
    sourceView = document.createElement('pre');
    sourceView.className = 'md-mermaid-source-view';
    const code = document.createElement('code');
    code.textContent = decodeSource(container);
    sourceView.append(code);
    container.append(sourceView);
  }
  sourceView.hidden = !show;
  svg.toggleAttribute('hidden', show);
  container.classList.toggle('md-mermaid-show-source', show);
  const sourceButton = container.querySelector<HTMLButtonElement>('[data-mermaid-action="source"]');
  if (sourceButton) {
    sourceButton.title = show ? '查看图表' : '查看代码';
    sourceButton.setAttribute('aria-label', sourceButton.title);
    sourceButton.setAttribute('aria-pressed', String(show));
  }
}

function openPreview(sourceSvg: SVGSVGElement, source: string, onDownload: (svg: SVGSVGElement) => void) {
  const existing = document.querySelector<HTMLDialogElement>('.md-mermaid-dialog');
  if (existing) { existing.focus(); return () => {}; }
  const dialog = document.createElement('dialog');
  dialog.className = 'md-mermaid-dialog';
  dialog.setAttribute('aria-label', 'Mermaid 图表预览');
  const body = document.createElement('div');
  body.className = 'md-mermaid-dialog-body';
  const svg = sourceSvg.cloneNode(true) as SVGSVGElement;
  svg.removeAttribute('hidden');
  svg.style.removeProperty('display');
  svg.style.transform = '';
  svg.style.transformOrigin = '';
  svg.style.maxWidth = '100%';
  svg.style.maxHeight = '100%';
  body.append(svg);
  const sourceView = document.createElement('pre');
  sourceView.className = 'md-mermaid-source-view md-mermaid-preview-source';
  const code = document.createElement('code');
  code.textContent = source;
  sourceView.append(code);
  sourceView.hidden = true;
  body.append(sourceView);

  const toolbar = document.createElement('div');
  toolbar.className = 'md-chart-controls md-mermaid-preview-toolbar';
  const zoomLabel = makeButton('reset', '重置缩放', '', '100%');
  zoomLabel.className = 'md-action-button md-mermaid-zoom-label';
  const sourceButton = makeButton('source', '查看代码', 'ri-code-s-slash-line');
  const zoomOut = makeButton('zoom-out', '缩小', 'ri-zoom-out-line');
  const zoomIn = makeButton('zoom-in', '放大', 'ri-zoom-in-line');
  const download = makeButton('download', '下载 PNG', 'ri-download-2-line');
  const close = makeButton('close', '关闭', 'ri-close-line');
  const separator = () => {
    const element = document.createElement('span');
    element.className = 'md-toolbar-separator';
    element.setAttribute('aria-hidden', 'true');
    return element;
  };
  toolbar.append(sourceButton, separator(), zoomOut, zoomLabel, zoomIn, separator(), download, close);
  body.append(toolbar);
  dialog.append(body);

  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let sourceVisible = false;
  let drag: { x: number; y: number; offsetX: number; offsetY: number } | null = null;
  const update = () => {
    svg.toggleAttribute('hidden', sourceVisible);
    sourceView.hidden = !sourceVisible;
    svg.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
    svg.style.transformOrigin = 'center center';
    svg.style.cursor = drag ? 'grabbing' : 'grab';
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
    sourceButton.setAttribute('aria-pressed', String(sourceVisible));
    sourceButton.title = sourceVisible ? '查看图表' : '查看代码';
    sourceButton.setAttribute('aria-label', sourceButton.title);
  };
  const setScale = (next: number, anchorX = 0, anchorY = 0) => {
    const normalized = Math.min(MAX_PREVIEW_SCALE, Math.max(0.1, next));
    const ratio = normalized / scale;
    offsetX = Math.round((anchorX - (anchorX - offsetX) * ratio) * 1000) / 1000;
    offsetY = Math.round((anchorY - (anchorY - offsetY) * ratio) * 1000) / 1000;
    scale = normalized;
    update();
  };
  const onControl = (event: MouseEvent) => {
    const action = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-mermaid-action]')?.dataset.mermaidAction;
    if (!action) return;
    event.stopPropagation();
    if (action === 'zoom-in') setScale(scale * 1.25);
    else if (action === 'zoom-out') setScale(scale / 1.25);
    else if (action === 'reset') { scale = 1; offsetX = 0; offsetY = 0; update(); }
    else if (action === 'source') { sourceVisible = !sourceVisible; update(); }
    else if (action === 'download') onDownload(svg.cloneNode(true) as SVGSVGElement);
    else if (action === 'close') dialog.close();
  };
  const onDown = (event: PointerEvent) => {
    if (event.button !== 0 || (scale <= 1 && offsetX === 0 && offsetY === 0)
      || (event.target as HTMLElement).closest('.md-chart-controls, .md-mermaid-source-view')) return;
    event.preventDefault();
    drag = { x: event.clientX, y: event.clientY, offsetX, offsetY };
    body.setPointerCapture(event.pointerId);
    update();
  };
  const onMove = (event: PointerEvent) => {
    if (!drag) return;
    offsetX = drag.offsetX + event.clientX - drag.x;
    offsetY = drag.offsetY + event.clientY - drag.y;
    update();
  };
  const onUp = (event: PointerEvent) => {
    if (!drag) return;
    drag = null;
    if (body.hasPointerCapture(event.pointerId)) body.releasePointerCapture(event.pointerId);
    update();
  };
  const onWheel = (event: WheelEvent) => {
    if (sourceVisible) return;
    event.preventDefault();
    const rect = body.getBoundingClientRect();
    setScale(scale * (event.deltaY > 0 ? 0.9 : 1.1), event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2);
  };
  const closeDialog = () => {
    toolbar.removeEventListener('click', onControl);
    body.removeEventListener('pointerdown', onDown);
    body.removeEventListener('pointermove', onMove);
    body.removeEventListener('pointerup', onUp);
    body.removeEventListener('pointercancel', onUp);
    body.removeEventListener('wheel', onWheel);
    dialog.remove();
  };
  toolbar.addEventListener('click', onControl);
  body.addEventListener('pointerdown', onDown);
  body.addEventListener('pointermove', onMove);
  body.addEventListener('pointerup', onUp);
  body.addEventListener('pointercancel', onUp);
  body.addEventListener('wheel', onWheel, { passive: false });
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', closeDialog, { once: true });
  update();
  document.body.append(dialog);
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  close.focus();
  return () => { if (dialog.open) dialog.close(); else closeDialog(); };
}

export function bindMermaidControls(container: HTMLElement) {
  const existing = bindings.get(container);
  if (existing) return;
  const labels = { zoomOut: '缩小', zoomIn: '放大', reset: '重置', source: '查看代码', expand: '放大查看', download: '下载 PNG' };
  const controls = document.createElement('div');
  controls.className = 'md-chart-controls md-chart-controls--mermaid';
  controls.append(
    makeButton('zoom-out', labels.zoomOut, 'ri-zoom-out-line'),
    makeButton('zoom-in', labels.zoomIn, 'ri-zoom-in-line'),
    makeButton('reset', labels.reset, 'ri-restart-line'),
    makeButton('source', labels.source, 'ri-code-s-slash-line'),
    makeButton('expand', labels.expand, 'ri-fullscreen-line'),
    makeButton('download', labels.download, 'ri-download-2-line'),
  );
  container.append(controls);
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let dragging: { x: number; y: number; offsetX: number; offsetY: number } | null = null;
  let closePreview: (() => void) | null = null;
  const svg = () => container.querySelector<SVGSVGElement>('svg');
  const update = () => {
    const current = svg();
    if (!current) return;
    current.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
    current.style.transformOrigin = 'center center';
    current.style.cursor = dragging ? 'grabbing' : scale > 1 ? 'grab' : 'default';
    controls.querySelectorAll<HTMLButtonElement>('[data-mermaid-action]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.mermaidAction === 'source' && container.classList.contains('md-mermaid-show-source')));
    });
  };
  const onControl = (event: MouseEvent) => {
    const action = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-mermaid-action]')?.dataset.mermaidAction;
    if (!action) return;
    event.stopPropagation();
    if (action === 'zoom-out') scale = Math.max(MIN_SCALE, scale * 0.8);
    else if (action === 'zoom-in') scale = Math.min(MAX_SCALE, scale * 1.25);
    else if (action === 'reset') { scale = 1; offsetX = 0; offsetY = 0; }
    else if (action === 'source') setSourceView(container, !container.classList.contains('md-mermaid-show-source'));
    else if (action === 'expand') {
      const currentSvg = svg();
      if (currentSvg) closePreview = openPreview(currentSvg, decodeSource(container), async clone => {
        const status = container.querySelector<HTMLElement>('.md-mermaid-status') || document.createElement('span');
        status.className = 'md-mermaid-status';
        status.setAttribute('role', 'status');
        try { await downloadPng(clone); status.remove(); }
        catch (error) { status.textContent = error instanceof Error && error.message === 'png_too_large' ? '图表过大，无法导出' : '下载失败，请重试'; container.append(status); }
      });
    } else if (action === 'download') {
      const currentSvg = svg();
      if (currentSvg) void downloadPng(currentSvg).catch(error => {
        const status = container.querySelector<HTMLElement>('.md-mermaid-status') || document.createElement('span');
        status.className = 'md-mermaid-status';
        status.setAttribute('role', 'status');
        status.textContent = error instanceof Error && error.message === 'png_too_large' ? '图表过大，无法导出' : '下载失败，请重试';
        if (!status.isConnected) container.append(status);
      });
    }
    update();
  };
  const onDown = (event: PointerEvent) => {
    if (event.button !== 0 || scale <= 1 || (event.target as HTMLElement).closest('.md-chart-controls, .md-mermaid-source-view')) return;
    event.preventDefault();
    dragging = { x: event.clientX, y: event.clientY, offsetX, offsetY };
    container.setPointerCapture(event.pointerId);
    container.classList.add('md-mermaid-dragging');
  };
  const onMove = (event: PointerEvent) => {
    if (!dragging) return;
    offsetX = dragging.offsetX + event.clientX - dragging.x;
    offsetY = dragging.offsetY + event.clientY - dragging.y;
    update();
  };
  const onUp = (event: PointerEvent) => {
    if (!dragging) return;
    dragging = null;
    if (container.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId);
    container.classList.remove('md-mermaid-dragging');
    update();
  };
  const onDoubleClick = (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest('.md-chart-controls, .md-mermaid-source-view')) return;
    scale = 1;
    offsetX = 0;
    offsetY = 0;
    update();
  };
  controls.addEventListener('click', onControl);
  container.addEventListener('pointerdown', onDown);
  container.addEventListener('pointermove', onMove);
  container.addEventListener('pointerup', onUp);
  container.addEventListener('pointercancel', onUp);
  container.addEventListener('dblclick', onDoubleClick);
  update();
  bindings.set(container, { cleanup: () => {
    controls.removeEventListener('click', onControl);
    container.removeEventListener('pointerdown', onDown);
    container.removeEventListener('pointermove', onMove);
    container.removeEventListener('pointerup', onUp);
    container.removeEventListener('pointercancel', onUp);
    container.removeEventListener('dblclick', onDoubleClick);
    closePreview?.();
    controls.remove();
    container.querySelector('.md-mermaid-source-view')?.remove();
    container.classList.remove('md-mermaid-show-source', 'md-mermaid-dragging');
    const current = svg();
    if (current) {
      current.style.removeProperty('transform');
      current.style.removeProperty('transform-origin');
      current.style.removeProperty('cursor');
    }
    bindings.delete(container);
  } });
}

export function cleanupMermaidControl(container: HTMLElement) {
  bindings.get(container)?.cleanup();
}

export async function copyMarkdownCode(text: string) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* use the compatible selection fallback below */ }
  const input = document.createElement('textarea');
  input.value = text;
  input.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  document.body.append(input);
  input.select();
  const copied = document.execCommand('copy');
  input.remove();
  return copied;
}
