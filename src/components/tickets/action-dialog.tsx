'use client';

import { useId, useRef, useState } from 'react';
import { cn } from '../../lib/utils.ts';
import { Button } from '../ui/button.tsx';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '../ui/dialog.tsx';
import { Textarea } from '../ui/textarea.tsx';

export function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return <kbd className={cn('inline-flex h-5 min-w-5 items-center justify-center rounded border border-b-2 bg-muted px-1 font-mono text-[11px] leading-none font-medium text-muted-foreground', className)} {...props} />;
}

export function ActionDialog(props: {
  label: string;
  title: string;
  confirm: string;
  note?: boolean;
  disabled?: boolean;
  shortcut?: string;
  icon?: React.ReactNode;
  display?: React.ReactNode;
  variant?: 'default' | 'outline';
  size?: 'default' | 'sm' | 'icon-sm';
  className?: string;
  onConfirm: (value: string) => Promise<unknown>;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const limit = props.note ? 8_000 : 2_000;
  const change = (next: boolean) => {
    setOpen(next);
    if (next) { setValue(''); setError(''); }
  };
  return <Dialog open={open} onOpenChange={change}>
    <DialogTrigger asChild>
      <Button ref={trigger} variant={props.variant ?? 'outline'} size={props.size ?? 'default'} type="button" disabled={props.disabled} data-shortcut={props.shortcut}
        aria-label={props.display === undefined ? undefined : props.label} title={props.shortcut ? `${props.label} (${props.shortcut})` : undefined} className={props.className}>
        {props.icon}{props.display === undefined ? props.label : props.display}
      </Button>
    </DialogTrigger>
    <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg" onCloseAutoFocus={(event) => {
      if (!trigger.current?.isConnected || trigger.current.disabled) { event.preventDefault(); document.getElementById('ticket-search')?.focus(); }
    }}>
      <DialogHeader>
        <DialogTitle>{props.title}</DialogTitle>
        <DialogDescription>{props.note ? 'Saves approval and queues a local chat job. No remote session is opened by this request.' : 'Closes the selected work locally. Source messages remain unchanged.'}</DialogDescription>
      </DialogHeader>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (saving) return;
        if (props.note && !value.trim()) { setError('Note is required'); field.current?.focus(); return; }
        setSaving(true);
        setError('');
        void props.onConfirm(value).then(() => change(false)).catch((failure: unknown) => {
          setError(failure instanceof Error ? failure.message : 'Local action failed');
        }).finally(() => setSaving(false));
      }} className="space-y-4">
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <label htmlFor={id} className="text-sm font-medium">{props.note ? 'Note (required)' : 'Reason (optional)'}</label>
            <span aria-hidden="true" className="text-xs tabular-nums text-muted-foreground">{value.length}/{limit}</span>
          </div>
          <Textarea ref={field} id={id} value={value} onChange={(event) => setValue(event.target.value)} maxLength={limit}
            aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} rows={5}
            placeholder={props.note ? 'Exact instruction for the chat' : 'Why this is closed, for feedback'} />
          {error && <p id={`${id}-error`} role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter className="gap-2">
          <DialogClose asChild><Button type="button" variant="outline" className="h-10 sm:h-9">Cancel</Button></DialogClose>
          <Button type="submit" disabled={saving} variant={props.note ? 'default' : 'destructive'} className="h-10 sm:h-9">{saving ? 'Saving...' : props.confirm}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
