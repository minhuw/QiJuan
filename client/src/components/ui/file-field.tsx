import { Upload } from 'lucide-react';
import { useRef, useState, type ChangeEvent } from 'react';
import { Button } from './button';

export function FileField({
  id,
  label,
  chooseLabel,
  emptyLabel,
  accept,
  multiple,
  name,
}: {
  id: string;
  label: string;
  chooseLabel: string;
  emptyLabel: string;
  accept?: string;
  multiple?: boolean;
  name?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [summary, setSummary] = useState(emptyLabel);

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    setSummary(files.length > 0 ? files.map((file) => file.name).join(', ') : emptyLabel);
  }

  return (
    <div className="grid gap-2">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <div className="flex min-h-24 flex-col items-start justify-center gap-2 rounded-lg border border-dashed border-input bg-card px-4 py-4 sm:flex-row sm:items-center">
        <Button type="button" variant="outline" onClick={() => inputRef.current?.click()}>
          <Upload className="size-4" aria-hidden="true" />
          {chooseLabel}
        </Button>
        <span className="min-w-0 truncate text-sm text-muted-foreground">{summary}</span>
      </div>
      <input
        ref={inputRef}
        id={id}
        className="sr-only"
        type="file"
        name={name}
        accept={accept}
        multiple={multiple}
        onChange={onChange}
      />
    </div>
  );
}
