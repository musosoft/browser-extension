import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AxiosError } from 'axios';
import { planeTimerDiagnostic, planeTimerActionError } from '../entrypoints/utils/planeDiagnostics.ts';

const secret = 'https://private.test/?token=SECRET user@example.test';
function responseError(status) {
  return new AxiosError(secret, 'ERR_BAD_RESPONSE', undefined, undefined, {
    status, statusText: secret, data: secret, headers: { Authorization: secret }, config: {},
  });
}

test('Axios response diagnostics expose only validated HTTP numbers and fixed categories', () => {
  for (const [status, category] of [[401, 'Authentication'], [403, 'Authentication'],
    [404, 'Client error'], [429, 'Client error'], [500, 'Server error'], [302, 'Request failed']]) {
    assert.equal(planeTimerDiagnostic(responseError(status)), `HTTP ${status} · ${category}`);
  }
  for (const status of [secret, NaN, Infinity, 0, 99, 600, 401.5]) {
    assert.equal(planeTimerDiagnostic(responseError(status)), 'Request failed');
  }
  assert.equal(planeTimerDiagnostic({ response: { status: 401 }, message: secret }), 'Request failed');
});

test('no-response network and timeout failures use a fixed non-definitive category', () => {
  for (const code of ['ERR_NETWORK', 'ECONNABORTED', 'ETIMEDOUT']) {
    assert.equal(planeTimerDiagnostic(new AxiosError(secret, code)), 'Network/CORS');
  }
  assert.equal(planeTimerDiagnostic(new AxiosError(secret, 'ERR_BAD_REQUEST')), 'Request failed');
});

test('known local settings and authentication failures map to fixed labels', () => {
  for (const message of ['Unable to load instance settings', 'Unable to load API settings',
    'Instance settings unavailable; open the extension popup to migrate settings', 'Invalid instance endpoint']) {
    assert.equal(planeTimerDiagnostic(new Error(message)), 'Settings unavailable');
    assert.equal(planeTimerDiagnostic(new AxiosError(message, 'ERR_NETWORK')), 'Settings unavailable');
  }
  for (const message of ['Open the Solidtime extension and sign in first.', 'No refresh token available', 'Failed to refresh token']) {
    assert.equal(planeTimerDiagnostic(new Error(message)), 'Authentication');
  }
});

test('unknown errors and message substrings never leak data or imply a known cause', () => {
  for (const error of [undefined, null, secret, new Error(secret),
    new Error(`Unable to load API settings: ${secret}`), new Error(`Failed to refresh token: ${secret}`)]) {
    assert.equal(planeTimerDiagnostic(error), 'Request failed');
  }
});

test('action guidance stays unchanged for local failures but never echoes arbitrary timer messages', () => {
  for (const message of ['Open the Solidtime extension and sign in first.',
    'Safe tracking needs Web Locks support in this browser.',
    'Select an organization in the Solidtime extension first.',
    'This issue is no longer being tracked. Refresh and try again.',
    'A timer is already running. Stop it before starting this issue.']) {
    assert.equal(planeTimerActionError(new Error(message)), message);
  }
  assert.equal(planeTimerActionError(new Error(`timer first tracked Web Locks ${secret}`)),
    'Solidtime could not update the timer. Check the extension and retry.');
});
