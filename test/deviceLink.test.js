import test from 'node:test'
import assert from 'node:assert/strict'
import { createDeviceLink } from '../src/lib/deviceLink.js'
import { encodePairingCode } from '../src/lib/vaultTransfer.js'

class FakeChannel extends EventTarget {
  readyState = 'connecting'
  close() {}
  send() {}
}

class FakePeer extends EventTarget {
  static latest = null
  connectionState = 'new'
  iceGatheringState = 'complete'
  signalingState = 'stable'
  localDescription = null
  remoteDescription = null
  remoteAnswerCalls = 0

  constructor() {
    super()
    FakePeer.latest = this
  }

  createDataChannel() { return new FakeChannel() }
  async createOffer() { return { type: 'offer', sdp: 'v=0\r\no=hush-offer\r\n' } }
  async setLocalDescription(description) {
    this.localDescription = description
    this.signalingState = 'have-local-offer'
  }
  async setRemoteDescription(description) {
    if (this.signalingState !== 'have-local-offer') throw new Error('Called in wrong state: stable')
    this.remoteAnswerCalls += 1
    this.remoteDescription = description
    this.signalingState = 'stable'
  }
  close() { this.signalingState = 'closed' }
}

test('accepting the same WebRTC answer twice is idempotent', async () => {
  const previousWindow = globalThis.window
  const previousPeer = globalThis.RTCPeerConnection
  globalThis.window = { RTCPeerConnection: FakePeer, clearTimeout, setTimeout }
  globalThis.RTCPeerConnection = FakePeer
  try {
    const link = createDeviceLink({})
    await link.createOffer()
    const answer = encodePairingCode('answer', { type: 'answer', sdp: 'v=0\r\no=hush-answer\r\n' })

    await link.acceptAnswer(answer)
    await link.acceptAnswer(answer)

    assert.equal(FakePeer.latest.remoteAnswerCalls, 1)
    assert.equal(FakePeer.latest.signalingState, 'stable')
  } finally {
    globalThis.window = previousWindow
    globalThis.RTCPeerConnection = previousPeer
  }
})
