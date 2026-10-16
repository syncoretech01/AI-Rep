'use client';

import { useState } from 'react';
import { FieldErrorText, inputClass } from './fields';
import { fieldErrors, type FormAction } from './form-state';
import { FormMessage } from './FormMessage';
import { SubmitButton } from './SubmitButton';
import { cx } from './ui';
import { useActionForm } from './use-action-form';

export interface HoursIntervalValue {
  /** 0 = Sunday … 6 = Saturday. */
  dayOfWeek: number;
  /** 'HH:MM'; closesAt may be '24:00'. */
  opensAt: string;
  closesAt: string;
}

interface Row {
  id: number;
  opensAt: string;
  closesAt: string;
}

interface EditorState {
  nextId: number;
  /** Rows per day, indexed by dayOfWeek. */
  days: Row[][];
}

/** Monday first, the way most businesses list their week. */
const DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

const smallButton =
  'rounded-md px-2 py-1 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600';

function toEditorState(intervals: readonly HoursIntervalValue[]): EditorState {
  const days: Row[][] = Array.from({ length: 7 }, () => []);
  let nextId = 0;
  for (const interval of intervals) {
    // <input type="time"> cannot show 24:00; a 00:00 closing time means midnight (see readBusinessHoursRows).
    const closesAt = interval.closesAt === '24:00' ? '00:00' : interval.closesAt;
    days[interval.dayOfWeek]?.push({ id: nextId, opensAt: interval.opensAt, closesAt });
    nextId += 1;
  }
  return { nextId, days };
}

/**
 * Weekly opening hours: each day is closed or has one or more intervals. Inputs are named
 * `day-<d>-open-<i>` / `day-<d>-close-<i>` (`i` = position within the day), the shape parseBusinessHoursForm reads.
 */
export function BusinessHoursEditor({
  action,
  intervals,
  timezone,
  dayNames,
  readOnly,
}: {
  action: FormAction;
  intervals: readonly HoursIntervalValue[];
  timezone: string;
  /** Indexed by dayOfWeek (0 = Sunday). */
  dayNames: readonly string[];
  readOnly: boolean;
}) {
  const { state, pending, formRef, formProps } = useActionForm(action);
  const [editor, setEditor] = useState(() => toEditorState(intervals));

  const addRow = (day: number) => {
    setEditor((current) => ({
      nextId: current.nextId + 1,
      days: current.days.map((rows, index) => {
        if (index !== day) return rows;
        // The first interval of a closed day starts from typical office hours.
        const row = rows.length === 0 ? { opensAt: '09:00', closesAt: '17:00' } : { opensAt: '', closesAt: '' };
        return [...rows, { id: current.nextId, ...row }];
      }),
    }));
  };

  const removeRow = (day: number, id: number) => {
    setEditor((current) => ({
      ...current,
      days: current.days.map((rows, index) => (index === day ? rows.filter((row) => row.id !== id) : rows)),
    }));
  };

  return (
    <form ref={formRef} {...formProps} className="space-y-5">
      <p className="text-sm text-slate-600">
        Times are in <span className="font-medium text-slate-900">{timezone}</span>, the assistant&apos;s time zone. A day
        without hours is closed. Use 00:00 as the closing time for midnight.
      </p>
      <fieldset disabled={readOnly} className="min-w-0">
        <legend className="sr-only">Opening hours per day</legend>
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200">
          {DISPLAY_ORDER.map((day) => {
            const dayName = dayNames[day] ?? `Day ${day}`;
            const rows = editor.days[day] ?? [];
            return (
              <li key={day} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:gap-4">
                <p className="shrink-0 text-sm font-medium text-slate-900 sm:w-28 sm:pt-2">{dayName}</p>
                <div className="min-w-0 flex-1 space-y-2">
                  {rows.length === 0 ? <p className="text-sm text-slate-500 sm:pt-2">Closed</p> : null}
                  {rows.map((row, index) => {
                    const openName = `day-${day}-open-${index}`;
                    const closeName = `day-${day}-close-${index}`;
                    const openErrors = fieldErrors(state, openName);
                    const closeErrors = fieldErrors(state, closeName);
                    return (
                      <div key={row.id}>
                        <div className="flex flex-wrap items-center gap-2">
                          <label htmlFor={openName} className="sr-only">
                            {dayName} opening time {index + 1}
                          </label>
                          <input
                            id={openName}
                            name={openName}
                            type="time"
                            defaultValue={row.opensAt}
                            aria-invalid={openErrors.length > 0 ? true : undefined}
                            aria-describedby={openErrors.length > 0 ? `${openName}-error` : undefined}
                            className={cx(inputClass, 'w-32')}
                          />
                          <span aria-hidden="true" className="text-sm text-slate-500">
                            to
                          </span>
                          <label htmlFor={closeName} className="sr-only">
                            {dayName} closing time {index + 1}
                          </label>
                          <input
                            id={closeName}
                            name={closeName}
                            type="time"
                            defaultValue={row.closesAt}
                            aria-invalid={closeErrors.length > 0 ? true : undefined}
                            aria-describedby={closeErrors.length > 0 ? `${closeName}-error` : undefined}
                            className={cx(inputClass, 'w-32')}
                          />
                          {readOnly ? null : (
                            <button
                              type="button"
                              onClick={() => removeRow(day, row.id)}
                              className={cx(smallButton, 'text-slate-600 hover:bg-slate-100 hover:text-slate-900')}
                            >
                              Remove<span className="sr-only"> {dayName} interval {index + 1}</span>
                            </button>
                          )}
                        </div>
                        <FieldErrorText id={`${openName}-error`} errors={openErrors} />
                        <FieldErrorText id={`${closeName}-error`} errors={closeErrors} />
                      </div>
                    );
                  })}
                  <FieldErrorText id={`day-${day}-error`} errors={fieldErrors(state, `day-${day}`)} />
                  {readOnly ? null : (
                    <button
                      type="button"
                      onClick={() => addRow(day)}
                      className={cx(smallButton, '-ml-2 text-indigo-700 hover:bg-indigo-50')}
                    >
                      {rows.length === 0 ? 'Add hours' : 'Add interval'}
                      <span className="sr-only"> for {dayName}</span>
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </fieldset>
      {readOnly ? null : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <SubmitButton pending={pending}>Save hours</SubmitButton>
          <FormMessage state={state} />
        </div>
      )}
    </form>
  );
}
