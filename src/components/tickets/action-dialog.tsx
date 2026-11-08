'use client';

import { useId, useRef, useState } from 'react';
import { cn } from '../../lib/utils.ts';
import { Button } from '../ui/button.tsx';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '../ui/dialog.tsx';
import { Textarea } from '../ui/textarea.tsx';

export function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return <kbd className={cn('inline-flex h-5 min-w-5 items-center justify-center rounded border border-b-2 bg-muted px-1 font-mono text-[11px] leading-none font-medium text-muted-foreground', className)} {...props} />;
}

// Hours a chat stays muted; null: until unmuted, undefined: not muted.
export type MuteChoice = number | null | undefined;
export const muteOptions: [string, string][] = [['', "Don't mute"], ['8', '8 hours'], ['24', '1 day'], ['168', '1 week'], ['always', 'Until unmuted']];
const muteValue = (value: string): MuteChoice => value === '' ? undefined : value === 'always' ? null : Number(value);

export function ActionDialog(props: {
  label: string;
  title: string;
  confirm: string;
  note?: boolean;
  mute?: 'optional' | 'only';
  disabled?: boolean;
  shortcut?: string;
  icon?: React.ReactNode;
  display?: React.ReactNode;
  variant?: 'default' | 'outline';
  size?: 'default' | 'sm' | 'icon-sm';
  className?: string;
  placeholder?: string;
  safe?: boolean;
  onConfirm: (value: string, mute: MuteChoice) => Promise<unknown>;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [mute, setMute] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const limit = props.note ? 8_000 : 2_000;
  const only = props.mute === 'only';
  const options = only ? muteOptions.slice(1) : muteOptions;
  const change = (next: boolean) => {
    setOpen(next);
    if (next) { setValue(''); setMute(only ? '24' : ''); setError(''); }
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
        <DialogDescription>{props.note ? 'Saves approval and queues a local chat job. No remote session is opened by this request.'
          : only ? 'New messages of this chat are kept but skip triage until the mute ends. Source messages remain unchanged.'
            : 'Closes the selected work locally. Source messages remain unchanged.'}</DialogDescription>
      </DialogHeader>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (saving) return;
        if (props.note && !value.trim()) { setError('Note is required'); field.current?.focus(); return; }
        setSaving(true);
        setError('');
        void props.onConfirm(value, props.mute ? muteValue(mute) : undefined).then(() => change(false)).catch((failure: unknown) => {
          setError(failure instanceof Error ? failure.message : 'Local action failed');
        }).finally(() => setSaving(false));
      }} className="space-y-4">
        {!only && <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <label htmlFor={id} className="text-sm font-medium">{props.note ? 'Note (required)' : 'Reason (optional)'}</label>
            <span aria-hidden="true" className="text-xs tabular-nums text-muted-foreground">{value.length}/{limit}</span>
          </div>
          <Textarea ref={field} id={id} value={value} onChange={(event) => setValue(event.target.value)} maxLength={limit}
            aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} rows={5}
            placeholder={props.placeholder ?? (props.note ? 'Exact instruction for the chat' : 'Why this is closed, for feedback')} />
        </div>}
        {props.mute && <div className="space-y-1.5">
          <label htmlFor={`${id}-mute`} className="text-sm font-medium">{only ? 'Mute for' : 'Mute this chat'}</label>
          <select id={`${id}-mute`} value={mute} onChange={(event) => setMute(event.target.value)}
            className="h-10 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:h-9 dark:bg-input/30">
            {options.map(([option, label]) => <option key={option} value={option}>{label}</option>)}
          </select>
        </div>}
        {error && <p id={`${id}-error`} role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter className="gap-2">
          <DialogClose asChild><Button type="button" variant="outline" className="h-10 sm:h-9">Cancel</Button></DialogClose>
          <Button type="submit" disabled={saving} variant={props.note || only || props.safe ? 'default' : 'destructive'} className="h-10 sm:h-9">{saving ? 'Saving...' : props.confirm}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
