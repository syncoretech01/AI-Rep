'use client';

import { TextAreaField, TextField } from './fields';
import { fieldErrors, type FormAction } from './form-state';
import { FormMessage } from './FormMessage';
import { SubmitButton } from './SubmitButton';
import { useActionForm } from './use-action-form';

/** Empty strings for unset fields. */
export interface BusinessProfileValues {
  businessName: string;
  description: string;
  phone: string;
  email: string;
  website: string;
  address: string;
  serviceArea: string;
}

export function BusinessProfileForm({
  action,
  values,
  readOnly,
}: {
  action: FormAction;
  values: BusinessProfileValues;
  readOnly: boolean;
}) {
  const { state, pending, formRef, formProps } = useActionForm(action);
  return (
    <form ref={formRef} {...formProps} className="space-y-6">
      <fieldset disabled={readOnly} className="min-w-0 space-y-5">
        <legend className="sr-only">Business profile</legend>
        <TextField
          id="profile-business-name"
          name="businessName"
          label="Business name"
          defaultValue={values.businessName}
          maxLength={160}
          autoComplete="organization"
          errors={fieldErrors(state, 'businessName')}
        />
        <TextAreaField
          id="profile-description"
          name="description"
          label="Description"
          hint="One or two sentences about what the business does."
          defaultValue={values.description}
          rows={3}
          maxLength={1000}
          errors={fieldErrors(state, 'description')}
        />
        <div className="grid gap-5 sm:grid-cols-2">
          <TextField
            id="profile-phone"
            name="phone"
            type="tel"
            label="Phone"
            defaultValue={values.phone}
            maxLength={40}
            autoComplete="tel"
            errors={fieldErrors(state, 'phone')}
          />
          <TextField
            id="profile-email"
            name="email"
            type="email"
            label="Email"
            defaultValue={values.email}
            maxLength={254}
            autoComplete="email"
            errors={fieldErrors(state, 'email')}
          />
        </div>
        <TextField
          id="profile-website"
          name="website"
          type="url"
          label="Website"
          placeholder="https://example.com"
          defaultValue={values.website}
          maxLength={300}
          autoComplete="url"
          errors={fieldErrors(state, 'website')}
        />
        <div className="grid gap-5 sm:grid-cols-2">
          <TextAreaField
            id="profile-address"
            name="address"
            label="Address"
            defaultValue={values.address}
            rows={3}
            maxLength={500}
            errors={fieldErrors(state, 'address')}
          />
          <TextAreaField
            id="profile-service-area"
            name="serviceArea"
            label="Service area"
            hint="Where you work, e.g. Springfield and surrounding towns."
            defaultValue={values.serviceArea}
            rows={3}
            maxLength={500}
            errors={fieldErrors(state, 'serviceArea')}
          />
        </div>
      </fieldset>
      {readOnly ? null : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <SubmitButton pending={pending}>Save profile</SubmitButton>
          <FormMessage state={state} />
        </div>
      )}
    </form>
  );
}
