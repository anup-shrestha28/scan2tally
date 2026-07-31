import {
  forwardRef,
  useCallback,
  useRef,
  type ForwardedRef,
  type KeyboardEvent,
} from 'react';
import { Search, X } from 'lucide-react';

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
  className?: string;
  fullWidth?: boolean;
  disabled?: boolean;
  id?: string;
}

function updateForwardedRef<T>(ref: ForwardedRef<T>, value: T | null) {
  if (typeof ref === 'function') {
    ref(value);
  } else if (ref) {
    ref.current = value;
  }
}

/** A consistent, accessible search field for list and table toolbars. */
const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  {
    value,
    onChange,
    ariaLabel,
    placeholder = 'Search…',
    className = '',
    fullWidth = false,
    disabled = false,
    id,
  },
  ref,
) {
  const inputElementRef = useRef<HTMLInputElement | null>(null);
  const setInputRef = useCallback(
    (element: HTMLInputElement | null) => {
      inputElementRef.current = element;
      updateForwardedRef(ref, element);
    },
    [ref],
  );

  const clearSearch = () => {
    onChange('');
    requestAnimationFrame(() => inputElementRef.current?.focus());
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape' || !value) return;

    event.preventDefault();
    clearSearch();
  };

  const rootClassName = [
    'search-input',
    fullWidth ? 'search-input-full' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={rootClassName}>
      <Search className="search-input-icon" size={16} aria-hidden="true" />
      <input
        ref={setInputRef}
        id={id}
        className="search-input-field"
        type="search"
        value={value}
        onChange={event => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-keyshortcuts="Escape"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        disabled={disabled}
      />
      {value && !disabled ? (
        <button
          className="search-input-clear"
          type="button"
          onClick={clearSearch}
          aria-label={`Clear ${ariaLabel.toLowerCase()}`}
          title="Clear search"
        >
          <X size={14} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
});

export default SearchInput;
