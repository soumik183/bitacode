import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readImage } from '../src/tools/image-input.js';

const DIR = path.join(process.cwd(), 'tests', 'tmp-image-input');

async function setup(): Promise<void> {
  await fsp.rm(DIR, { recursive: true, force: true });
  await fsp.mkdir(DIR, { recursive: true });
}

test('readImage returns a base64 data URL with mime and size metadata', async () => {
  await setup();
  try {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const file = path.join(DIR, 'pic.png');
    await fsp.writeFile(file, bytes);
    const rel = path.relative(process.cwd(), file);

    const result = await readImage(rel);

    assert.match(result, /MIME: image\/png/);
    assert.match(result, new RegExp(`Size: ${bytes.length} bytes`));
    assert.ok(result.includes(`data:image/png;base64,${bytes.toString('base64')}`));
  } finally {
    await fsp.rm(DIR, { recursive: true, force: true });
  }
});

test('readImage validates the extension and missing files', async () => {
  await setup();
  try {
    const text = path.join(DIR, 'notes.txt');
    await fsp.writeFile(text, 'hi');
    const result = await readImage(path.relative(process.cwd(), text));
    assert.match(result, /unsupported image type/i);

    const missing = await readImage(path.relative(process.cwd(), path.join(DIR, 'gone.jpg')));
    assert.match(missing, /Error:/);
  } finally {
    await fsp.rm(DIR, { recursive: true, force: true });
  }
});

test('readImage rejects files above the 5 MB cap', async () => {
  await setup();
  try {
    const file = path.join(DIR, 'huge.png');
    const handle = await fsp.open(file, 'w');
    await handle.truncate(5 * 1024 * 1024 + 1);
    await handle.close();

    const result = await readImage(path.relative(process.cwd(), file));
    assert.match(result, /too large/i);
  } finally {
    await fsp.rm(DIR, { recursive: true, force: true });
  }
});

// Regression: read_image used path.resolve() with no sandbox check, so
// `../outside.png` turned into base64 bytes in the model context.
test('readImage refuses paths outside the working directory', async () => {
  const outside = path.join(path.dirname(process.cwd()), `outside-probe-${process.pid}.png`);
  await fsp.writeFile(outside, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  try {
    const result = await readImage(path.relative(process.cwd(), outside));
    assert.doesNotMatch(result, /base64/, 'must not return image bytes');
    assert.match(result, /outside the working directory/i);
  } finally {
    await fsp.rm(outside, { force: true });
  }
});
