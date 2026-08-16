import { readFileSync, writeFileSync } from 'node:fs';

const path = 'src/server.ts';
let source = readFileSync(path, 'utf8');

const from = `      const product = productStatusPayload();
      if (!product.actions.canStartTake) {
        rejectTakeCommand(
          socket,
          'start',
          product.health === 'blocked' ? 'product-blocked' : 'take-not-ready',
        );
        return;
      }
      const song = takeSongSnapshot();`;
const to = `      if (!session.active) {
        rejectTakeCommand(socket, 'start', 'mix-not-active');
        return;
      }
      const song = takeSongSnapshot();`;

const count = source.split(from).length - 1;
if (count !== 1) throw new Error(`expected exactly one product Take gate, found ${count}`);
source = source.replace(from, to);
writeFileSync(path, source);
console.log('Restored legacy/dev Take command boundary; formal UI remains product-gated.');
