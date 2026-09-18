import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveIntelBaseUrl, intelUrl } from './intelEndpoint.js';

test('strips a trailing slash from the base URL', () => {
  assert.equal(
    resolveIntelBaseUrl('http://intel.local:8080/'),
    'http://intel.local:8080',
  );
});

test('keeps a path prefix intact', () => {
  assert.equal(
    resolveIntelBaseUrl('http://intel.local/v1/'),
    'http://intel.local/v1',
  );
});

test('rejects a relative or non-http base URL', () => {
  assert.throws(() => resolveIntelBaseUrl('/v1'), TypeError);
  assert.throws(() => resolveIntelBaseUrl('ftp://intel.local'), TypeError);
  assert.throws(() => resolveIntelBaseUrl(''), TypeError);
});

test('joins a path onto the base exactly once', () => {
  assert.equal(
    intelUrl('http://intel.local', '/query'),
    'http://intel.local/query',
  );
  assert.equal(
    intelUrl('http://intel.local/', 'query'),
    'http://intel.local/query',
  );
});
