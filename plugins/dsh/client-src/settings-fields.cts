type ElementFactory = (...args: any[]) => any

export const avatarCropOutputSize = 64

export function scheduledSessionOptionLabel(
  session: { id: string; title: string; running: boolean },
  lastYutangSession = false,
) {
  return `${session.title} · ${session.id.slice(-8)}${lastYutangSession ? '（最近用过鱼塘）' : ''}${session.running ? '（运行中）' : ''}`
}

/** Visual field heading separated from its control so the heading does not activate/focus it. */
export function settingsField(createElement: ElementFactory, label: string, control: unknown, className = 'ytg-control') {
  return createElement('div', { className }, createElement('span', { className: 'ytg-help' }, label), control)
}

/** Prompt editor with a non-interactive heading and adjacent character count. */
export function settingsPromptField(createElement: ElementFactory, label: string, count: string, control: unknown) {
  return createElement('div', { className: 'ytg-prompt-field' },
    createElement('div', { className: 'ytg-prompt-field-head' }, createElement('span', null, label), createElement('span', { className: 'ytg-prompt-count' }, count)),
    control)
}

/** Keep checkbox activation scoped to its option label, outside its row heading and help text. */
export function settingsCheckboxField(
  createElement: ElementFactory,
  heading: string,
  input: unknown,
  option: string,
  help: string,
) {
  return createElement('div', { className: 'ytg-control ytg-control-checkbox' },
    createElement('span', { className: 'ytg-label' }, heading),
    createElement('span', { className: 'ytg-checkbox-content' },
      createElement('label', { className: 'ytg-checkbox-line' }, input, createElement('span', null, option)),
      createElement('span', { className: 'ytg-checkbox-help' }, help)))
}
