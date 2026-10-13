/**
 * Interactive session picker for a bare `claude-handoff export`.
 *
 * Arrow keys (or j/k) move, Enter picks the highlighted session, `a`
 * picks all, `q` / Esc / Ctrl-C cancels. Only used on a real terminal;
 * scripts and agents get a plain listing instead.
 */

export type PickerResult =
  | { kind: 'move'; index: number }
  | { kind: 'choose'; indexes: number[] }
  | { kind: 'cancel' }
  | { kind: 'ignore' };

/** How a key press changes the picker. Pure, so the key handling is testable. */
export function pickerStep(index: number, count: number, key: string): PickerResult {
  switch (key) {
    case '\u001b[A': // up
    case 'k':
      return { kind: 'move', index: (index - 1 + count) % count };
    case '\u001b[B': // down
    case 'j':
      return { kind: 'move', index: (index + 1) % count };
    case '\r':
    case '\n':
      return { kind: 'choose', indexes: [index] };
    case 'a':
    case 'A':
      return { kind: 'choose', indexes: Array.from({ length: count }, (_, i) => i) };
    case 'q':
    case 'Q':
    case '\u001b': // Esc
    case '\u0003': // Ctrl-C
    case '\u0004': // Ctrl-D
      return { kind: 'cancel' };
    default:
      return { kind: 'ignore' };
  }
}

const MAX_VISIBLE = 10;

/** The slice of rows to draw so the highlighted one stays on screen. */
export function visibleWindow(
  index: number,
  count: number,
  size = MAX_VISIBLE,
): { start: number; end: number } {
  if (count <= size) return { start: 0, end: count };
  const start = Math.min(Math.max(0, index - Math.floor(size / 2)), count - size);
  return { start, end: start + size };
}

export function canPickInteractively(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/**
 * Show the picker and resolve to the chosen indexes, or null if the user
 * cancelled. `labels` are shown as given, one row each.
 */
export function pickInteractively(header: string, labels: string[]): Promise<number[] | null> {
  const { stdin, stdout } = process;
  const width = Math.max(20, (stdout.columns ?? 80) - 4);
  const fit = (text: string) => (text.length > width ? text.slice(0, width - 1) + '…' : text);
  let index = 0;
  let drawnLines = 0;

  const draw = () => {
    if (drawnLines > 0) stdout.write(`\u001b[${drawnLines}A\u001b[0J`);
    const { start, end } = visibleWindow(index, labels.length);
    const lines = [header];
    if (start > 0) lines.push(`  … ${start} more above`);
    for (let i = start; i < end; i++) {
      lines.push(i === index ? `\u001b[1m❯ ${fit(labels[i])}\u001b[0m` : `  ${fit(labels[i])}`);
    }
    if (end < labels.length) lines.push(`  … ${labels.length - end} more below`);
    lines.push('\u001b[2m↑/↓ move · Enter export · a all · q cancel\u001b[0m');
    stdout.write(lines.join('\n') + '\n');
    drawnLines = lines.length;
  };

  return new Promise((resolve) => {
    const finish = (result: number[] | null) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      resolve(result);
    };
    const onData = (chunk: Buffer) => {
      const step = pickerStep(index, labels.length, chunk.toString('utf-8'));
      if (step.kind === 'move') {
        index = step.index;
        draw();
      } else if (step.kind === 'choose') {
        finish(step.indexes);
      } else if (step.kind === 'cancel') {
        finish(null);
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
    draw();
  });
}
