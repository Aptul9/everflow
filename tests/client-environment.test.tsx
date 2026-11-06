// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';

afterEach(cleanup);

test('client tests opt into jsdom and the pinned React Testing Library toolchain', async () => {
  let clicks = 0;
  render(<button onClick={() => clicks++}>Synthetic action</button>);
  await userEvent.click(screen.getByRole('button', { name: 'Synthetic action' }));
  expect(clicks).toBe(1);
});
