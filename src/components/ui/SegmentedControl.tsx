interface Option<T extends string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  options: Option<T>[];
  value: T;
  onChange: (value: T) => void;
}

export function SegmentedControl<T extends string>({ options, value, onChange }: Props<T>) {
  // Рамка — inset-кольцо, а не border: border съедал 2px ширины, и сегмент
  // «Еда» в шите места падал до 42px, ниже зоны касания 44.
  return (
    <div className="flex rounded-lh-btn bg-lh-surface-2 p-1 ring-1 ring-inset ring-lh-border">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`flex-1 whitespace-nowrap rounded-lh-sm px-1 py-2.5 text-sm font-medium transition-all duration-200 ${
            value === o.value
              ? 'bg-lh-accent text-lh-bg shadow-[0_2px_10px_-3px_rgba(201,168,76,0.45)]'
              : 'text-lh-text-secondary active:text-lh-text-primary'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
