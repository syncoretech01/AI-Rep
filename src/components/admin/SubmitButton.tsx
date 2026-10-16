import type { ReactNode } from 'react';
import { buttonClass, type ButtonVariant } from './ui';

/** Disabled while its form's action runs, so a double click cannot submit twice. */
export function SubmitButton({
  pending,
  pendingLabel = 'Saving…',
  variant = 'primary',
  className,
  children,
}: {
  pending: boolean;
  pendingLabel?: string;
  variant?: ButtonVariant;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button type="submit" disabled={pending} className={buttonClass(variant, className)}>
      {pending ? pendingLabel : children}
    </button>
  );
}
