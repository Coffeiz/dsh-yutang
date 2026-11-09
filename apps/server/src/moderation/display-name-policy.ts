import { ApiError } from '../errors.js';
import { scanDisplayName } from './content-risk.js';

export function assertDisplayNameAllowed(displayName: string) {
  const signals = scanDisplayName(displayName);
  if (!signals.length) return;

  throw new ApiError(
    422,
    'DISPLAY_NAME_CONTAINS_PROHIBITED_CONTENT',
    'Display name contains content that is not allowed by the community policy',
  );
}
