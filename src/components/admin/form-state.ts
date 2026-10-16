/**
 * Browser-side mirror of `ActionState` (src/server/admin/forms.ts): components never import server
 * modules. TypeScript keeps the two compatible wherever a page hands a Server Action to a form component.
 */
export type FormState =
  | { status: 'idle' }
  | { status: 'success'; message: string }
  | { status: 'error'; message: string; fieldErrors?: Record<string, string[]> };

export type FormAction = (state: FormState, formData: FormData) => Promise<FormState>;

export const IDLE_FORM_STATE: FormState = { status: 'idle' };

/** Key for errors that belong to no single field (FORM_ERROR_KEY on the server). */
export const FORM_ERROR_KEY = '_form';

/** Messages for one field, or for a group when `name` is a path prefix ('leadCapture' -> 'leadCapture.*'). */
export function fieldErrors(state: FormState, name: string): string[] {
  if (state.status !== 'error' || !state.fieldErrors) return [];
  const messages: string[] = [];
  for (const [key, list] of Object.entries(state.fieldErrors)) {
    if (key === name || key.startsWith(`${name}.`)) messages.push(...list);
  }
  return messages;
}
