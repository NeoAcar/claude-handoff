import { describe, it, expect } from 'vitest';
import { pickerStep, visibleWindow } from '../../src/commands/picker.js';

describe('pickerStep', () => {
  it('moves with arrows and j/k, wrapping at the ends', () => {
    expect(pickerStep(0, 3, '\u001b[B')).toEqual({ kind: 'move', index: 1 });
    expect(pickerStep(2, 3, 'j')).toEqual({ kind: 'move', index: 0 });
    expect(pickerStep(0, 3, '\u001b[A')).toEqual({ kind: 'move', index: 2 });
    expect(pickerStep(1, 3, 'k')).toEqual({ kind: 'move', index: 0 });
  });

  it('chooses the highlighted row on Enter and every row on a', () => {
    expect(pickerStep(1, 3, '\r')).toEqual({ kind: 'choose', indexes: [1] });
    expect(pickerStep(1, 3, 'a')).toEqual({ kind: 'choose', indexes: [0, 1, 2] });
  });

  it('cancels on q, Esc and Ctrl-C, and ignores other keys', () => {
    for (const key of ['q', '\u001b', '\u0003']) {
      expect(pickerStep(0, 3, key)).toEqual({ kind: 'cancel' });
    }
    expect(pickerStep(0, 3, 'x')).toEqual({ kind: 'ignore' });
  });
});

describe('visibleWindow', () => {
  it('shows everything when it fits', () => {
    expect(visibleWindow(2, 5, 10)).toEqual({ start: 0, end: 5 });
  });

  it('keeps the highlighted row inside a scrolling window', () => {
    expect(visibleWindow(0, 30, 10)).toEqual({ start: 0, end: 10 });
    expect(visibleWindow(15, 30, 10)).toEqual({ start: 10, end: 20 });
    expect(visibleWindow(29, 30, 10)).toEqual({ start: 20, end: 30 });
  });
});
