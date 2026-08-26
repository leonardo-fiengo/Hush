import {
  decodePairingCode,
  deserializeEnvelope,
  encodePairingCode,
  serializeEnvelope,
} from './vaultTransfer.js'

const CHUNK_SIZE = 12_000
const ICE_TIMEOUT = 6_000

function deviceLabel() {
  const mobile = /Android|iPhone|iPad|Mobile/iu.test(navigator.userAgent)
  return mobile ? 'Hush on phone' : 'Hush on laptop'
}

function waitForIceGathering(peer) {
  if (peer.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const finish = () => {
      window.clearTimeout(timer)
      peer.removeEventListener('icegatheringstatechange', check)
      resolve()
    }
    const check = () => {
      if (peer.iceGatheringState === 'complete') finish()
    }
    const timer = window.setTimeout(finish, ICE_TIMEOUT)
    peer.addEventListener('icegatheringstatechange', check)
  })
}

export function createDeviceLink({ onState, onEnvelope, onPeer }) {
  let peer = null
  let channel = null
  let pendingEnvelope = null
  const transfers = new Map()

  const report = (state, detail = '') => onState?.({ state, detail })

  function closePeer(reportClosed = true) {
    channel?.close()
    peer?.close()
    channel = null
    peer = null
    transfers.clear()
    if (reportClosed) report('idle')
  }

  function sendJson(value) {
    if (channel?.readyState !== 'open') return false
    channel.send(JSON.stringify(value))
    return true
  }

  function sendPendingEnvelope() {
    if (!pendingEnvelope || channel?.readyState !== 'open') return
    const serialized = serializeEnvelope(pendingEnvelope)
    const transferId = crypto.randomUUID()
    const total = Math.ceil(serialized.length / CHUNK_SIZE)
    sendJson({ type: 'vault-start', transferId, total })
    for (let index = 0; index < total; index += 1) {
      sendJson({ type: 'vault-chunk', transferId, index, data: serialized.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE) })
    }
    sendJson({ type: 'vault-end', transferId })
  }

  function handleMessage(event) {
    try {
      const message = JSON.parse(event.data)
      if (message.type === 'hello') {
        onPeer?.(message.label || 'Linked device')
        sendPendingEnvelope()
        return
      }
      if (message.type === 'vault-start') {
        if (!Number.isInteger(message.total) || message.total < 1 || message.total > 500) throw new Error('Invalid transfer size.')
        transfers.set(message.transferId, { total: message.total, chunks: [] })
        report('syncing', 'Receiving encrypted vault')
        return
      }
      if (message.type === 'vault-chunk') {
        const transfer = transfers.get(message.transferId)
        if (!transfer || !Number.isInteger(message.index) || message.index < 0 || message.index >= transfer.total || typeof message.data !== 'string' || message.data.length > CHUNK_SIZE) return
        transfer.chunks[message.index] = message.data
        return
      }
      if (message.type === 'vault-end') {
        const transfer = transfers.get(message.transferId)
        transfers.delete(message.transferId)
        if (!transfer || transfer.chunks.filter((chunk) => typeof chunk === 'string').length !== transfer.total) throw new Error('The encrypted transfer was incomplete.')
        onEnvelope?.(deserializeEnvelope(transfer.chunks.join('')))
        report('connected', 'Encrypted vault synced')
      }
    } catch (error) {
      report('error', error.message || 'The linked device sent an invalid message.')
    }
  }

  function attachChannel(nextChannel) {
    channel = nextChannel
    channel.addEventListener('open', () => {
      report('connected', 'Direct encrypted link ready')
      sendJson({ type: 'hello', label: deviceLabel() })
      sendPendingEnvelope()
    })
    channel.addEventListener('message', handleMessage)
    channel.addEventListener('close', () => report('disconnected', 'The other device left'))
    channel.addEventListener('error', () => report('error', 'The direct device link failed.'))
  }

  function createPeer() {
    closePeer(false)
    if (!window.RTCPeerConnection) throw new Error('Device linking is not supported by this browser.')
    peer = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
    })
    peer.addEventListener('connectionstatechange', () => {
      if (peer?.connectionState === 'failed') report('error', 'Could not reach the other device. Try the same Wi-Fi network.')
      if (peer?.connectionState === 'disconnected') report('disconnected', 'Trying to find the other device again')
      if (peer?.connectionState === 'connected' && channel?.readyState === 'open') report('connected', 'Direct encrypted link ready')
    })
    peer.addEventListener('datachannel', (event) => attachChannel(event.channel))
    return peer
  }

  async function createOffer() {
    const nextPeer = createPeer()
    attachChannel(nextPeer.createDataChannel('hush-vault', { ordered: true }))
    report('pairing', 'Creating a private offer')
    await nextPeer.setLocalDescription(await nextPeer.createOffer())
    await waitForIceGathering(nextPeer)
    report('pairing', 'Offer ready')
    return encodePairingCode('offer', nextPeer.localDescription)
  }

  async function acceptOffer(code) {
    const nextPeer = createPeer()
    report('pairing', 'Reading the laptop offer')
    await nextPeer.setRemoteDescription(decodePairingCode(code, 'offer'))
    await nextPeer.setLocalDescription(await nextPeer.createAnswer())
    await waitForIceGathering(nextPeer)
    report('pairing', 'Response ready')
    return encodePairingCode('answer', nextPeer.localDescription)
  }

  async function acceptAnswer(code) {
    if (!peer) throw new Error('Create a new pairing offer first.')
    report('pairing', 'Opening the direct link')
    await peer.setRemoteDescription(decodePairingCode(code, 'answer'))
  }

  function shareEnvelope(envelope) {
    pendingEnvelope = envelope
    sendPendingEnvelope()
  }

  return {
    createOffer,
    acceptOffer,
    acceptAnswer,
    shareEnvelope,
    close: closePeer,
  }
}
