import React from 'react';
import { ListFilter } from 'lucide-react';

interface StatusFilterOption<T extends string> {
  value: T;
  label: string;
}

interface StatusFilterProps<T extends string> {
  value: T;
  options: StatusFilterOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
}

/** A consistent, compact status picker for table and list toolbars. */
export default function StatusFilter<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: StatusFilterProps<T>) {
  return (
    <label className="status-filter">
      <ListFilter size={14} aria-hidden="true" />
      <select
        value={value}
        onChange={event => onChange(event.target.value as T)}
        aria-label={ariaLabel}
      >
        {options.map(option => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
