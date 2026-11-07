import assert from 'node:assert/strict';
import { test } from 'node:test';
import { avatarCropOutputSize, scheduledSessionOptionLabel, settingsCheckboxField, settingsField, settingsPromptField } from '../client-src/settings-fields.cjs';

const createElement = (type: unknown, props: Record<string, unknown> | null, ...childNodes: unknown[]) => ({
  type,
  props: { ...props, children: childNodes },
});
type TestElement = { type: unknown; props: { children?: unknown } };
const isElement = (value: unknown): value is TestElement => Boolean(value && typeof value === 'object' && 'type' in value && 'props' in value);
const children = (element: { props: { children?: unknown } }): unknown[] => {
  const value = element.props.children;
  return Array.isArray(value) ? value : [value];
};

test('all settings field headings are separate from controls and cannot activate them as labels', () => {
  const cases = [
    settingsField(createElement, 'Text input', { type: 'input', props: { 'aria-label': 'Text input' } }),
    settingsField(createElement, 'Daily time', { type: 'input', props: { type: 'time', 'aria-label': 'Daily time' } }),
    settingsField(createElement, 'Select', { type: 'button', props: { 'aria-label': 'Select' } }),
    settingsPromptField(createElement, 'Agent personality', '0/12000', { type: 'textarea', props: { 'aria-label': 'Agent personality' } }),
    settingsPromptField(createElement, 'Knowledge', '0/20000', { type: 'textarea', props: { 'aria-label': 'Knowledge' } }),
  ];

  for (const field of cases) {
    assert.equal(field.type, 'div', 'field wrapper must not use native label activation');
    const [heading, control] = children(field as { props: { children?: unknown } });
    assert.ok(heading && typeof heading === 'object' && 'type' in heading && heading.type !== 'label');
    assert.ok(control && typeof control === 'object' && 'type' in control);
    assert.notEqual((control as { type: unknown }).type, 'label');
  }
});

test('checkbox activation is limited to its option label, not the whole settings row or help text', () => {
  const input = createElement('input', { type: 'checkbox' });
  const field = settingsCheckboxField(createElement, 'Background jury', input, 'Process assigned cases', 'Select a task session first.');
  const [heading, content] = children(field as { props: { children?: unknown } });

  assert.equal(field.type, 'div', 'settings row must not be a native label');
  assert.ok(heading && typeof heading === 'object' && 'type' in heading && heading.type !== 'label');
  assert.ok(content && typeof content === 'object' && 'type' in content && 'props' in content);
  const [optionLabel, help] = children(content as { props: { children?: unknown } });
  assert.ok(isElement(optionLabel) && optionLabel.type === 'label');
  const [labeledInput, optionText] = children(optionLabel);
  assert.equal(labeledInput, input);
  assert.ok(isElement(optionText) && optionText.type === 'span');
  assert.equal(children(optionText)[0], 'Process assigned cases');
  assert.ok(help && typeof help === 'object' && 'type' in help && help.type !== 'label');
  assert.equal(children(content as { props: { children?: unknown } })[1], help, 'help text must sit outside the clickable label');
});

test('scheduled session options label the DSH sidebar title without invalid timestamps', () => {
  const label = scheduledSessionOptionLabel({
    id: 'session_12345678',
    title: '侧栏会话标题',
    running: true,
  });

  assert.equal(label, '侧栏会话标题 · 12345678（运行中）');
  assert.equal(scheduledSessionOptionLabel({ id: 'session_12345678', title: '侧栏会话标题', running: false }, true), '侧栏会话标题 · 12345678（最近用过鱼塘）');
});

test('avatar crop output matches the 64 by 64 image contract', () => {
  assert.equal(avatarCropOutputSize, 64);
});
