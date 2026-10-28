import type { InputHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'flex h-10 w-full rounded-md border border-input bg-card px-3 text-sm text-foreground shadow-none outline-none placeholder:text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}
