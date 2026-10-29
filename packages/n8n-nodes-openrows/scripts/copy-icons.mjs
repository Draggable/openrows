// n8n reads node and credential icons (`file:openrows.svg`) and the nodes' codex files
// (`*.node.json`) next to the compiled files; tsc copies neither.
import { copyFileSync } from 'node:fs';

const from = (name) => new URL(`../src/${name}`, import.meta.url);
const to = (name) => new URL(`../dist/${name}`, import.meta.url);

for (const file of [
  'nodes/OpenRows/openrows.svg',
  'nodes/OpenRows/OpenRows.node.json',
  'nodes/OpenRows/OpenRowsTrigger.node.json',
]) {
  copyFileSync(from(file), to(file));
}
copyFileSync(from('nodes/OpenRows/openrows.svg'), to('credentials/openrows.svg'));
