import { FORM_ERROR_KEY, type FormState } from './form-state';
import { cx } from './ui';

/** Outcome of the last submission. The live region is always rendered so screen readers announce changes. */
export function FormMessage({ state, className }: { state: FormState; className?: string }) {
  const formErrors = state.status === 'error' ? (state.fieldErrors?.[FORM_ERROR_KEY] ?? []) : [];
  return (
    <div aria-live="polite" className={cx('min-w-0 text-sm', className)}>
      {state.status === 'success' ? <p className="font-medium text-emerald-700">{state.message}</p> : null}
      {state.status === 'error' ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-800">
          <p>{state.message}</p>
          {formErrors.length > 0 ? (
            <ul className="mt-1 list-disc pl-5">
              {formErrors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
