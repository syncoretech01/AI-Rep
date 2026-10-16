import type { ComponentProps, ReactNode } from 'react';
import { cx } from './ui';

/** Labelled form controls. Hints and errors are announced with the control (aria-describedby). */

export const inputClass =
  'block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 shadow-xs placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 focus:outline-hidden disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-600 read-only:bg-slate-50 aria-[invalid=true]:border-red-500 sm:text-sm';

const checkboxClass =
  'size-4 shrink-0 rounded border-slate-300 text-indigo-600 accent-indigo-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed';

interface FieldMeta {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  errors?: readonly string[];
  /** Ids of other elements that describe the control (e.g. a character counter). */
  describedBy?: string;
}

function controlAria(id: string, { hint, errors = [], describedBy }: Omit<FieldMeta, 'id' | 'label'>) {
  const ids = [hint ? `${id}-hint` : null, errors.length > 0 ? `${id}-error` : null, describedBy ?? null].filter(
    (value) => value !== null,
  );
  return {
    'aria-invalid': errors.length > 0 ? true : undefined,
    'aria-describedby': ids.length > 0 ? ids.join(' ') : undefined,
  };
}

export function FieldErrorText({ id, errors }: { id: string; errors: readonly string[] }) {
  if (errors.length === 0) return null;
  return (
    <p id={id} className="mt-1 text-sm text-red-700">
      {errors.join(' ')}
    </p>
  );
}

function Field({ id, label, hint, errors = [], children }: Omit<FieldMeta, 'describedBy'> & { children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      {hint ? (
        <p id={`${id}-hint`} className="mt-0.5 text-xs text-slate-500">
          {hint}
        </p>
      ) : null}
      <div className="mt-1.5">{children}</div>
      <FieldErrorText id={`${id}-error`} errors={errors} />
    </div>
  );
}

type InputFieldProps = FieldMeta & Omit<ComponentProps<'input'>, 'id'>;

export function TextField({ id, label, hint, errors, describedBy, className, ...input }: InputFieldProps) {
  return (
    <Field id={id} label={label} hint={hint} errors={errors}>
      <input id={id} {...input} {...controlAria(id, { hint, errors, describedBy })} className={cx(inputClass, className)} />
    </Field>
  );
}

type TextAreaFieldProps = FieldMeta & Omit<ComponentProps<'textarea'>, 'id'>;

export function TextAreaField({ id, label, hint, errors, describedBy, className, ...textarea }: TextAreaFieldProps) {
  return (
    <Field id={id} label={label} hint={hint} errors={errors}>
      <textarea
        id={id}
        {...textarea}
        {...controlAria(id, { hint, errors, describedBy })}
        className={cx(inputClass, 'min-h-20 resize-y', className)}
      />
    </Field>
  );
}

type SelectFieldProps = FieldMeta & Omit<ComponentProps<'select'>, 'id'>;

export function SelectField({ id, label, hint, errors, describedBy, className, children, ...select }: SelectFieldProps) {
  return (
    <Field id={id} label={label} hint={hint} errors={errors}>
      <select id={id} {...select} {...controlAria(id, { hint, errors, describedBy })} className={cx(inputClass, className)}>
        {children}
      </select>
    </Field>
  );
}

type CheckboxFieldProps = { id: string; label: ReactNode; hint?: ReactNode } & Omit<ComponentProps<'input'>, 'id' | 'type'>;

export function CheckboxField({ id, label, hint, ...input }: CheckboxFieldProps) {
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        {...input}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className={cx(checkboxClass, 'mt-0.5')}
      />
      <div className="text-sm">
        <label htmlFor={id} className="font-medium text-slate-800">
          {label}
        </label>
        {hint ? (
          <p id={`${id}-hint`} className="text-xs text-slate-500">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}
