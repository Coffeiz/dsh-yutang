import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

export type SelectOption = { value: string; label: string };

export function SelectPopover({ value, options, onChange, label }: { value: string; options: SelectOption[]; onChange: (value: string) => void; label: string }) {
  const id = useId();
  const anchor = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(Math.max(0, options.findIndex(item => item.value === value)));
  const [style, setStyle] = useState<React.CSSProperties>({ position: 'fixed', visibility: 'hidden' });
  const selected = Math.max(0, options.findIndex(item => item.value === value));
  const position = () => {
    if (!anchor.current || !popup.current) return;
    const rect = anchor.current.getBoundingClientRect();
    const gap = 6;
    const width = Math.max(rect.width, popup.current.offsetWidth);
    const roomBelow = innerHeight - rect.bottom - gap * 2;
    const roomAbove = rect.top - gap * 2;
    const flip = roomBelow < Math.min(popup.current.scrollHeight, 240) && roomAbove > roomBelow;
    const maxHeight = Math.max(80, Math.min(240, flip ? roomAbove : roomBelow));
    const left = Math.max(gap, Math.min(rect.left, innerWidth - width - gap));
    setStyle({ position: 'fixed', zIndex: 1000, left, top: flip ? Math.max(gap, rect.top - Math.min(popup.current.scrollHeight, maxHeight) - gap) : rect.bottom + gap, width: Math.min(width, innerWidth - gap * 2), maxHeight, visibility: 'visible' });
  };
  useLayoutEffect(() => { if (open) { position(); popup.current?.querySelector<HTMLElement>(`#${CSS.escape(`${id}-option-${active}`)}`)?.scrollIntoView({ block: 'nearest' }); } }, [open, active, id]);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => { if (!anchor.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) setOpen(false); };
    const reposition = () => position();
    document.addEventListener('pointerdown', closeOutside);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => { document.removeEventListener('pointerdown', closeOutside); window.removeEventListener('resize', reposition); window.removeEventListener('scroll', reposition, true); };
  }, [open]);
  const choose = (index: number) => { onChange(options[index]!.value); setOpen(false); anchor.current?.querySelector('button')?.focus(); };
  const keydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); anchor.current?.querySelector('button')?.focus(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (!open) { setActive(selected); setOpen(true); } else setActive((active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length); return; }
    if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); setActive(event.key === 'Home' ? 0 : options.length - 1); setOpen(true); return; }
    if ((event.key === 'Enter' || event.key === ' ') && open) { event.preventDefault(); choose(active); }
  };
  return <div className="select-popover-anchor" ref={anchor} onKeyDown={keydown}>
    <button type="button" className="select-popover-trigger" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={id} onClick={() => { if (!open) setActive(selected); setOpen(!open); }}>
      <span className="select-popover-label">{label}</span><span>{options[selected]?.label}</span><svg className={`flip-chevron ${open ? 'is-open' : ''}`} viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5l3 3 3-3" /></svg>
    </button>
    {open && createPortal(<div id={id} className="select-popover-list" role="listbox" aria-label={label} ref={popup} style={style}>{options.map((option, index) => <button id={`${id}-option-${index}`} type="button" role="option" aria-selected={value === option.value} className={`select-popover-option ${active === index ? 'is-active' : ''}`} key={option.value} onMouseEnter={() => setActive(index)} onClick={() => choose(index)}>{option.label}{value === option.value && <span aria-hidden="true">✓</span>}</button>)}</div>, document.body)}
  </div>;
}
