import type { InputHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'flex h-8 w-full rounded-sm border border-input bg-secondary px-2.5 text-[0.9375rem] text-foreground shadow-none placeholder:text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}
