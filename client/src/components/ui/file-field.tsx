import { UploadCloud } from 'lucide-react';
import { useRef, useState, type ChangeEvent, type DragEvent } from 'react';

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
  const [dragging, setDragging] = useState(false);

  function describe(files: FileList | null) {
    const list = Array.from(files ?? []);
    setSummary(list.length > 0 ? list.map((file) => file.name).join(', ') : emptyLabel);
  }

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    describe(event.target.files);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const input = inputRef.current;
    if (!input || !event.dataTransfer.files.length) return;
    try {
      input.files = event.dataTransfer.files;
      describe(input.files);
    } catch {
      // Browsers that do not allow assigning FileList still offer the picker.
    }
  }

  return (
    <div className="file-field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <div
        className={dragging ? 'file-drop file-drop-active' : 'file-drop'}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <span className="file-drop-icon" aria-hidden="true">
          <UploadCloud size={22} />
        </span>
        <div className="file-drop-copy">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => inputRef.current?.click()}>
            {chooseLabel}
          </button>
          <span className="file-drop-name">{summary}</span>
        </div>
      </div>
      <input
        ref={inputRef}
        id={id}
        className="visually-hidden"
        type="file"
        name={name}
        accept={accept}
        multiple={multiple}
        onChange={onChange}
      />
    </div>
  );
}
