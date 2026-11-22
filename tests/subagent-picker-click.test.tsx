import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import React from 'react';
import { Box, render } from 'ink';
import stripAnsi from 'strip-ansi';
import { ThemeProvider } from '../src/theme.js';
import { Dialog, DialogList } from '../src/components/Dialog.js';
import { pickerClickIndex } from '../src/utils/picker-click.js';

class Out extends EventEmitter {
  frames: string[] = [];
  isTTY = true;
  constructor(public rows: number, public columns = 80) { super(); }
  get rowsCount() { return this.rows; }
  write(chunk: string | Uint8Array): boolean {
    this.frames.push(stripAnsi(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')));
    return true;
  }
}
class In extends EventEmitter {
  isTTY = true;
  setEncoding() {} setRawMode() {} resume() {} pause() {} ref() {}
}

/** Render the same centred card App uses and find the first item's 1-based row. */
function firstItemRow(rows: number, count: number): number {
  const stdout = new Out(rows);
  const items = Array.from({ length: count }, (_, i) => ({ id: `r${i}`, label: `/run-${i}` }));
  const instance = render(
    <ThemeProvider name="black">
      <Box height={rows} width={80} flexDirection="column" justifyContent="center" alignItems="center">
        <Dialog title="Sub-agents" hint="↑↓ move · enter inspect · esc close" columns={80}>
          <DialogList items={items} selected={0} maxVisible={8} />
        </Dialog>
      </Box>
    </ThemeProvider>,
    {
      stdout: stdout as any,
      stdin: new In() as any,
      stderr: stdout as any,
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  const frame = stdout.frames[stdout.frames.length - 1] ?? '';
  instance.unmount();
  instance.cleanup();
  const row = frame.split('\n').findIndex((line) => line.includes('/run-0'));
  assert.ok(row >= 0, `first item rendered at rows=${rows}`);
  return row + 1;
}

for (const rows of [39, 40, 41, 42, 50]) {
  test(`clicking the first subagent works at ${rows} rows (odd/even centering)`, () => {
    const pressY = firstItemRow(rows, 5);
    // 5 items fit inside the 8-row window: no hidden markers, no counter.
    assert.equal(
      pickerClickIndex({ rows, count: 5, pickerIndex: 0, maxVisible: 8, pressY }),
      0,
      'the first rendered row maps to the first run',
    );
    assert.equal(
      pickerClickIndex({ rows, count: 5, pickerIndex: 0, maxVisible: 8, pressY: pressY + 1 }),
      1,
      'the second rendered row maps to the second run',
    );
    assert.equal(
      pickerClickIndex({ rows, count: 5, pickerIndex: 0, maxVisible: 8, pressY: 1 }),
      null,
      'clicks on the frame border are ignored',
    );
  });
}
