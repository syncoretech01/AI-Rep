'use client';

import { TextField } from './fields';
import { fieldErrors, type FormAction } from './form-state';
import { FormMessage } from './FormMessage';
import { SubmitButton } from './SubmitButton';
import { useActionForm } from './use-action-form';

export function OnboardingForm({ action }: { action: FormAction }) {
  const { state, pending, formRef, formProps } = useActionForm(action);
  return (
    <form ref={formRef} {...formProps} className="space-y-4">
      <TextField
        id="onboarding-name"
        name="name"
        label="Organization name"
        hint="Usually your business name. Visitors see it in your assistant's answers."
        autoComplete="organization"
        required
        maxLength={120}
        errors={fieldErrors(state, 'name')}
      />
      <TextField
        id="onboarding-agent-name"
        name="agentName"
        label="Assistant name (optional)"
        hint="Shown in the chat window. You can change it later."
        placeholder="Receptionist"
        maxLength={80}
        errors={fieldErrors(state, 'agentName')}
      />
      <FormMessage state={state} />
      <SubmitButton pending={pending} pendingLabel="Creating…" className="w-full">
        Create organization
      </SubmitButton>
    </form>
  );
}
