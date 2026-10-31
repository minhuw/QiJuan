import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm border text-[0.9375rem] transition-colors disabled:pointer-events-none disabled:opacity-50 px-3.5',
  {
    variants: {
      variant: {
        default: 'border-primary bg-primary text-primary-foreground hover:bg-primary/85',
        secondary: 'border-input bg-transparent text-foreground hover:bg-muted',
        outline: 'border-input bg-transparent text-foreground hover:bg-muted',
        ghost: 'border-transparent text-foreground hover:bg-muted',
      },
      size: {
        default: 'h-8',
        sm: 'h-7 px-2.5 text-[0.78125rem]',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'button';
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
