import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createUnlockHandoff,
  UNLOCK_HANDOFF_TTL,
  unlockHandoffIsValid,
  unlockHandoffMatchesTab,
} from '../extension/src/unlockHandoffPolicy.js'

const request = {
  requestId: '12345678-1234-1234-1234-123456789abc',
  tabId: 17,
  windowId: 4,
  pageUrl: 'https://accounts.example.com/login?private=value',
  createdAt: 1_000,
}

test('unlock handoffs retain only short-lived routing metadata, not the full page URL', () => {
  const handoff = createUnlockHandoff(request)
  assert.deepEqual(handoff, {
    version: 1,
    requestId: request.requestId,
    tabId: 17,
    windowId: 4,
    origin: 'https://accounts.example.com',
    hostname: 'accounts.example.com',
    createdAt: 1_000,
  })
  assert.equal(unlockHandoffIsValid(handoff, 1_000 + UNLOCK_HANDOFF_TTL), true)
  assert.equal(unlockHandoffIsValid(handoff, 1_001 + UNLOCK_HANDOFF_TTL), false)
})

test('unlock handoffs bind resumption to the original tab, window, and HTTPS origin', () => {
  const handoff = createUnlockHandoff(request)
  const tab = { id: 17, windowId: 4, url: 'https://accounts.example.com/next' }
  assert.equal(unlockHandoffMatchesTab(handoff, tab, 2_000), true)
  assert.equal(unlockHandoffMatchesTab(handoff, { ...tab, id: 18 }, 2_000), false)
  assert.equal(unlockHandoffMatchesTab(handoff, { ...tab, windowId: 5 }, 2_000), false)
  assert.equal(unlockHandoffMatchesTab(handoff, { ...tab, url: 'https://example.com/login' }, 2_000), false)
  assert.throws(() => createUnlockHandoff({ ...request, pageUrl: 'http://accounts.example.com' }), /only on HTTPS/iu)
})
