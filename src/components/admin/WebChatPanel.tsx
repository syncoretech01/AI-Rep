'use client';

import Link from 'next/link';
import { useState } from 'react';
import { inputClass } from './fields';
import type { FormAction } from './form-state';
import { FormMessage } from './FormMessage';
import { SubmitButton } from './SubmitButton';
import { Badge, buttonClass, cx, linkClass } from './ui';
import { useActionForm } from './use-action-form';

const ROTATE_CONFIRMATION =
  'Issue a new widget key? On websites using the current embed code, the chat shows as unavailable until you update the code.';

function CopyButton({ text, label }: { text: string; label: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus('copied');
    } catch {
      // Clipboard access needs a secure context and permission.
      setStatus('failed');
    }
    setTimeout(() => setStatus('idle'), 2500);
  };

  return (
    <>
      <button type="button" onClick={() => void copy()} className={buttonClass('secondary')}>
        {status === 'copied' ? 'Copied' : label}
      </button>
      <span aria-live="polite" className={status === 'failed' ? 'text-sm text-red-700' : 'sr-only'}>
        {status === 'copied' ? 'Copied to the clipboard.' : null}
        {status === 'failed' ? 'Copying failed. Select the code and copy it manually.' : null}
      </span>
    </>
  );
}

function PublishForm({ enabled, action }: { enabled: boolean; action: FormAction }) {
  const { state, pending, formRef, formProps } = useActionForm(action);
  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <form ref={formRef} {...formProps}>
        <input type="hidden" name="enabled" value={enabled ? 'false' : 'true'} />
        <SubmitButton
          pending={pending}
          pendingLabel={enabled ? 'Unpublishing…' : 'Publishing…'}
          variant={enabled ? 'secondary' : 'primary'}
        >
          {enabled ? 'Unpublish web chat' : 'Publish web chat'}
        </SubmitButton>
      </form>
      <FormMessage state={state} className="sm:text-right" />
    </div>
  );
}

function RotateKeyForm({ action }: { action: FormAction }) {
  const { state, pending, formRef, formProps } = useActionForm(action, { confirmMessage: ROTATE_CONFIRMATION });
  return (
    <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
      <form ref={formRef} {...formProps} className="shrink-0">
        <SubmitButton pending={pending} pendingLabel="Rotating…" variant="danger">
          Rotate key
        </SubmitButton>
      </form>
      <FormMessage state={state} />
    </div>
  );
}

/** Publishing state, widget key and embed code of an agent's web chat. */
export function WebChatPanel({
  enabled,
  widgetKey,
  origin,
  agentActive,
  readOnly,
  toggleAction,
  rotateAction,
}: {
  enabled: boolean;
  /** null when the agent has no web chat channel yet (publishing creates it). */
  widgetKey: string | null;
  /** Public origin of this app, e.g. https://app.example.com; null when it cannot be determined. */
  origin: string | null;
  agentActive: boolean;
  readOnly: boolean;
  toggleAction: FormAction;
  rotateAction: FormAction;
}) {
  const snippet =
    origin && widgetKey ? `<script src="${origin}/embed.js" data-widget-key="${widgetKey}" async></script>` : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-wrap items-center gap-2 text-sm text-slate-700 sm:pt-2">
          <span>Status:</span>
          {enabled ? <Badge tone="success">Published</Badge> : <Badge>Not published</Badge>}
        </div>
        {readOnly ? null : <PublishForm enabled={enabled} action={toggleAction} />}
      </div>

      {enabled && !agentActive ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          This assistant is paused, so visitors see the chat as unavailable. Set its status to Active in Settings.
        </p>
      ) : null}

      {widgetKey === null ? (
        <p className="text-sm text-slate-600">
          Web chat has not been set up for this assistant yet.
          {readOnly ? null : ' Publishing it creates the widget key and embed code.'}
        </p>
      ) : (
        <>
          <div>
            <label htmlFor="widget-key" className="block text-sm font-medium text-slate-800">
              Widget key
            </label>
            <p id="widget-key-hint" className="mt-0.5 text-xs text-slate-500">
              Identifies this assistant on your website. It is not a secret.
            </p>
            <input
              id="widget-key"
              readOnly
              value={widgetKey}
              aria-describedby="widget-key-hint"
              className={cx(inputClass, 'mt-1.5 font-mono')}
            />
            {readOnly ? null : <RotateKeyForm action={rotateAction} />}
          </div>

          <div>
            <p id="embed-code-label" className="text-sm font-medium text-slate-800">
              Embed code
            </p>
            <p className="mt-0.5 text-xs text-slate-500">
              Paste it before the closing &lt;/body&gt; tag of every page that should show the chat.
            </p>
            {snippet ? (
              <pre
                aria-labelledby="embed-code-label"
                className="mt-1.5 overflow-x-auto rounded-lg bg-slate-900 px-3 py-3 font-mono text-xs leading-relaxed text-slate-100"
              >
                <code>{snippet}</code>
              </pre>
            ) : (
              <p className="mt-1.5 text-sm text-slate-600">
                The embed code is unavailable because this app&apos;s web address could not be determined from the
                request.
              </p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-3">
              {snippet ? <CopyButton text={snippet} label="Copy embed code" /> : null}
              <Link
                href={`/widget/${widgetKey}`}
                target="_blank"
                rel="noopener noreferrer"
                prefetch={false}
                className={cx(linkClass, 'text-sm')}
              >
                Open preview<span className="sr-only"> (opens in a new tab)</span>
              </Link>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              The preview works while web chat is published and the assistant is active. Its conversations appear under
              Conversations.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
