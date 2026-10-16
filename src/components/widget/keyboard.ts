/**
 * The chat widget's keyboard shortcuts. A keydown that belongs to an IME composition (Japanese, Chinese,
 * Korean input) is never a shortcut: there Enter confirms a conversion and Escape cancels one.
 */

type ShortcutEvent = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'isComposing' | 'keyCode'>;

/**
 * Safari fires `compositionend` before the keydown of the key that ends the composition, so
 * `isComposing` is already false on that keydown.
 */
function isComposing(event: ShortcutEvent): boolean {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- keyCode 229 is Safari's only marker for that keydown.
  return event.isComposing || event.keyCode === 229;
}

/** Enter sends the draft; Shift+Enter adds a line break. */
export function isSendShortcut(event: ShortcutEvent): boolean {
  return event.key === 'Enter' && !event.shiftKey && !isComposing(event);
}

/** Escape closes the embedded panel. */
export function isCloseShortcut(event: ShortcutEvent): boolean {
  return event.key === 'Escape' && !isComposing(event);
}
