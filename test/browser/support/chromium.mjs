import { chromium } from '@playwright/test';

/** CI uses its pinned browser; a Pi proof may use the installed Chromium. */
export function launchChromium(options = {}) {
  return chromium.launch({
    channel: 'chromium',
    ...options,
    ...(process.env.RELAY_BROWSER_EXECUTABLE ? { executablePath: process.env.RELAY_BROWSER_EXECUTABLE } : {}),
  });
}
