import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { FadeControl } from './FadeControl';

// Radix sliders need layout that jsdom lacks; this stand-in exposes the same props.
vi.mock('@/components/ui/slider', () => ({
  Slider: (p: {
    value: number[];
    min: number;
    max: number;
    step: number;
    onValueChange: (v: number[]) => void;
    onValueCommit: (v: number[]) => void;
  }) => (
    <input
      type="range"
      role="slider"
      min={p.min}
      max={p.max}
      step={p.step}
      value={p.value[0]}
      onChange={(e) => p.onValueChange([Number(e.target.value)])}
      onPointerUp={(e) => p.onValueCommit([Number((e.target as HTMLInputElement).value)])}
    />
  ),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const store = (saveFade = vi.fn(async (_ms: number) => {})) => ({ fadeMs: () => 2000, saveFade });

test('editor commits a new fade', async () => {
  const s = store();
  render(<FadeControl store={s} canEdit />);
  fireEvent.click(screen.getByRole('button', { name: 'Fade 2.0 s' }));
  const slider = await screen.findByRole('slider');
  expect(slider).toHaveAttribute('min', '0');
  expect(slider).toHaveAttribute('max', '10000');
  expect(slider).toHaveAttribute('step', '500');
  fireEvent.change(slider, { target: { value: '3500' } });
  expect(screen.getByRole('button', { name: 'Fade 3.5 s' })).toBeInTheDocument();
  expect(s.saveFade).not.toHaveBeenCalled();
  fireEvent.pointerUp(slider);
  await waitFor(() => expect(s.saveFade).toHaveBeenCalledTimes(1));
  expect(s.saveFade).toHaveBeenCalledWith(3500);
});

test('a failed save is reported and the shown value goes back', async () => {
  const s = store(vi.fn(async (_ms: number) => Promise.reject(new Error('nope'))));
  render(<FadeControl store={s} canEdit />);
  fireEvent.click(screen.getByRole('button', { name: 'Fade 2.0 s' }));
  const slider = await screen.findByRole('slider');
  fireEvent.change(slider, { target: { value: '3500' } });
  fireEvent.pointerUp(slider);
  expect(await screen.findByRole('button', { name: 'Fade 2.0 s' })).toBeInTheDocument();
  expect(toast.error).toHaveBeenCalledWith('nope');
});

test('viewer sees the value only', () => {
  render(<FadeControl store={store()} canEdit={false} />);
  expect(screen.getByText('Fade 2.0 s')).toBeInTheDocument();
  expect(screen.queryByRole('slider')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
});

test('quick successive commits are saved one after another, in order', async () => {
  const order: string[] = [];
  let release!: () => void;
  const saveFade = vi.fn(async (ms: number) => {
    order.push(`start ${ms}`);
    if (ms === 3000) await new Promise<void>((r) => (release = r));
    order.push(`end ${ms}`);
  });
  render(<FadeControl store={store(saveFade)} canEdit />);
  fireEvent.click(screen.getByRole('button', { name: 'Fade 2.0 s' }));
  const slider = await screen.findByRole('slider');
  fireEvent.change(slider, { target: { value: '3000' } });
  fireEvent.pointerUp(slider);
  fireEvent.change(slider, { target: { value: '3500' } });
  fireEvent.pointerUp(slider);
  await Promise.resolve();
  expect(order).toEqual(['start 3000']);
  release();
  await waitFor(() => expect(order).toEqual(['start 3000', 'end 3000', 'start 3500', 'end 3500']));
});
