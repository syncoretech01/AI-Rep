'use client';

import type { ChangeEvent } from 'react';
import { SelectField, TextAreaField, TextField } from './fields';
import { formatBytes } from './format';
import { fieldErrors, type FormAction, type FormState } from './form-state';
import { FormMessage } from './FormMessage';
import { SubmitButton } from './SubmitButton';
import { cx } from './ui';
import { useActionForm } from './use-action-form';

export interface AgentOption {
  id: string;
  name: string;
}

function ScopeField({ id, agents, state }: { id: string; agents: readonly AgentOption[]; state: FormState }) {
  return (
    <SelectField
      id={id}
      name="agentId"
      label="Used by"
      hint="Shared knowledge is available to every agent in the organization."
      defaultValue=""
      errors={fieldErrors(state, 'agentId')}
    >
      <option value="">All agents</option>
      {agents.map((agent) => (
        <option key={agent.id} value={agent.id}>
          {agent.name}
        </option>
      ))}
    </SelectField>
  );
}

/** Manual text: processed (chunked and embedded) while the request runs. */
export function AddTextSourceForm({
  action,
  agents,
  maxTextChars,
}: {
  action: FormAction;
  agents: readonly AgentOption[];
  maxTextChars: number;
}) {
  const { state, pending, formRef, formProps } = useActionForm(action, { resetOnSuccess: true });
  return (
    <form ref={formRef} {...formProps} className="space-y-4">
      <TextField
        id="knowledge-text-title"
        name="title"
        label="Title"
        placeholder="e.g. Services and pricing"
        required
        maxLength={200}
        errors={fieldErrors(state, 'title')}
      />
      <TextAreaField
        id="knowledge-text-body"
        name="text"
        label="Text"
        hint="Plain text or Markdown: services, prices, policies, FAQs. The assistant answers only from what you add."
        rows={10}
        required
        maxLength={maxTextChars}
        errors={fieldErrors(state, 'text')}
      />
      <ScopeField id="knowledge-text-scope" agents={agents} state={state} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <SubmitButton pending={pending} pendingLabel="Processing…">
          Add text
        </SubmitButton>
        <FormMessage state={state} />
      </div>
    </form>
  );
}

/** TXT/Markdown upload. Oversized files are stopped in the browser: they would exceed the request size limit. */
export function UploadSourceForm({
  action,
  agents,
  maxFileBytes,
  accept,
}: {
  action: FormAction;
  agents: readonly AgentOption[];
  maxFileBytes: number;
  /** Value of the file input's accept attribute, e.g. '.txt,.md,.markdown'. */
  accept: string;
}) {
  const { state, pending, formRef, formProps } = useActionForm(action, { resetOnSuccess: true });

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    const tooLarge = file !== undefined && file.size > maxFileBytes;
    event.target.setCustomValidity(tooLarge ? `The file is too large (maximum ${formatBytes(maxFileBytes)}).` : '');
    if (tooLarge) event.target.reportValidity();
  };

  return (
    <form ref={formRef} {...formProps} className="space-y-4">
      <TextField
        id="knowledge-file"
        name="file"
        type="file"
        label="File"
        hint={`A .txt or .md file up to ${formatBytes(maxFileBytes)}, saved as UTF-8 text.`}
        accept={accept}
        required
        onChange={onFileChange}
        errors={fieldErrors(state, 'file')}
        className="file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-800 hover:file:bg-slate-200"
      />
      <TextField
        id="knowledge-file-title"
        name="title"
        label="Title (optional)"
        hint="Defaults to the file name."
        maxLength={200}
        errors={fieldErrors(state, 'title')}
      />
      <ScopeField id="knowledge-file-scope" agents={agents} state={state} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <SubmitButton pending={pending} pendingLabel="Processing…">
          Upload file
        </SubmitButton>
        <FormMessage state={state} />
      </div>
    </form>
  );
}

const rowButton =
  'rounded-md px-2 py-1 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-60';

function RowMessage({ state }: { state: FormState }) {
  return (
    <span aria-live="polite" className="text-xs">
      {state.status === 'error' ? <span className="text-red-700">{state.message}</span> : null}
      {state.status === 'success' ? <span className="text-emerald-700">{state.message}</span> : null}
    </span>
  );
}

/** Retry (failed or interrupted processing) and delete for one knowledge source. */
export function KnowledgeSourceActions({
  title,
  retryAction,
  deleteAction,
}: {
  title: string;
  /** null when the source cannot be retried right now. */
  retryAction: FormAction | null;
  deleteAction: FormAction;
}) {
  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <div className="flex items-center gap-1">
        {retryAction ? <RetryButton action={retryAction} title={title} /> : null}
        <DeleteButton action={deleteAction} title={title} />
      </div>
    </div>
  );
}

function RetryButton({ action, title }: { action: FormAction; title: string }) {
  const { state, pending, formRef, formProps } = useActionForm(action);
  return (
    <form ref={formRef} {...formProps} className="flex flex-col items-end">
      <button
        type="submit"
        disabled={pending}
        className={cx(rowButton, 'text-indigo-700 hover:bg-indigo-50 focus-visible:outline-indigo-600')}
      >
        {pending ? 'Processing…' : 'Retry'}
        <span className="sr-only"> processing {title}</span>
      </button>
      <RowMessage state={state} />
    </form>
  );
}

function DeleteButton({ action, title }: { action: FormAction; title: string }) {
  const { state, pending, formRef, formProps } = useActionForm(action, {
    confirmMessage: `Delete "${title}"? The assistant will stop using it. This cannot be undone.`,
  });
  return (
    <form ref={formRef} {...formProps} className="flex flex-col items-end">
      <button
        type="submit"
        disabled={pending}
        className={cx(rowButton, 'text-red-700 hover:bg-red-50 focus-visible:outline-red-600')}
      >
        {pending ? 'Deleting…' : 'Delete'}
        <span className="sr-only"> {title}</span>
      </button>
      <RowMessage state={state} />
    </form>
  );
}
