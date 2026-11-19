import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { Dialog, DialogList, dialogWidth, dialogInnerWidth } from '../src/components/Dialog.js';

test('dialog is a thin framed card with title, badge and hint', () => {
  const frame = stripAnsi(
    render(
      <Dialog title="Settings" badge="1/5" hint="↑↓ move · enter toggle · esc close" columns={80}>
        <Text>Animations  on</Text>
      </Dialog>
    ).lastFrame() ?? ''
  );
  assert.match(frame, /╭─+╮/, 'rounded top border');
  assert.match(frame, /╰─+╯/, 'rounded bottom border');
  assert.match(frame, /Settings/);
  assert.match(frame, /1\/5/);
  assert.match(frame, /Animations {2}on/);
  assert.match(frame, /esc close/);
  const width = Math.max(...frame.split('\n').map((line) => line.length));
  assert.equal(width, dialogWidth(80), 'card never exceeds its clamped width');
});

test('compact dialog drops its frame so options fit a phone-sized terminal', () => {
  const frame = stripAnsi(
    render(
      <Dialog title="Approval required" badge="bash" hint="enter confirm" columns={20} compact>
        <Text>Approve session</Text>
      </Dialog>
    ).lastFrame() ?? ''
  );
  assert.doesNotMatch(frame, /╭|╰/, 'no border rows');
  assert.match(frame, /Approval required/, 'title stays readable');
  assert.match(frame, /Approve session/);
  assert.match(frame, /enter confirm/);
  assert.ok(
    Math.max(...frame.split('\n').map((line) => line.length)) <= 20,
    'card fits a 20-column terminal'
  );
});

test('dialog list renders right-aligned values and group headings', () => {
  const frame = stripAnsi(
    render(
      <DialogList
        items={[
          { id: 'a', label: 'Animations', section: 'Interface', meta: 'on' },
          { id: 'b', label: 'Approval mode', section: 'Agent', meta: 'manual' },
        ]}
        selected={1}
      />
    ).lastFrame() ?? ''
  );
  assert.match(frame, /Interface/);
  assert.match(frame, /Agent/);
  assert.match(frame, /› Approval mode\s+manual/, 'selection and value share one row');
  assert.equal(dialogInnerWidth(20), dialogWidth(20) - 4);
});

test('accentGlyph prefixes the title and borderStyle switches to square corners', () => {
  const frame = stripAnsi(
    render(
      <Dialog title="Theme" accentGlyph="◈" borderStyle="square" columns={80} hint="esc close">
        <Text>black  warm gold on near-black</Text>
      </Dialog>
    ).lastFrame() ?? ''
  );
  assert.match(frame, /┌─+┐/, 'square top border');
  assert.match(frame, /└─+┘/, 'square bottom border');
  assert.match(frame, /◈ Theme/, 'accent glyph sits before the title');
  assert.match(frame, /warm gold on near-black/);
});

test('the accent glyph also shows in compact dialogs without adding a frame', () => {
  const frame = stripAnsi(
    render(
      <Dialog title="Theme" accentGlyph="◈" columns={20} compact>
        <Text>black</Text>
      </Dialog>
    ).lastFrame() ?? ''
  );
  assert.match(frame, /◈ Theme/);
  assert.doesNotMatch(frame, /╭|┌/, 'compact stays frameless');
});

test('dialog list renders a palette swatch between the pointer and the name', () => {
  const frame = stripAnsi(
    render(
      <DialogList
        items={[{
          id: 'black',
          label: 'black',
          swatch: { accent: '#d4af37', bg: '#050505' },
          meta: 'current',
        }]}
        selected={0}
      />
    ).lastFrame() ?? ''
  );
  assert.match(frame, /› ■ black\s+current/, 'swatch and current marker share one row');
});
