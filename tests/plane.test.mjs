import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planeRoute, planeIssueFromLink, planeIssueFromCard, PLANE_CARD_TITLE, planeTimerState, changePlaneTimer } from '../entrypoints/utils/planeIssue.ts';

const page = 'https://plane.example.test/team/projects/project-id/issues/';
const issue = planeIssueFromLink('/team/browse/DEV2-42/', '  Fix\n the card  ', page);

test('board routes differ from details, while detail overlays are handled via DOM', () => {
  assert.equal(planeRoute('/team/projects/project-id/issues/'), 'list');
  assert.equal(planeRoute('/team/projects/project-id/issues'), 'list');
  assert.equal(planeRoute('/team/browse/DEV2-42/'), 'detail');
  assert.equal(planeRoute('/team/settings/'), null);
});

test('card extraction uses browse key and title only, not priority/assignee text', () => {
  assert.deepEqual(issue, { issueKey: 'DEV2-42', title: 'Fix the card', description: 'DEV2-42 Fix the card' });
  assert.equal(planeIssueFromLink('/team/browse/DEV2-42/', '', page), null);
  assert.equal(planeIssueFromLink('/team/browse/DEV2-42/', 'DEV2-42', page), null);
  assert.equal(planeIssueFromLink('/other/browse/DEV2-42/', 'Title', page), null);
  assert.equal(planeIssueFromLink('https://other.test/team/browse/DEV2-42/', 'Title', page), null);
  assert.equal(planeIssueFromLink('/team/projects/p/issues/', 'Title', page), null);
});

const active = { id: 'entry-1', organization_id: 'org-original', description: issue.description, end: null };

test('observed card title selector ignores aggregate card metadata and fails closed if absent', () => {
  const anchor = {
    href: '/team/browse/DEV2-42/',
    textContent: 'DEV2-42 Fix the card High Assigned person',
    querySelector(selector) {
      assert.equal(selector, PLANE_CARD_TITLE);
      return { textContent: 'Fix the card' };
    },
  };
  assert.equal(planeIssueFromCard(anchor, page).description, 'DEV2-42 Fix the card');
  assert.equal(planeIssueFromCard({ ...anchor, querySelector: () => null }, page), null);
});

test('only an exact matching active description permits stopping', () => {
  assert.equal(planeTimerState(null, issue), 'idle');
  assert.equal(planeTimerState(active, issue), 'tracking');
  assert.equal(planeTimerState({ ...active, description: 'DEV2-420 Other' }, issue), 'blocked');
  assert.equal(planeTimerState({ ...active, description: 'DEV2-42 Different title' }, issue), 'blocked');
  assert.equal(planeTimerState({ ...active, end: '2026-10-06T10:00:00Z' }, issue), 'idle');
});

test('fresh active entry prevents stale start and never stops another issue', async () => {
  const writes = [];
  const service = {
    read: async () => ({ ...active, description: 'OTHER-1 Another task' }),
    start: async (value) => writes.push(['start', value]),
    stop: async (value) => writes.push(['stop', value]),
  };
  await assert.rejects(changePlaneTimer(issue, 'start', service), /already running/);
  await assert.rejects(changePlaneTimer(issue, 'stop', service), /no longer/);
  assert.deepEqual(writes, []);
});

test('start and stop use freshly read state; stale stop cannot create a new timer', async () => {
  let current = null;
  const writes = [];
  const service = {
    read: async () => current,
    start: async (value) => { writes.push(['start', value.description]); current = active; },
    stop: async (value) => { writes.push(['stop', value.id, value.organization_id]); current = null; },
  };
  await changePlaneTimer(issue, 'start', service);
  await assert.rejects(changePlaneTimer(issue, 'start', service), /already running/);
  await changePlaneTimer(issue, 'stop', service);
  await assert.rejects(changePlaneTimer(issue, 'stop', service), /no longer/);
  assert.deepEqual(writes, [['start', issue.description], ['stop', 'entry-1', 'org-original']]);
});

test('failed state reads fail closed without API writes', async () => {
  let writes = 0;
  await assert.rejects(changePlaneTimer(issue, 'start', {
    read: async () => { throw new Error('network unavailable'); },
    start: async () => { writes++; }, stop: async () => { writes++; },
  }), /network unavailable/);
  assert.equal(writes, 0);
});
