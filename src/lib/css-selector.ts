/**
 * Test support: whether a browser could run a CSS selector at all.
 *
 * The catalogue's selectors (`site-rules.ts`, `extension-config.ts`) are run by
 * the extension against a real page, where one that does not parse makes
 * `querySelector` throw. The extension survives that — every lookup is in a
 * try/catch — but a selector that never runs is a rule that silently does
 * nothing, so the catalogue's tests refuse one before it ships.
 *
 * Not imported by the server: happy-dom is a development dependency, and the
 * packaged server is bundled from `src/index.ts`.
 */
import { Window } from "happy-dom";

const document = new Window().document;

export function isParsableSelector(selector: string): boolean {
  if (selector.trim().length === 0) {
    return false;
  }
  try {
    document.querySelector(selector);
    return true;
  } catch {
    return false;
  }
}
