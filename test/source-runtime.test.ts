import assert from 'node:assert/strict';
import test from 'node:test';

import { SourceRuntime } from '../src/source-runtime.js';

type FakeSocket = {
  id: string;
  open: boolean;
  isRobotSource?: boolean;
};

function runtime() {
  return new SourceRuntime<FakeSocket>({
    isConnected: (socket) => socket.open,
  });
}

test('SourceRuntime owns active Robot identity and source discontinuity generation', () => {
  const source = runtime();
  const first: FakeSocket = { id: 'first', open: true };
  const second: FakeSocket = { id: 'second', open: true };

  assert.equal(source.socket, null);
  assert.equal(source.generation, 0);
  assert.equal(source.connected(), false);
  assert.equal(source.canReportSeek(first), true, 'a legacy/never-Robot source keeps seek authority');

  assert.deepEqual(source.attachRobot(first), { previous: null, replaced: false });
  assert.equal(source.socket, first);
  assert.equal(first.isRobotSource, true);
  assert.equal(source.generation, 0, 'first Robot attachment does not invalidate an existing source identity');
  assert.equal(source.connected(), true);
  assert.equal(source.isActive(first), true);
  assert.equal(source.isActiveRobot(first), true);
  assert.equal(source.canReportSeek(first), true);

  assert.deepEqual(source.attachRobot(second), { previous: first, replaced: true });
  assert.equal(first.isRobotSource, false);
  assert.equal(second.isRobotSource, true);
  assert.equal(source.socket, second);
  assert.equal(source.generation, 1, 'Robot replacement is a destructive source identity change');
  assert.equal(source.canReportSeek(first), false, 'superseded Robot source remains fenced');
  assert.equal(source.canReportSeek(second), true);

  source.invalidateMapping();
  assert.equal(source.generation, 2, 'manual/load/unmapped seek advances the same source epoch');
  assert.equal(source.socket, second, 'mapping invalidation does not replace the active control source');

  assert.equal(source.detachRobot(first), false, 'stale socket cannot detach the active source');
  assert.equal(source.generation, 2);
  assert.equal(source.detachRobot(second), true);
  assert.equal(second.isRobotSource, false);
  assert.equal(source.socket, null);
  assert.equal(source.generation, 3, 'active Robot disconnect advances source identity');
  assert.equal(source.canReportSeek(second), false, 'disconnected former Robot remains fenced');
});

test('an active Robot is the room\'s only source discontinuity authority', () => {
  const source = runtime();
  const legacy: FakeSocket = { id: 'legacy-source-page', open: true };
  const robot: FakeSocket = { id: 'robot', open: true };

  // The desktop development adapter, with no Robot in the room.
  assert.equal(source.canReportSeek(legacy), true);

  source.attachRobot(robot);
  assert.equal(
    source.canReportSeek(legacy),
    false,
    'a legacy Source page must not invalidate the active Robot mapping it does not own',
  );
  assert.equal(source.canReportSeek(robot), true);

  // Losing the Robot hands authority back to the development path.
  source.detachRobot(robot);
  assert.equal(source.canReportSeek(legacy), true);
});

test('SourceRuntime samples connection liveness without owning transport', () => {
  const source = runtime();
  const socket: FakeSocket = { id: 'robot', open: true };
  source.attachRobot(socket);
  assert.equal(source.connected(), true);
  socket.open = false;
  assert.equal(source.connected(), false);
  assert.equal(source.isActiveRobot(socket), true, 'transport liveness does not silently revoke control identity');
});
