// Measuring whether this container can reach the outside world.
//
// "Nothing leaves this machine" is the claim the product turns on, so /health
// must never report `blocked` on the strength of a configuration value that
// nothing checked. The check is one TCP connection attempt, and the result is
// reported exactly as it came back.

import { connect } from 'node:net';

/** Long enough for a real handshake, short enough never to hold up startup. */
export const PROBE_TIMEOUT_MS = 2000;

/**
 * Failures that mean the connection was genuinely not allowed out: nothing
 * answered, the route does not exist, or something on the path rejected it.
 * A dropped SYN (our timeout) belongs here too — it is what an egress firewall
 * looks like from inside.
 */
const NO_ROUTE = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENETRESET',
  'EPIPE',
  'ETIMEDOUT',
]);

/** Split `host:port`, or `[v6:addr]:port`; null when it is neither. */
export function parseProbeTarget(target) {
  const match = /^(?:\[(.+)\]|([^:]+)):(\d+)$/.exec(String(target ?? ''));
  if (!match) return null;
  const port = Number(match[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: match[1] ?? match[2], port };
}

/**
 * Why the attempt failed decides what we may claim. Only an inability to
 * connect out reads as `blocked`; a failure that says nothing about routing —
 * a name that will not resolve, a socket we are not permitted to open, an
 * error we do not recognise — reads as `unknown`, because it is.
 */
export function classifyProbeFailure(error) {
  return NO_ROUTE.has(error?.code) ? 'blocked' : 'unknown';
}

/**
 * Dial `target` once. `allowed` if the connection is established, `blocked` if
 * it demonstrably cannot be, `unknown` if the attempt proved nothing.
 */
export function probeEgress(
  target,
  { timeoutMs = PROBE_TIMEOUT_MS, connectImpl = connect } = {},
) {
  const parsed = parseProbeTarget(target);
  if (!parsed) return Promise.resolve('unknown');
  return new Promise((resolve) => {
    let settled = false;
    let socket;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      socket?.destroy();
      resolve(result);
    };
    try {
      socket = connectImpl(parsed);
    } catch (error) {
      return settle(classifyProbeFailure(error));
    }
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => settle('allowed'));
    // A silently dropped connection attempt is the signature of an egress
    // firewall, so the timeout counts as blocked rather than as no answer.
    socket.once('timeout', () => settle('blocked'));
    socket.once('error', (error) => settle(classifyProbeFailure(error)));
  });
}
