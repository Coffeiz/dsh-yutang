import type { Settings } from './shared.cjs'

export function reconcileSettingsResponse(
  current: Settings,
  persistedBeforeSave: Settings,
  submitted: Settings,
  patch: Partial<Settings>,
  serverSettings: Settings,
): Settings {
  const patched = new Set(Object.keys(patch) as (keyof Settings)[])
  const next = { ...current }
  for (const key of Object.keys(serverSettings) as (keyof Settings)[]) {
    if (!Object.is(current[key], submitted[key])) continue
    if (patched.has(key) || Object.is(submitted[key], persistedBeforeSave[key])) Object.assign(next, { [key]: serverSettings[key] })
  }
  return next
}

export function rollbackSettingsPatch(
  current: Settings,
  persistedBeforeSave: Settings,
  submitted: Settings,
  patch: Partial<Settings>,
): Settings {
  const next = { ...current }
  for (const key of Object.keys(patch) as (keyof Settings)[]) {
    if (Object.is(current[key], submitted[key])) Object.assign(next, { [key]: persistedBeforeSave[key] })
  }
  return next
}
