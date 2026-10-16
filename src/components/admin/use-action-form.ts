import { startTransition, useActionState, useEffect, useRef, type SubmitEvent } from 'react';
import { IDLE_FORM_STATE, type FormAction } from './form-state';

interface ActionFormOptions {
  /** Clear the inputs after a successful submission (forms that add records). */
  resetOnSuccess?: boolean;
  /** Ask for confirmation first (destructive actions). */
  confirmMessage?: string;
}

/**
 * useActionState for admin forms. Submissions are dispatched from onSubmit rather than run as React form
 * actions: React resets uncontrolled inputs after every form action, which would wipe what the user typed
 * whenever validation fails. `action` stays on the form so it also submits before hydration.
 */
export function useActionForm(action: FormAction, options: ActionFormOptions = {}) {
  const { resetOnSuccess = false, confirmMessage } = options;
  const [state, dispatch, pending] = useActionState(action, IDLE_FORM_STATE);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (resetOnSuccess && state.status === 'success') formRef.current?.reset();
  }, [resetOnSuccess, state]);

  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (confirmMessage !== undefined && !window.confirm(confirmMessage)) return;
    const formData = new FormData(event.currentTarget, event.submitter);
    startTransition(() => {
      dispatch(formData);
    });
  };

  return { state, pending, formRef, formProps: { action: dispatch, onSubmit } };
}
