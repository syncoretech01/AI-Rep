'use client';

import { useState } from 'react';
import { CheckboxField, FieldErrorText, SelectField, TextAreaField, TextField } from './fields';
import { capitalize } from './format';
import { fieldErrors, type FormAction } from './form-state';
import { FormMessage } from './FormMessage';
import { SubmitButton } from './SubmitButton';
import { useActionForm } from './use-action-form';

export interface AgentSettingsValues {
  name: string;
  status: string;
  greeting: string;
  language: string;
  timezone: string;
  instructions: string;
  leadCaptureEnabled: boolean;
  requiredFields: readonly string[];
}

const STATUS_LABELS: Readonly<Record<string, string>> = {
  active: 'Active: answers visitors',
  paused: 'Paused: the chat shows as unavailable',
};

/** Field names follow the agent settings schema paths (see parseAgentSettingsForm). */
export function AgentSettingsForm({
  action,
  values,
  statuses,
  leadFields,
  timeZones,
  instructionsMaxLength,
  readOnly,
}: {
  action: FormAction;
  values: AgentSettingsValues;
  statuses: readonly string[];
  leadFields: readonly string[];
  timeZones: readonly string[];
  instructionsMaxLength: number;
  readOnly: boolean;
}) {
  const { state, pending, formRef, formProps } = useActionForm(action);
  const [instructionsLength, setInstructionsLength] = useState(values.instructions.length);
  const leadErrors = fieldErrors(state, 'leadCapture');

  return (
    <form ref={formRef} {...formProps} className="space-y-6">
      <fieldset disabled={readOnly} className="min-w-0 space-y-5">
        <legend className="sr-only">Assistant settings</legend>
        <div className="grid gap-5 sm:grid-cols-2">
          <TextField
            id="agent-name"
            name="name"
            label="Assistant name"
            defaultValue={values.name}
            required
            maxLength={80}
            errors={fieldErrors(state, 'name')}
          />
          <SelectField
            id="agent-status"
            name="status"
            label="Status"
            defaultValue={values.status}
            errors={fieldErrors(state, 'status')}
          >
            {statuses.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status] ?? capitalize(status)}
              </option>
            ))}
          </SelectField>
        </div>

        <TextAreaField
          id="agent-greeting"
          name="greeting"
          label="Greeting"
          hint="The first message visitors see when they open the chat."
          defaultValue={values.greeting}
          rows={2}
          required
          maxLength={500}
          errors={fieldErrors(state, 'greeting')}
        />

        <div className="grid gap-5 sm:grid-cols-2">
          <TextField
            id="agent-language"
            name="language"
            label="Language"
            hint="Language code the assistant replies in, e.g. en or en-US."
            defaultValue={values.language}
            required
            maxLength={35}
            autoComplete="off"
            spellCheck={false}
            errors={fieldErrors(state, 'language')}
          />
          <TextField
            id="agent-timezone"
            name="timezone"
            label="Time zone"
            hint="Used for business hours, e.g. America/New_York."
            defaultValue={values.timezone}
            list="agent-timezones"
            required
            maxLength={64}
            autoComplete="off"
            spellCheck={false}
            errors={fieldErrors(state, 'timezone')}
          />
          <datalist id="agent-timezones">
            {timeZones.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
        </div>

        <div>
          <TextAreaField
            id="agent-instructions"
            name="instructions"
            label="Instructions"
            hint="Short guidance on tone and what to focus on. Business facts belong in the business profile and knowledge."
            defaultValue={values.instructions}
            rows={6}
            maxLength={instructionsMaxLength}
            describedBy="agent-instructions-count"
            onChange={(event) => setInstructionsLength(event.target.value.length)}
            errors={fieldErrors(state, 'instructions')}
          />
          <p id="agent-instructions-count" className="mt-1 text-right text-xs text-slate-500">
            {instructionsLength.toLocaleString('en-US')} / {instructionsMaxLength.toLocaleString('en-US')} characters
          </p>
        </div>

        <fieldset className="min-w-0 rounded-lg border border-slate-200 px-4 pt-2 pb-4">
          <legend className="px-1 text-sm font-semibold text-slate-900">Lead capture</legend>
          <div className="space-y-4">
            <CheckboxField
              id="agent-lead-capture"
              name="leadCapture.enabled"
              label="Collect contact details from visitors"
              hint="The assistant offers to take details so your team can follow up."
              defaultChecked={values.leadCaptureEnabled}
            />
            <div
              role="group"
              aria-labelledby="agent-required-fields-label"
              aria-describedby={
                leadErrors.length > 0
                  ? 'agent-required-fields-hint agent-required-fields-error'
                  : 'agent-required-fields-hint'
              }
            >
              <p id="agent-required-fields-label" className="text-sm font-medium text-slate-800">
                Details to ask for before saving a lead
              </p>
              <p id="agent-required-fields-hint" className="text-xs text-slate-500">
                A phone number or an email address is always required.
              </p>
              <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
                {leadFields.map((field) => (
                  <CheckboxField
                    key={field}
                    id={`agent-required-${field}`}
                    name="leadCapture.requiredFields"
                    value={field}
                    label={capitalize(field)}
                    defaultChecked={values.requiredFields.includes(field)}
                  />
                ))}
              </div>
              <FieldErrorText id="agent-required-fields-error" errors={leadErrors} />
            </div>
          </div>
        </fieldset>
      </fieldset>

      {readOnly ? null : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <SubmitButton pending={pending}>Save settings</SubmitButton>
          <FormMessage state={state} />
        </div>
      )}
    </form>
  );
}
