'use client';

import { useId, useRef, useState } from 'react';
import { cn } from '../../lib/utils.ts';
import { Button } from '../ui/button.tsx';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '../ui/dialog.tsx';
import { Textarea } from '../ui/textarea.tsx';

export function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return <kbd className={cn('inline-flex h-5 min-w-5 items-center justify-center rounded border border-b-2 bg-muted px-1 font-mono text-[11px] leading-none font-medium text-muted-foreground', className)} {...props} />;
}

// Minutes a chat stays muted; null: until unmuted, undefined: not muted.
export type MuteChoice = number | null | undefined;
const MAX_MINUTES = 525_600;
export const muteOptions: [string, string][] = [['', "Don't mute"], ['30', '30 min'], ['60', '1 h'], ['120', '2 h'], ['240', '4 h'],
  ['tomorrow', 'Tomorrow 9:00'], ['10080', '1 week'], ['always', 'Until unmuted'], ['custom', 'Custom']];
const units: [string, string, number][] = [['minutes', 'minutes', 1], ['hours', 'hours', 60], ['days', 'days', 1_440]];

function tomorrowMorning(now: Date): number {
  const at = new Date(now);
  at.setDate(at.getDate() + 1);
  at.setHours(9, 0, 0, 0);
  return Math.ceil((at.getTime() - now.getTime()) / 60_000);
}

// undefined: not muted; null: until unmuted; NaN: a custom duration that is not a whole number in range.
export function muteMinutes(choice: string, amount: string, unit: string, now = new Date()): MuteChoice {
  if (choice === '') return undefined;
  if (choice === 'always') return null;
  if (choice === 'tomorrow') return tomorrowMorning(now);
  if (choice !== 'custom') return Number(choice);
  const value = Number(amount) * (units.find(([key]) => key === unit)?.[2] ?? NaN);
  return /^\d+$/.test(amount.trim()) && value >= 1 && value <= MAX_MINUTES ? value : NaN;
}

function mutedUntil(minutes: MuteChoice, now = new Date()): string {
  if (minutes === undefined || Number.isNaN(minutes)) return '';
  if (minutes === null) return 'New messages skip triage until you unmute the chat.';
  const until = new Date(now.getTime() + minutes * 60_000);
  const sameDay = until.toDateString() === now.toDateString();
  const time = until.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `Muted until ${sameDay ? `today ${time}` : until.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.`;
}

function MutePicker(props: { id: string; label: string; choices: [string, string][]; choice: string; amount: string; unit: string;
  onChoice: (value: string) => void; onAmount: (value: string) => void; onUnit: (value: string) => void }) {
  const minutes = muteMinutes(props.choice, props.amount, props.unit);
  const invalid = Number.isNaN(minutes);
  return <fieldset className="space-y-2" aria-describedby={`${props.id}-until`}>
    <legend className="mb-1.5 text-sm font-medium">{props.label}</legend>
    <div className="flex flex-wrap gap-1.5">
      {props.choices.map(([value, label]) => <label key={value} className="relative">
        <input type="radio" name={`${props.id}-mute`} value={value} checked={props.choice === value} onChange={() => props.onChoice(value)} className="peer sr-only" />
        <span className={cn('inline-flex h-10 cursor-pointer select-none items-center rounded-full border px-3 text-sm transition-colors sm:h-8',
          'hover:bg-accent peer-checked:border-primary peer-checked:bg-primary peer-checked:text-primary-foreground',
          'peer-focus-visible:ring-[3px] peer-focus-visible:ring-ring/50')}>{label}</span>
      </label>)}
    </div>
    {props.choice === 'custom' && <div className="flex items-end gap-2">
      <label className="grid gap-1 text-xs text-muted-foreground">Duration
        <input type="number" inputMode="numeric" min={1} step={1} value={props.amount} onChange={(event) => props.onAmount(event.target.value)} autoFocus
          aria-invalid={invalid} className="h-10 w-24 rounded-md border border-input bg-transparent px-3 text-sm text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive sm:h-9 dark:bg-input/30" />
      </label>
      <label className="grid gap-1 text-xs text-muted-foreground">Unit
        <select value={props.unit} onChange={(event) => props.onUnit(event.target.value)}
          className="h-10 rounded-md border border-input bg-transparent px-3 text-sm text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:h-9 dark:bg-input/30">
          {units.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
    </div>}
    <p id={`${props.id}-until`} aria-live="polite" className={cn('min-h-4 text-xs', invalid ? 'text-destructive' : 'text-muted-foreground')}>
      {invalid ? 'Enter a whole number, up to one year.' : mutedUntil(minutes)}</p>
  </fieldset>;
}

export function ActionDialog(props: {
  label: string;
  title: string;
  confirm: string;
  // Optional question for a chat that discusses the ticket before anything is done
  discuss?: boolean;
  mute?: 'optional' | 'only';
  disabled?: boolean;
  shortcut?: string;
  action?: string;
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
  const [amount, setAmount] = useState('45');
  const [unit, setUnit] = useState('minutes');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const limit = props.discuss ? 8_000 : 2_000;
  const only = props.mute === 'only';
  const options = only ? muteOptions.slice(1) : muteOptions;
  const change = (next: boolean) => {
    setOpen(next);
    if (next) { setValue(''); setMute(only ? '60' : ''); setAmount('45'); setUnit('minutes'); setError(''); }
  };
  const minutes = props.mute ? muteMinutes(mute, amount, unit) : undefined;
  return <Dialog open={open} onOpenChange={change}>
    <DialogTrigger asChild>
      <Button ref={trigger} variant={props.variant ?? 'outline'} size={props.size ?? 'default'} type="button" disabled={props.disabled} data-shortcut={props.shortcut} data-action={props.action}
        aria-label={props.display === undefined ? undefined : props.label} title={props.shortcut ? `${props.label} (${props.shortcut})` : undefined} className={props.className}>
        {props.icon}{props.display === undefined ? props.label : props.display}
      </Button>
    </DialogTrigger>
    <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg" onCloseAutoFocus={(event) => {
      if (!trigger.current?.isConnected || trigger.current.disabled) { event.preventDefault(); document.getElementById('ticket-search')?.focus(); }
    }}>
      <DialogHeader>
        <DialogTitle>{props.title}</DialogTitle>
        <DialogDescription>{props.discuss ? 'Opens a chat in OpenChamber with the ticket context, to clear your doubts. Nothing is done until you decide there.'
          : only ? 'New messages of this chat are kept but skip triage until the mute ends. Source messages remain unchanged.'
            : 'Closes the selected work locally. Source messages remain unchanged.'}</DialogDescription>
      </DialogHeader>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (saving || Number.isNaN(minutes)) return;
        setSaving(true);
        setError('');
        void props.onConfirm(value, minutes).then(() => change(false)).catch((failure: unknown) => {
          setError(failure instanceof Error ? failure.message : 'Local action failed');
        }).finally(() => setSaving(false));
      }} className="space-y-4">
        {!only && <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <label htmlFor={id} className="text-sm font-medium">{props.discuss ? 'What to discuss (optional)' : 'Reason (optional)'}</label>
            <span aria-hidden="true" className="text-xs tabular-nums text-muted-foreground">{value.length}/{limit}</span>
          </div>
          <Textarea ref={field} id={id} value={value} onChange={(event) => setValue(event.target.value)} maxLength={limit}
            aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} rows={5}
            placeholder={props.placeholder ?? (props.discuss ? 'What does not convince you' : 'Why this is closed, for feedback')} />
        </div>}
        {props.mute && <MutePicker id={id} label={only ? 'Mute for' : 'Mute this chat'} choices={options} choice={mute} amount={amount} unit={unit}
          onChoice={setMute} onAmount={setAmount} onUnit={setUnit} />}
        {error && <p id={`${id}-error`} role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter className="gap-2">
          <DialogClose asChild><Button type="button" variant="outline" className="h-10 sm:h-9">Cancel</Button></DialogClose>
          <Button type="submit" disabled={saving || Number.isNaN(minutes)} variant={props.discuss || only || props.safe ? 'default' : 'destructive'} className="h-10 sm:h-9">{saving ? 'Saving...' : props.confirm}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
