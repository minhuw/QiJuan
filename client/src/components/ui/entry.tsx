import type { ReactNode } from 'react';

/** A ruled section whose heading hangs in the margin column beside its content. */
export function Entry({
  title,
  titleId,
  meta,
  head,
  className,
  label,
  busy,
  children,
}: {
  title: string;
  titleId?: string;
  meta?: ReactNode;
  head?: ReactNode;
  className?: string;
  label?: string;
  busy?: boolean;
  children?: ReactNode;
}) {
  return (
    <section
      className={className ? `entry ${className}` : 'entry'}
      aria-labelledby={label ? undefined : titleId}
      aria-label={label}
      aria-busy={busy}
    >
      <div className="entry-head">
        <h2 id={titleId}>{title}</h2>
        {meta ? <div className="entry-meta">{meta}</div> : null}
        {head}
      </div>
      <div className="entry-body">{children}</div>
    </section>
  );
}
