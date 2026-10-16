'use client';

import { TextField } from './fields';
import { fieldErrors, type FormAction } from './form-state';
import { FormMessage } from './FormMessage';
import { SubmitButton } from './SubmitButton';
import { useActionForm } from './use-action-form';

/** Creates an agent and opens its settings (the action redirects on success). */
export function NewAgentForm({ action }: { action: FormAction }) {
  const { state, pending, formRef, formProps } = useActionForm(action);
  return (
    <form ref={formRef} {...formProps} className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <TextField
            id="new-agent-name"
            name="name"
            label="Assistant name"
            placeholder="e.g. After-hours receptionist"
            required
            maxLength={80}
            errors={fieldErrors(state, 'name')}
          />
        </div>
        <SubmitButton pending={pending} pendingLabel="Creating…" className="sm:mb-px">
          Create agent
        </SubmitButton>
      </div>
      <FormMessage state={state} />
    </form>
  );
}
