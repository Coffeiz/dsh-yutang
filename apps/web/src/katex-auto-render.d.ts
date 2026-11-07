declare module 'katex/contrib/auto-render' {
  type Delimiter = { left: string; right: string; display: boolean };
  type Options = {
    delimiters: Delimiter[];
    ignoredTags?: string[];
    trust?: boolean;
    throwOnError?: boolean;
    maxExpand?: number;
    maxSize?: number;
  };

  export default function renderMathInElement(element: HTMLElement, options?: Options): void;
}
