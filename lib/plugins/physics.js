const { Vec3 } = require('vec3')
const assert = require('assert')
const math = require('../math')
const conv = require('../conversions')
const { performance } = require('perf_hooks')
const { createDoneTask, createTask } = require('../promise_utils')

const { Physics, PlayerState } = require('prismarine-physics')

module.exports = inject

const PI = Math.PI
const PI_2 = Math.PI * 2
const PHYSICS_INTERVAL_MS = 50
const PHYSICS_TIMESTEP = PHYSICS_INTERVAL_MS / 1000 // 0.05

function inject (bot, { physicsEnabled, maxCatchupTicks }) {
  const PHYSICS_CATCHUP_TICKS = maxCatchupTicks ?? 4
  const world = { getBlock: (pos) => { return bot.blockAt(pos, false) } }
  const physics = Physics(bot.registry, world)

  const positionUpdateSentEveryTick = bot.supportFeature('positionUpdateSentEveryTick')

  bot.jumpQueued = false
  bot.jumpTicks = 0 // autojump cooldown

  const controlState = {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    sneak: false
  }
  let lastSentYaw = null
  let lastSentPitch = null
  let doPhysicsTimer = null
  let lastPhysicsFrameTime = null
  let shouldUsePhysics = false
  bot.physicsEnabled = physicsEnabled ?? true
  let deadTicks = 21

  const lastSent = {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    onGround: false,
    time: 0,
    flags: { onGround: false, hasHorizontalCollision: false }
  }

  // --- Invalid-movement defense ---------------------------------------------
  // Vanilla servers kick with multiplayer.disconnect.invalid_player_movement
  // when a serverbound move packet contains NaN or Infinity. NaN is sticky once
  // it enters entity state (yaw += NaN stays NaN forever), so state is
  // validated each tick and non-finite values are restored from lastSent --
  // the last values the server itself accepted. A short trace of movement
  // events is kept so a kick can be diagnosed after the fact.
  const MOVEMENT_TRACE_MAX = 40
  const movementTrace = []

  function trace (kind, data) {
    movementTrace.push(Object.assign({ t: Date.now(), kind }, data))
    if (movementTrace.length > MOVEMENT_TRACE_MAX) movementTrace.shift()
  }

  bot.getMovementTrace = () => movementTrace.slice()

  function isFiniteVec (vec) {
    return vec != null && Number.isFinite(vec.x) && Number.isFinite(vec.y) && Number.isFinite(vec.z)
  }

  function finiteOr (value, fallback) {
    return Number.isFinite(value) ? value : fallback
  }

  // Returns true if state was already clean, false if a recovery was needed.
  function recoverEntityState (source) {
    const invalid = []
    if (!isFiniteVec(bot.entity.position)) {
      bot.entity.position.set(lastSent.x, lastSent.y, lastSent.z)
      bot.entity.velocity.set(0, 0, 0)
      invalid.push('position')
    }
    if (!isFiniteVec(bot.entity.velocity)) {
      bot.entity.velocity.set(0, 0, 0)
      invalid.push('velocity')
    }
    if (!Number.isFinite(bot.entity.yaw) || !Number.isFinite(lastSentYaw)) {
      bot.entity.yaw = conv.fromNotchianYaw(lastSent.yaw)
      lastSentYaw = bot.entity.yaw
      invalid.push('yaw')
    }
    if (!Number.isFinite(bot.entity.pitch) || !Number.isFinite(lastSentPitch)) {
      bot.entity.pitch = conv.fromNotchianPitch(lastSent.pitch)
      lastSentPitch = bot.entity.pitch
      invalid.push('pitch')
    }
    if (invalid.length === 0) return true
    trace('recover', { source, fields: invalid.join(',') })
    console.warn(`[physics] event=invalid_state_recovered source=${source} fields=${invalid.join(',')}`)
    bot.emit('botInvalidState', { source, fields: invalid })
    return false
  }
  // ---------------------------------------------------------------------------

  // This function should be executed each tick (every 0.05 seconds)
  // How it works: https://gafferongames.com/post/fix_your_timestep/

  // WARNING: THIS IS NOT ACCURATE ON WINDOWS (15.6 Timer Resolution)
  // use WSL or switch to Linux
  // see: https://discord.com/channels/413438066984747026/519952494768685086/901948718255833158
  let timeAccumulator = 0
  let catchupTicks = 0
  function doPhysics () {
    const now = performance.now()
    const deltaSeconds = (now - lastPhysicsFrameTime) / 1000
    lastPhysicsFrameTime = now

    timeAccumulator += deltaSeconds
    catchupTicks = 0
    while (timeAccumulator >= PHYSICS_TIMESTEP) {
      tickPhysics(now)
      timeAccumulator -= PHYSICS_TIMESTEP
      catchupTicks++
      if (catchupTicks >= PHYSICS_CATCHUP_TICKS) break
    }
  }

  function tickPhysics (now) {
    // A non-finite position would make blockAt return null below and silently
    // freeze the physics loop forever; recover before the chunk check.
    if (shouldUsePhysics) recoverEntityState('tickPhysics')
    if (bot.blockAt(bot.entity.position) == null) return // check if chunk is unloaded
    if (bot.physicsEnabled && shouldUsePhysics) {
      physics.simulatePlayer(new PlayerState(bot, controlState), world).apply(bot)
      bot.emit('physicsTick')
      bot.emit('physicTick') // Deprecated, only exists to support old plugins. May be removed in the future
    }
    if (shouldUsePhysics) {
      updatePosition(now)
    }
  }

  // remove this when 'physicTick' is removed
  bot.on('newListener', (name) => {
    if (name === 'physicTick') console.warn('Mineflayer detected that you are using a deprecated event (physicTick)! Please use this event (physicsTick) instead.')
  })

  function cleanup () {
    clearInterval(doPhysicsTimer)
    doPhysicsTimer = null
  }

  // Final backstop: a packet with a non-finite field must never reach the
  // wire, whatever the caller. Dropping one packet is always recoverable;
  // sending NaN is an instant invalid_player_movement kick.
  function dropInvalidPacket (kind, fields) {
    trace('drop_packet', Object.assign({ packet: kind }, fields))
    console.warn(`[physics] event=invalid_packet_dropped packet=${kind} fields=${JSON.stringify(fields)}`)
    return undefined
  }

  function sendPacketPosition (position, onGround) {
    // sends data, no logic
    if (!isFiniteVec(position)) {
      return dropInvalidPacket('position', { x: String(position?.x), y: String(position?.y), z: String(position?.z) })
    }
    const oldPos = new Vec3(lastSent.x, lastSent.y, lastSent.z)
    lastSent.x = position.x
    lastSent.y = position.y
    lastSent.z = position.z
    lastSent.onGround = onGround
    lastSent.flags = { onGround, hasHorizontalCollision: undefined } // 1.21.3+
    trace('position', { x: position.x, y: position.y, z: position.z, onGround })
    bot._client.write('position', lastSent)
    bot.emit('move', oldPos)
  }

  function sendPacketLook (yaw, pitch, onGround) {
    // sends data, no logic
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) {
      return dropInvalidPacket('look', { yaw: String(yaw), pitch: String(pitch) })
    }
    const oldPos = new Vec3(lastSent.x, lastSent.y, lastSent.z)
    lastSent.yaw = yaw
    lastSent.pitch = pitch
    lastSent.onGround = onGround
    lastSent.flags = { onGround, hasHorizontalCollision: undefined } // 1.21.3+
    trace('look', { yaw, pitch, onGround })
    bot._client.write('look', lastSent)
    bot.emit('move', oldPos)
  }

  function sendPacketPositionAndLook (position, yaw, pitch, onGround) {
    // sends data, no logic
    if (!isFiniteVec(position) || !Number.isFinite(yaw) || !Number.isFinite(pitch)) {
      return dropInvalidPacket('position_look', {
        x: String(position?.x), y: String(position?.y), z: String(position?.z), yaw: String(yaw), pitch: String(pitch)
      })
    }
    const oldPos = new Vec3(lastSent.x, lastSent.y, lastSent.z)
    lastSent.x = position.x
    lastSent.y = position.y
    lastSent.z = position.z
    lastSent.yaw = yaw
    lastSent.pitch = pitch
    lastSent.onGround = onGround
    lastSent.flags = { onGround, hasHorizontalCollision: undefined } // 1.21.3+
    trace('position_look', { x: position.x, y: position.y, z: position.z, yaw, pitch, onGround })
    bot._client.write('position_look', lastSent)
    bot.emit('move', oldPos)
  }

  function deltaYaw (yaw1, yaw2) {
    let dYaw = (yaw1 - yaw2) % PI_2
    if (dYaw < -PI) dYaw += PI_2
    else if (dYaw > PI) dYaw -= PI_2

    return dYaw
  }

  // returns false if bot should send position packets
  function isEntityRemoved () {
    if (bot.isAlive === true) deadTicks = 0
    if (bot.isAlive === false && deadTicks <= 20) deadTicks++
    if (deadTicks >= 20) return true
    return false
  }

  function updatePosition (now) {
    // Only send updates for 20 ticks after death
    if (isEntityRemoved()) return

    // Catches NaN produced after the tickPhysics check (e.g. by the physics
    // simulation itself); skip this tick and send the restored state next one.
    if (!recoverEntityState('updatePosition')) return

    // Increment the yaw in baby steps so that notchian clients (not the server) can keep up.
    const dYaw = deltaYaw(bot.entity.yaw, lastSentYaw)
    const dPitch = bot.entity.pitch - (lastSentPitch || 0)

    // Vanilla doesn't clamp yaw, so we don't want to do it either
    const maxDeltaYaw = PHYSICS_TIMESTEP * physics.yawSpeed
    const maxDeltaPitch = PHYSICS_TIMESTEP * physics.pitchSpeed
    lastSentYaw += math.clamp(-maxDeltaYaw, dYaw, maxDeltaYaw)
    lastSentPitch += math.clamp(-maxDeltaPitch, dPitch, maxDeltaPitch)

    const yaw = Math.fround(conv.toNotchianYaw(lastSentYaw))
    const pitch = Math.fround(conv.toNotchianPitch(lastSentPitch))
    const position = bot.entity.position
    const onGround = bot.entity.onGround

    // Only send a position update if necessary, select the appropriate packet
    const positionUpdated = lastSent.x !== position.x || lastSent.y !== position.y || lastSent.z !== position.z ||
      // Send a position update every second, even if no other update was made
      // This function rounds to the nearest 50ms (or PHYSICS_INTERVAL_MS) and checks if a second has passed.
      (Math.round((now - lastSent.time) / PHYSICS_INTERVAL_MS) * PHYSICS_INTERVAL_MS) >= 1000
    const lookUpdated = lastSent.yaw !== yaw || lastSent.pitch !== pitch

    if (positionUpdated && lookUpdated) {
      sendPacketPositionAndLook(position, yaw, pitch, onGround)
      lastSent.time = now // only reset if positionUpdated is true
    } else if (positionUpdated) {
      sendPacketPosition(position, onGround)
      lastSent.time = now // only reset if positionUpdated is true
    } else if (lookUpdated) {
      sendPacketLook(yaw, pitch, onGround)
    } else if (positionUpdateSentEveryTick || onGround !== lastSent.onGround) {
      // For versions < 1.12, one player packet should be sent every tick
      // for the server to update health correctly
      // For versions >= 1.12, onGround !== lastSent.onGround should be used, but it doesn't ever trigger outside of login
      bot._client.write('flying', {
        onGround: bot.entity.onGround,
        flags: { onGround: bot.entity.onGround, hasHorizontalCollision: undefined } // 1.21.3+
      })
    }

    lastSent.onGround = bot.entity.onGround // onGround is always set
  }

  bot.physics = physics

  function getEffectLevel (mcData, effectName, effects) {
    const effectDescriptor = mcData.effectsByName[effectName]
    if (!effectDescriptor) {
      return 0
    }
    const effectInfo = effects[effectDescriptor.id]
    if (!effectInfo) {
      return 0
    }
    return effectInfo.amplifier + 1
  }

  bot.elytraFly = async () => {
    if (bot.entity.elytraFlying) {
      throw new Error('Already elytra flying')
    } else if (bot.entity.onGround) {
      throw new Error('Unable to fly from ground')
    } else if (bot.entity.isInWater) {
      throw new Error('Unable to elytra fly while in water')
    }

    const mcData = require('minecraft-data')(bot.version)
    if (getEffectLevel(mcData, 'Levitation', bot.entity.effects) > 0) {
      throw new Error('Unable to elytra fly with levitation effect')
    }

    const torsoSlot = bot.getEquipmentDestSlot('torso')
    const item = bot.inventory.slots[torsoSlot]
    if (item == null || item.name !== 'elytra') {
      throw new Error('Elytra must be equip to start flying')
    }
    bot._client.write('entity_action', {
      entityId: bot.entity.id,
      actionId: bot.supportFeature('entityActionUsesStringMapper') ? 'start_elytra_flying' : 8,
      jumpBoost: 0
    })
  }

  bot.setControlState = (control, state) => {
    assert.ok(control in controlState, `invalid control: ${control}`)
    assert.ok(typeof state === 'boolean', `invalid state: ${state}`)
    if (controlState[control] === state) return
    controlState[control] = state
    if (control === 'jump' && state) {
      bot.jumpQueued = true
    } else if (control === 'sprint') {
      bot._client.write('entity_action', {
        entityId: bot.entity.id,
        actionId: bot.supportFeature('entityActionUsesStringMapper')
          ? (state ? 'start_sprinting' : 'stop_sprinting')
          : (state ? 3 : 4),
        jumpBoost: 0
      })
    } else if (control === 'sneak') {
      if (bot.supportFeature('newPlayerInputPacket')) {
        // In 1.21.6+, sneak is handled via player_input packet
        bot._client.write('player_input', {
          inputs: {
            shift: state
          }
        })
      } else {
        // Legacy entity_action approach for older versions
        bot._client.write('entity_action', {
          entityId: bot.entity.id,
          actionId: state ? 0 : 1,
          jumpBoost: 0
        })
      }
    }
  }

  bot.getControlState = (control) => {
    assert.ok(control in controlState, `invalid control: ${control}`)
    return controlState[control]
  }

  bot.clearControlStates = () => {
    for (const control in controlState) {
      bot.setControlState(control, false)
    }
  }

  bot.controlState = {}

  for (const control of Object.keys(controlState)) {
    Object.defineProperty(bot.controlState, control, {
      get () {
        return controlState[control]
      },
      set (state) {
        bot.setControlState(control, state)
        return state
      }
    })
  }

  let lookingTask = createDoneTask()

  bot.on('move', () => {
    if (!lookingTask.done && Math.abs(deltaYaw(bot.entity.yaw, lastSentYaw)) < 0.001) {
      lookingTask.finish()
    }
  })

  bot._client.on('explosion', explosion => {
    // TODO: emit an explosion event with more info
    // Number.isFinite (not typeof checks) is required here: typeof NaN is
    // 'number', and NaN knockback poisons velocity -> position -> kick.
    if (bot.physicsEnabled && bot.game.gameMode !== 'creative') {
      // Modern protocol (1.21.3+): vector knockback
      const knockback = explosion.playerKnockback
      if (knockback != null && isFiniteVec(knockback)) {
        // Fixes issue #3635
        bot.entity.velocity.x += knockback.x
        bot.entity.velocity.y += knockback.y
        bot.entity.velocity.z += knockback.z
        trace('explosion_knockback', { x: knockback.x, y: knockback.y, z: knockback.z })
      }
      // Legacy protocol: discrete motion components
      if (Number.isFinite(explosion.playerMotionX) &&
          Number.isFinite(explosion.playerMotionY) &&
          Number.isFinite(explosion.playerMotionZ)) {
        bot.entity.velocity.x += explosion.playerMotionX
        bot.entity.velocity.y += explosion.playerMotionY
        bot.entity.velocity.z += explosion.playerMotionZ
        trace('explosion_knockback', { x: explosion.playerMotionX, y: explosion.playerMotionY, z: explosion.playerMotionZ })
      }
    }
  })

  bot.look = async (yaw, pitch, force) => {
    // NaN here would poison bot.entity.yaw/pitch permanently (and with force,
    // lastSentYaw directly) -> invalid_player_movement kick.
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) {
      trace('invalid_look', { yaw: String(yaw), pitch: String(pitch) })
      console.warn(`[physics] event=invalid_look_ignored yaw=${yaw} pitch=${pitch}`)
      return
    }
    if (!lookingTask.done) {
      lookingTask.finish() // finish the previous one
    }
    lookingTask = createTask()

    // this is done to bypass certain anticheat checks that detect the player's sensitivity
    // by calculating the gcd of how much they move the mouse each tick
    const sensitivity = conv.fromNotchianPitch(0.15) // this is equal to 100% sensitivity in vanilla
    const yawChange = Math.round((yaw - bot.entity.yaw) / sensitivity) * sensitivity
    const pitchChange = Math.round((pitch - bot.entity.pitch) / sensitivity) * sensitivity

    if (yawChange === 0 && pitchChange === 0) {
      return
    }

    bot.entity.yaw += yawChange
    bot.entity.pitch += pitchChange

    if (force) {
      lastSentYaw = yaw
      lastSentPitch = pitch
      return
    }

    await lookingTask.promise
  }

  bot.lookAt = async (point, force) => {
    // Corrupt tracked-entity positions (seen with modded entities) must not
    // propagate into our own yaw/pitch.
    if (!isFiniteVec(point)) {
      trace('invalid_look_at', { x: String(point?.x), y: String(point?.y), z: String(point?.z) })
      console.warn(`[physics] event=invalid_look_at_ignored point=${point}`)
      return
    }
    const eyeHeight = finiteOr(bot.entity.eyeHeight, 1.62)
    const delta = point.minus(bot.entity.position.offset(0, eyeHeight, 0))
    const yaw = Math.atan2(-delta.x, -delta.z)
    const groundDistance = Math.sqrt(delta.x * delta.x + delta.z * delta.z)
    const pitch = Math.atan2(delta.y, groundDistance)
    await bot.look(yaw, pitch, force)
  }

  // 1.21.3+
  bot._client.on('player_rotation', (packet) => {
    if (!Number.isFinite(packet.yaw) || !Number.isFinite(packet.pitch)) return
    bot.entity.yaw = conv.fromNotchianYaw(packet.yaw)
    bot.entity.pitch = conv.fromNotchianPitch(packet.pitch)
  })

  // player position and look (clientbound)
  bot._client.on('position', (packet) => {
    // Is this necessary? Feels like it might wrongly overwrite hitbox size sometimes
    // e.g. when crouching/crawling/swimming. Can someone confirm?
    bot.entity.height = 1.8

    const vel = bot.entity.velocity
    const pos = bot.entity.position
    let nextX, nextY, nextZ
    let newYaw, newPitch

    // Note: 1.20.5+ uses a bitflags object, older versions use a bitmask number
    if (typeof packet.flags === 'object') {
      // Modern path with bitflags object
      // Velocity is only set to 0 if the flag is not set, otherwise keep current velocity
      vel.set(
        packet.flags.x ? vel.x : 0,
        packet.flags.y ? vel.y : 0,
        packet.flags.z ? vel.z : 0
      )
      // If flag is set, then the corresponding value is relative, else it is absolute
      nextX = packet.flags.x ? (pos.x + packet.x) : packet.x
      nextY = packet.flags.y ? (pos.y + packet.y) : packet.y
      nextZ = packet.flags.z ? (pos.z + packet.z) : packet.z
      newYaw = (packet.flags.yaw ? conv.toNotchianYaw(bot.entity.yaw) : 0) + packet.yaw
      newPitch = (packet.flags.pitch ? conv.toNotchianPitch(bot.entity.pitch) : 0) + packet.pitch
    } else {
      // Legacy path with bitmask number
      // Velocity is only set to 0 if the flag is not set, otherwise keep current velocity
      vel.set(
        packet.flags & 1 ? vel.x : 0,
        packet.flags & 2 ? vel.y : 0,
        packet.flags & 4 ? vel.z : 0
      )
      // If flag is set, then the corresponding value is relative, else it is absolute
      nextX = packet.flags & 1 ? (pos.x + packet.x) : packet.x
      nextY = packet.flags & 2 ? (pos.y + packet.y) : packet.y
      nextZ = packet.flags & 4 ? (pos.z + packet.z) : packet.z
      newYaw = (packet.flags & 8 ? conv.toNotchianYaw(bot.entity.yaw) : 0) + packet.yaw
      newPitch = (packet.flags & 16 ? conv.toNotchianPitch(bot.entity.pitch) : 0) + packet.pitch
    }

    // A buggy or modded server could send non-finite values here; applying
    // them (and echoing them back below) would get us kicked for
    // invalid_player_movement. Fall back per component to the last
    // known-good value. lastSent only ever holds server-accepted values.
    if (![nextX, nextY, nextZ, newYaw, newPitch, vel.x, vel.y, vel.z].every(Number.isFinite)) {
      trace('invalid_forced_move', { x: String(nextX), y: String(nextY), z: String(nextZ), yaw: String(newYaw), pitch: String(newPitch) })
      console.warn(`[physics] event=invalid_forced_move_sanitized x=${nextX} y=${nextY} z=${nextZ} yaw=${newYaw} pitch=${newPitch}`)
      nextX = finiteOr(nextX, finiteOr(pos.x, lastSent.x))
      nextY = finiteOr(nextY, finiteOr(pos.y, lastSent.y))
      nextZ = finiteOr(nextZ, finiteOr(pos.z, lastSent.z))
      newYaw = finiteOr(newYaw, lastSent.yaw)
      newPitch = finiteOr(newPitch, lastSent.pitch)
      vel.set(finiteOr(vel.x, 0), finiteOr(vel.y, 0), finiteOr(vel.z, 0))
    }
    pos.set(nextX, nextY, nextZ)
    trace('forced_move', { x: nextX, y: nextY, z: nextZ, yaw: newYaw, pitch: newPitch })

    bot.entity.yaw = conv.fromNotchianYaw(newYaw)
    bot.entity.pitch = conv.fromNotchianPitch(newPitch)
    bot.entity.onGround = false

    if (bot.supportFeature('teleportUsesOwnPacket')) {
      bot._client.write('teleport_confirm', { teleportId: packet.teleportId })
    }
    sendPacketPositionAndLook(pos, newYaw, newPitch, bot.entity.onGround)

    shouldUsePhysics = true
    bot.jumpTicks = 0
    lastSentYaw = bot.entity.yaw
    lastSentPitch = bot.entity.pitch

    bot.emit('forcedMove')
  })

  bot.waitForTicks = async function (ticks) {
    if (ticks <= 0) return
    await new Promise((resolve, reject) => {
      // Assuming 20 ticks per second, add extra time for lag
      const timeout = setTimeout(() => {
        bot.removeListener('physicsTick', tickListener)
        reject(new Error(`Timeout waiting for ${ticks} ticks after ${(ticks * 50 + 5000)}ms`))
      }, ticks * 50 + 5000) // 50ms per tick + 5s buffer

      const tickListener = () => {
        ticks--
        if (ticks === 0) {
          clearTimeout(timeout)
          bot.removeListener('physicsTick', tickListener)
          resolve()
        }
      }

      bot.on('physicsTick', tickListener)
    })
  }

  bot.on('mount', () => { shouldUsePhysics = false })
  bot.on('respawn', () => { shouldUsePhysics = false })
  bot.on('login', () => {
    shouldUsePhysics = false
    if (doPhysicsTimer === null) {
      lastPhysicsFrameTime = performance.now()
      doPhysicsTimer = setInterval(doPhysics, PHYSICS_INTERVAL_MS)
    }
  })
  bot.on('end', cleanup)
}
