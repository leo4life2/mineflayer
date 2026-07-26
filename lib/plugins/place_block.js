module.exports = inject

// TRUTH RAIL (wire-verified on Paper 1.21.1): a REJECTED placement produces
// NO corrective block update — total silence on the block channels. The only
// per-click response the protocol guarantees is acknowledge_player_digging
// (1.19+ block_changed_ack, carrying just sequenceId): "I have processed
// every block action up to N, and everything I accepted has already been
// broadcast" (the world broadcast happens during handling; the ack flushes at
// tick end, so TCP ordering puts any block_change BEFORE its ack). An ack
// covering our click with no block update for our destination is therefore an
// authoritative rejection — surfaced here as an instant honest failure
// instead of a 0.8-5s blockUpdate-timeout tax (the under-attack death window).
const ACK_REJECT_GRACE_MS = 100 // ordering belt-and-braces past the TCP guarantee

function inject (bot) {
  // Single decoded ack stream for all placement waiters. Pre-1.19 servers
  // send an acknowledge_player_digging with {location, block, status} and no
  // sequenceId — those are ignored (legacy shape, different semantics).
  bot._client.on('acknowledge_player_digging', (packet) => {
    if (typeof packet?.sequenceId === 'number') {
      bot.emit('blockActionAck', packet.sequenceId)
    }
  })

  async function placeBlockWithOptions (referenceBlock, faceVector, options) {
    const dest = referenceBlock.position.plus(faceVector)
    let oldBlock = bot.blockAt(dest)
    await bot._genericPlace(referenceBlock, faceVector, options)
    // generic_place allocated this click's serverbound sequence (0 = server
    // too old for acks; fall back to pure timeout semantics).
    const sequence = options?._sequence ?? 0

    let newBlock = bot.blockAt(dest)
    if (oldBlock.type === newBlock.type) {
      [oldBlock, newBlock] = await new Promise((resolve, reject) => {
        // Callers that retry in a loop can bound the confirmation listener's
        // lifetime (options.timeout) so concurrent attempts never stack
        // long-lived per-coordinate listeners. Default unchanged.
        const timeoutMs = options?.timeout ?? 5000
        let ackTimer = null
        const cleanup = () => {
          clearTimeout(timer)
          if (ackTimer) clearTimeout(ackTimer)
          bot.removeListener(`blockUpdate:${dest}`, onUpdate)
          bot.removeListener('blockActionAck', onAck)
        }
        // Condition matches the old onceWithCleanup checkCondition: wait for
        // an update actually changing the block type; (null, null) = unload.
        const onUpdate = (a, b) => {
          if (!a || !b || a.type !== b.type) {
            cleanup()
            resolve([a, b])
          }
        }
        const onAck = (ackSeq) => {
          if (sequence === 0 || ackSeq < sequence) return // not our click yet
          if (ackTimer) return
          // The server has fully processed our click. Anything it accepted
          // was broadcast before this ack; one short beat lets an in-flight
          // update land, then the silence is an authoritative rejection.
          ackTimer = setTimeout(() => {
            cleanup()
            bot.emit('blockPlacementRejected', dest, sequence)
            reject(new Error(`Server rejected block placement at ${dest} (action ack ${ackSeq}, no block update)`))
          }, ACK_REJECT_GRACE_MS)
        }
        const timer = setTimeout(() => {
          cleanup()
          reject(new Error(`Event blockUpdate:${dest} did not fire within timeout of ${timeoutMs}ms`))
        }, timeoutMs)
        bot.on(`blockUpdate:${dest}`, onUpdate)
        bot.on('blockActionAck', onAck)
      })
    }

    // blockUpdate emits (null, null) when the world unloads
    if (!oldBlock && !newBlock) {
      return
    }
    if (oldBlock?.type === newBlock.type) {
      throw new Error(`No block has been placed : the block is still ${oldBlock?.name}`)
    } else {
      bot.emit('blockPlaced', oldBlock, newBlock)
    }
  }

  async function placeBlock (referenceBlock, faceVector) {
    await placeBlockWithOptions(referenceBlock, faceVector, { swingArm: 'right' })
  }

  bot.placeBlock = placeBlock
  bot._placeBlockWithOptions = placeBlockWithOptions
}

inject.ACK_REJECT_GRACE_MS = ACK_REJECT_GRACE_MS
