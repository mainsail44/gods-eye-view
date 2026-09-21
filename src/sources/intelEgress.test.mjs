import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  classifyProbeFailure,
  parseProbeTarget,
  probeEgress,
} from '../../services/intel/src/egress.js';

/** A socket that does exactly what the script tells it to, and nothing else. */
class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.timeoutMs = null;
  }
  setTimeout(ms) {
    this.timeoutMs = ms;
  }
  destroy() {
    this.destroyed = true;
  }
}

const dialing = (script) => {
  const attempts = [];
  const connectImpl = (options) => {
    const socket = new FakeSocket();
    attempts.push({ options, socket });
    queueMicrotask(() => script(socket));
    return socket;
  };
  return { attempts, connectImpl };
};

const failWith = (code) =>
  Object.assign(new Error(`connect ${code}`), { code });

test('a host:port target parses, and anything else does not', () => {
  assert.deepEqual(parseProbeTarget('1.1.1.1:443'), {
    host: '1.1.1.1',
    port: 443,
  });
  assert.deepEqual(parseProbeTarget('[2606:4700:4700::1111]:443'), {
    host: '2606:4700:4700::1111',
    port: 443,
  });
  for (const target of [
    '',
    null,
    undefined,
    'no-port',
    '1.1.1.1:',
    '1.1.1.1:0',
    '1.1.1.1:70000',
    '1.1.1.1:https',
  ]) {
    assert.equal(parseProbeTarget(target), null, `parsed ${target}`);
  }
});

test('only an inability to connect out reads as blocked', () => {
  for (const code of [
    'ECONNREFUSED',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENETDOWN',
    'ETIMEDOUT',
    'ECONNRESET',
  ]) {
    assert.equal(classifyProbeFailure(failWith(code)), 'blocked', code);
  }
});

test('a failure that proves nothing about routing reads as unknown', () => {
  // No DNS, no permission to open the socket, or something we do not know:
  // none of these say the container could not have reached the internet.
  for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'EACCES', 'EPERM', 'EMFILE']) {
    assert.equal(classifyProbeFailure(failWith(code)), 'unknown', code);
  }
  assert.equal(classifyProbeFailure(new Error('no code')), 'unknown');
  assert.equal(classifyProbeFailure(undefined), 'unknown');
});

test('a connection that is established reports allowed', async () => {
  const { attempts, connectImpl } = dialing((socket) => socket.emit('connect'));
  assert.equal(await probeEgress('1.1.1.1:443', { connectImpl }), 'allowed');
  assert.deepEqual(attempts[0].options, { host: '1.1.1.1', port: 443 });
  assert.equal(attempts[0].socket.destroyed, true);
});

test('a dropped connection attempt reports blocked, and cannot hang startup', async () => {
  const { attempts, connectImpl } = dialing((socket) => socket.emit('timeout'));
  assert.equal(
    await probeEgress('1.1.1.1:443', { connectImpl, timeoutMs: 2000 }),
    'blocked',
  );
  assert.equal(attempts[0].socket.timeoutMs, 2000);
  assert.equal(attempts[0].socket.destroyed, true);
});

test('the error decides the verdict, and a later event cannot change it', async () => {
  const refused = dialing((socket) =>
    socket.emit('error', failWith('ECONNREFUSED')),
  );
  assert.equal(
    await probeEgress('1.1.1.1:443', { connectImpl: refused.connectImpl }),
    'blocked',
  );

  const nameless = dialing((socket) =>
    socket.emit('error', failWith('ENOTFOUND')),
  );
  assert.equal(
    await probeEgress('nowhere.invalid:443', {
      connectImpl: nameless.connectImpl,
    }),
    'unknown',
  );

  const noisy = dialing((socket) => {
    socket.emit('connect');
    socket.emit('error', failWith('ECONNRESET'));
    socket.emit('timeout');
  });
  assert.equal(
    await probeEgress('1.1.1.1:443', { connectImpl: noisy.connectImpl }),
    'allowed',
  );
});

test('a target that never dials, or a socket that will not open, is unknown', async () => {
  const { attempts, connectImpl } = dialing(() => {});
  assert.equal(await probeEgress('not-a-target', { connectImpl }), 'unknown');
  assert.equal(attempts.length, 0, 'an unparseable target dials nothing');

  assert.equal(
    await probeEgress('1.1.1.1:443', {
      connectImpl: () => {
        throw failWith('EACCES');
      },
    }),
    'unknown',
  );
});
