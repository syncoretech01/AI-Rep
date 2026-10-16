'use client';

import { TextField } from './fields';
import { fieldErrors, type FormAction } from './form-state';
import { FormMessage } from './FormMessage';
import { SubmitButton } from './SubmitButton';
import { useActionForm } from './use-action-form';

interface AuthFormProps {
  action: FormAction;
  /** Safe path to continue to afterwards (validated by the page and again by the action). */
  next: string;
}

export function SignInForm({ action, next }: AuthFormProps) {
  const { state, pending, formRef, formProps } = useActionForm(action);
  return (
    <form ref={formRef} {...formProps} className="space-y-4">
      <input type="hidden" name="next" value={next} />
      <TextField
        id="sign-in-email"
        name="email"
        type="email"
        label="Email"
        autoComplete="email"
        required
        maxLength={254}
        errors={fieldErrors(state, 'email')}
      />
      <TextField
        id="sign-in-password"
        name="password"
        type="password"
        label="Password"
        autoComplete="current-password"
        required
        errors={fieldErrors(state, 'password')}
      />
      <FormMessage state={state} />
      <SubmitButton pending={pending} pendingLabel="Signing in…" className="w-full">
        Sign in
      </SubmitButton>
    </form>
  );
}

export function SignUpForm({ action, next }: AuthFormProps) {
  const { state, pending, formRef, formProps } = useActionForm(action);
  return (
    <form ref={formRef} {...formProps} className="space-y-4">
      <input type="hidden" name="next" value={next} />
      <TextField
        id="sign-up-email"
        name="email"
        type="email"
        label="Work email"
        autoComplete="email"
        required
        maxLength={254}
        errors={fieldErrors(state, 'email')}
      />
      <TextField
        id="sign-up-password"
        name="password"
        type="password"
        label="Password"
        hint="At least 8 characters."
        autoComplete="new-password"
        required
        minLength={8}
        maxLength={72}
        errors={fieldErrors(state, 'password')}
      />
      <FormMessage state={state} />
      <SubmitButton pending={pending} pendingLabel="Creating account…" className="w-full">
        Create account
      </SubmitButton>
    </form>
  );
}
