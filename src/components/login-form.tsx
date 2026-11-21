'use client';

import { EyeIcon, EyeOffIcon, LoaderCircle, TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import { Alert, AlertTitle } from './ui/alert.tsx';
import { Button } from './ui/button.tsx';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.tsx';
import { Input } from './ui/input.tsx';

function failure(status: number, retryAfter: string | null): string {
  if (status === 401) return 'Wrong email or password';
  if (status === 403) return 'This account has no access to Everflow';
  if (status === 429) {
    const minutes = Math.max(1, Math.ceil(Number(retryAfter ?? 900) / 60));
    return `Too many attempts, try again in ${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  return 'Sign-in failed, try again';
}

export function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }), credentials: 'same-origin', cache: 'no-store' });
      if (response.status === 204) { window.location.assign(next); return; }
      setError(failure(response.status, response.headers.get('retry-after')));
    } catch {
      setError('Everflow is not reachable');
    }
    setBusy(false);
  }

  return (
    <div className="relative grid min-h-dvh place-items-center overflow-hidden bg-background px-4 py-10">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-96 bg-[radial-gradient(ellipse_at_top,var(--color-accent),transparent_70%)]" />
      <Card className="relative w-full max-w-sm shadow-lg">
        <CardHeader className="justify-items-center gap-2 text-center">
          <img src="/apple-icon.png" alt="" width={64} height={64} className="mb-2 size-16 object-contain" />
          <CardTitle className="text-xl">Sign in to Everflow</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5">
          {error && (
            <Alert variant="destructive" role="alert">
              <TriangleAlertIcon />
              <AlertTitle>{error}</AlertTitle>
            </Alert>
          )}
          <form onSubmit={submit} className="grid gap-5">
            <div className="grid gap-2">
              <label htmlFor="email" className="text-sm font-medium">Email or username</label>
              <Input id="email" name="email" type="text" autoCapitalize="none" autoCorrect="off" autoComplete="username" className="h-10"
                value={email} onChange={(event) => setEmail(event.target.value)} aria-invalid={!!error || undefined} required autoFocus />
            </div>
            <div className="grid gap-2">
              <label htmlFor="password" className="text-sm font-medium">Password</label>
              <div className="relative">
                <Input id="password" name="password" type={show ? 'text' : 'password'} autoComplete="current-password" className="h-10 pr-11"
                  value={password} onChange={(event) => setPassword(event.target.value)} aria-invalid={!!error || undefined} required />
                <Button type="button" variant="ghost" size="icon-sm" className="absolute top-1/2 right-1 -translate-y-1/2"
                  onClick={() => setShow(!show)} aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}>
                  {show ? <EyeOffIcon /> : <EyeIcon />}
                </Button>
              </div>
            </div>
            <Button type="submit" className="h-10 w-full" disabled={busy}>
              {busy && <LoaderCircle className="animate-spin" aria-hidden="true" />}
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
