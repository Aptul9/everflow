'use client';

import { useId, useRef, useState } from 'react';
import { Button } from '../ui/button.tsx';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '../ui/dialog.tsx';
import { Textarea } from '../ui/textarea.tsx';

export function ActionDialog(props: {
  label: string;
  title: string;
  confirm: string;
  note?: boolean;
  disabled?: boolean;
  shortcut?: string;
  onConfirm: (value: string) => Promise<unknown>;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const change = (next: boolean) => {
    setOpen(next);
    if (next) { setValue(''); setError(''); }
  };
  return <Dialog open={open} onOpenChange={change}>
    <DialogTrigger asChild><Button ref={trigger} variant="outline" type="button" disabled={props.disabled} data-shortcut={props.shortcut}>{props.label}</Button></DialogTrigger>
    <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto" onCloseAutoFocus={(event) => {
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
        <div className="space-y-2">
          <label htmlFor={id} className="text-sm font-medium">{props.note ? 'Note (required)' : 'Reason (optional)'}</label>
          <Textarea ref={field} id={id} value={value} onChange={(event) => setValue(event.target.value)} maxLength={props.note ? 8_000 : 2_000}
            aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} rows={5} />
          {error && <p id={`${id}-error`} role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <DialogClose asChild><Button type="button" variant="outline">Cancel</Button></DialogClose>
          <Button type="submit" disabled={saving}>{saving ? 'Saving...' : props.confirm}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
