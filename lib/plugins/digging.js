const { performance } = require('perf_hooks')
const { createDoneTask, createTask } = require('../promise_utils')
const BlockFaces = require('prismarine-world').iterators.BlockFace
const { Vec3 } = require('vec3')

// Enable verbose digging logs while iterating on behavior
const DEBUG_DIGGING = false

module.exports = inject

function inject (bot) {
  let swingInterval = null
  let waitTimeout = null
  let lookMaintainInterval = null
  let physicsTickListener = null

  let diggingTask = createDoneTask()

  bot.targetDigBlock = null
  bot.targetDigFace = null
  bot.lastDigTime = null

  // Debug helper: gated by file-level DEBUG_DIGGING constant
  const _digDebugEnabled = () => DEBUG_DIGGING
  const _digDebug = (...args) => { if (_digDebugEnabled()) console.log('[digging]', ...args) }

  async function dig (block, forceLook, digFace) {
    if (block === null || block === undefined) {
      throw new Error('dig was called with an undefined or null block')
    }

    const distance = block.position.distanceTo(bot.entity.position.offset(0, bot.entity.eyeHeight, 0))
    if (distance > 4.5) {
      _digDebug('skip: block too far', { block: block?.name, distance })
      return false
    }

    if (!digFace || typeof digFace === 'function') {
      digFace = 'auto'
    }

    // Initial log of parameters; dig time will be recomputed every tick
    _digDebug('params', {
      block: block?.name,
      position: block?.position,
      isInWater: bot.entity.isInWater,
      onGround: bot.entity.onGround,
      heldItem: bot.heldItem?.name,
      digFaceMode: digFace
    })

    bot.targetDigFace = 1 // Default (top)

    if (forceLook !== 'ignore') {
      if (digFace?.x || digFace?.y || digFace?.z) {
        // Determine the block face the bot should mine
        if (digFace.x) {
          bot.targetDigFace = digFace.x > 0 ? BlockFaces.EAST : BlockFaces.WEST
        } else if (digFace.y) {
          bot.targetDigFace = digFace.y > 0 ? BlockFaces.TOP : BlockFaces.BOTTOM
        } else if (digFace.z) {
          bot.targetDigFace = digFace.z > 0 ? BlockFaces.SOUTH : BlockFaces.NORTH
        }
        await bot.lookAt(
          block.position.offset(0.5, 0.5, 0.5).offset(digFace.x * 0.5, digFace.y * 0.5, digFace.z * 0.5),
          forceLook
        )
      } else if (digFace === 'raycast') {
        // Check faces that could be seen from the current position. If the delta is smaller then 0.5 that means the
        // bot can most likely not see the face as the block is 1 block thick
        // this could be false for blocks that have a smaller bounding box than 1x1x1
        const dx = bot.entity.position.x - (block.position.x + 0.5)
        const dy = bot.entity.position.y + bot.entity.eyeHeight - (block.position.y + 0.5)
        const dz = bot.entity.position.z - (block.position.z + 0.5)
        // Check y first then x and z
        const visibleFaces = {
          y: Math.sign(Math.abs(dy) > 0.5 ? dy : 0),
          x: Math.sign(Math.abs(dx) > 0.5 ? dx : 0),
          z: Math.sign(Math.abs(dz) > 0.5 ? dz : 0)
        }
        const validFaces = []
        const closerBlocks = []
        for (const i in visibleFaces) {
          if (!visibleFaces[i]) continue // skip as this face is not visible
          // target position on the target block face. -> 0.5 + (current face) * 0.5
          const targetPos = block.position.offset(
            0.5 + (i === 'x' ? visibleFaces[i] * 0.5 : 0),
            0.5 + (i === 'y' ? visibleFaces[i] * 0.5 : 0),
            0.5 + (i === 'z' ? visibleFaces[i] * 0.5 : 0)
          )
          const startPos = bot.entity.position.offset(0, bot.entity.eyeHeight, 0)
          const rayBlock = bot.world.raycast(startPos, targetPos.clone().subtract(startPos).normalize(), 5)
          if (rayBlock) {
            if (startPos.distanceTo(rayBlock.intersect) < startPos.distanceTo(targetPos)) {
              // Block is closer then the raycasted block
              closerBlocks.push(rayBlock)
              // continue since if distance is ever less, then we did not intersect the block we wanted,
              // meaning that the position of the intersected block is not what we want.
              continue
            }
            const rayPos = rayBlock.position
            if (
              rayPos.x === block.position.x &&
              rayPos.y === block.position.y &&
              rayPos.z === block.position.z
            ) {
              validFaces.push({
                face: rayBlock.face,
                targetPos: rayBlock.intersect
              })
            }
          }
        }

        if (validFaces.length > 0) {
          // Chose closest valid face
          let closest
          let distSqrt = 999
          for (const i in validFaces) {
            const tPos = validFaces[i].targetPos
            const cDist = new Vec3(tPos.x, tPos.y, tPos.z).distanceSquared(
              bot.entity.position.offset(0, bot.entity.eyeHeight, 0)
            )
            if (distSqrt > cDist) {
              closest = validFaces[i]
              distSqrt = cDist
            }
          }
          await bot.lookAt(closest.targetPos, forceLook)
          bot.targetDigFace = closest.face
        } else if (closerBlocks.length === 0 && block.shapes.length === 0) {
          // no other blocks were detected and the block has no shapes.
          // The block in question is replaceable (like tall grass) so we can just dig it
          // TODO: do AABB + ray intercept check to this position for digFace.
          await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), forceLook)
        } else {
          // Block is obstructed return error?
          throw new Error('Block not in view')
        }
      } else {
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), forceLook)
      }
    }

    // In vanilla the client will cancel digging the current block once the other block is at the crosshair.
    // Todo: don't wait until lookAt is at middle of the block, but at the edge of it.
    if (bot.targetDigBlock) bot.stopDigging()

    diggingTask = createTask()
    // Begin digging: send START and setup tick-based progress
    bot._client.write('block_dig', {
      status: 0, // start digging
      location: block.position,
      face: bot.targetDigFace // default face is 1 (top)
    })
    _digDebug('packet: start digging', { face: bot.targetDigFace, location: block.position })
    bot.targetDigBlock = block
    bot.swingArm()

    swingInterval = setInterval(() => {
      bot.swingArm()
    }, 350)

    // Progressive dig integration @ 20Hz
    const TICK_MS = 50
    let progress = 0
    let startedAt = performance.now()
    let finishing = false
    let restarts = 0

    function abortAndRestart () {
      _digDebug('packet: abort and restart')
      // Cancel current
      bot._client.write('block_dig', {
        status: 1, // cancel digging
        location: block.position,
        face: 0
      })
      // Restart
      bot._client.write('block_dig', {
        status: 0,
        location: block.position,
        face: bot.targetDigFace
      })
      startedAt = performance.now()
      progress = 0
      finishing = false
      restarts++
    }

    physicsTickListener = () => {
      if (!bot.targetDigBlock) return
      // Re-evaluate current dig time with dynamic conditions
      const digMs = bot.digTime(block)
      if (digMs === Infinity) {
        // Cannot dig in current conditions; attempt abort/restart once
        abortAndRestart()
        return
      }
      progress += TICK_MS / digMs

      // After 2x current dig time, if still not finished and no air update, restart
      const elapsed = performance.now() - startedAt
      if (!finishing && elapsed > (digMs * 2 + 150)) {
        abortAndRestart()
        return
      }

      if (progress >= 1 && bot.targetDigBlock) {
        finishing = true
        // Keep sending finish each tick until block update confirms air
        bot._client.write('block_dig', {
          status: 2,
          location: bot.targetDigBlock.position,
          face: bot.targetDigFace
        })
      }
    }
    bot.on('physicsTick', physicsTickListener)

    const eventName = `blockUpdate:${block.position}`
    bot.on(eventName, onBlockUpdate)

    const currentBlock = block

    // Keep the crosshair on the target block while digging to prevent accidental cancellation
    if (forceLook !== 'ignore') {
      const targetCenter = block.position.offset(0.5, 0.5, 0.5)
      lookMaintainInterval = setInterval(() => {
        if (!bot.targetDigBlock) return
        // Fire-and-forget; if another module moved the view, reacquire the target.
        bot.lookAt(targetCenter, true).catch(() => {})
      }, 150)
    }
    bot.stopDigging = () => {
      if (!bot.targetDigBlock) return

      // Replicate the odd vanilla cancellation face value.
      // When the cancellation is because of a new dig request on another block it's the same as the new dig start face. In all other cases it's 0.
      const stoppedBecauseOfNewDigRequest = !currentBlock.position.equals(bot.targetDigBlock.position)
      const cancellationDiggingFace = !stoppedBecauseOfNewDigRequest ? bot.targetDigFace : 0

      bot.removeListener(eventName, onBlockUpdate)
      clearInterval(swingInterval)
      clearTimeout(waitTimeout)
      clearInterval(lookMaintainInterval)
      if (physicsTickListener) bot.removeListener('physicsTick', physicsTickListener)
      swingInterval = null
      waitTimeout = null
      lookMaintainInterval = null
      _digDebug('packet: cancel digging', { becauseNewDig: stoppedBecauseOfNewDigRequest, face: cancellationDiggingFace, location: bot.targetDigBlock.position })
      bot._client.write('block_dig', {
        status: 1, // cancel digging
        location: bot.targetDigBlock.position,
        face: cancellationDiggingFace
      })
      const block = bot.targetDigBlock
      bot.targetDigBlock = null
      bot.targetDigFace = null
      bot.lastDigTime = performance.now()
      bot.emit('diggingAborted', block)
      bot.stopDigging = noop
      diggingTask.cancel(new Error('Digging aborted'))
    }

    function onBlockUpdate (oldBlock, newBlock) {
      // vanilla server never actually interrupt digging, but some server send block update when you start digging
      // so ignore block update if not air
      // All block update listeners receive (null, null) when the world is unloaded. So newBlock can be null.
      if (newBlock?.type !== 0) return
      bot.removeListener(eventName, onBlockUpdate)
      clearInterval(swingInterval)
      clearTimeout(waitTimeout)
      clearInterval(lookMaintainInterval)
      if (physicsTickListener) bot.removeListener('physicsTick', physicsTickListener)
      swingInterval = null
      waitTimeout = null
      lookMaintainInterval = null
      bot.targetDigBlock = null
      bot.targetDigFace = null
      bot.lastDigTime = performance.now()
      _digDebug('complete: block became air via update', { location: block.position })
      bot.emit('diggingCompleted', newBlock)
      diggingTask.finish()
    }

    await diggingTask.promise
  }

  bot.on('death', () => {
    bot.removeAllListeners('diggingAborted')
    bot.removeAllListeners('diggingCompleted')
    bot.stopDigging()
  })

  function canDigBlock (block) {
    return (
      block &&
      block.diggable &&
      block.position.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, 1.65, 0)) <= 5.1
    )
  }

  function digTime (block) {
    let type = null
    let enchantments = []

    // Retrieve currently held item ID and active enchantments from heldItem
    const currentlyHeldItem = bot.heldItem
    if (currentlyHeldItem) {
      type = currentlyHeldItem.type
      enchantments = currentlyHeldItem.enchants
    }

    // Append helmet enchantments (because Aqua Affinity actually affects dig speed)
    const headEquipmentSlot = bot.getEquipmentDestSlot('head')
    const headEquippedItem = bot.inventory.slots[headEquipmentSlot]
    if (headEquippedItem) {
      const helmetEnchantments = headEquippedItem.enchants
      enchantments = enchantments.concat(helmetEnchantments)
    }

    const creative = bot.game.gameMode === 'creative'
    return block.digTime(
      type,
      creative,
      bot.entity.isInWater,
      !bot.entity.onGround,
      enchantments,
      bot.entity.effects
    )
  }

  bot.dig = dig
  bot.stopDigging = noop
  bot.canDigBlock = canDigBlock
  bot.digTime = digTime
}

function noop (err) {
  if (err) throw err
}
