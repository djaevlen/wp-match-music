import { render, screen } from '@testing-library/react';
import { Slider } from './slider';

// Radix measures the thumb; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

test('the aria-label names the element with the slider role', () => {
  render(<Slider aria-label="Fade duration" min={0} max={10} value={[4]} />);
  expect(screen.getByRole('slider', { name: 'Fade duration' })).toHaveAttribute('aria-valuenow', '4');
});
