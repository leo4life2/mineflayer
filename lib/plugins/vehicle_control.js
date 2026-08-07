const conv = require('../conversions')

module.exports = inject

// Client-authoritative vehicle movement channel (mounted-nav doctrine,
// live-measured on 1.21.1):
//
// - While a player rides a "steerable" vehicle (horse family, camel, pig,
//   strider, boat, chest boat) the SERVER DOES NOT SIMULATE the vehicle's
//   travel. The riding client authors positions via serverbound
//   `vehicle_move` packets and the server validates+applies them.
//   `steer_vehicle` / `steer_boat` move nothing server-side on 1.21.1 —
//   the fork's pre-existing `bot.moveVehicle()` therefore cannot move any
//   vehicle; this plugin is the missing author.
// - Acceptance envelope (measured): per-packet displacement <= 9.9 blocks
//   (vanilla dist² > 100 check rejects), sustained 20 Hz streams fully
//   accepted, rejection is a console WARN + a clientbound `vehicle_move`
//   rubber-band, never a kick. The ONLY vehicle kick is the floating
//   watchdog (~4 s unsupported hover).
// - The server echoes accepted vehicle motion back through the normal
//   entity-move packets, which the entities plugin already applies
//   (including the combat-era passenger position sync), so the local model
//   stays truthful without this plugin mutating positions on the send side.
// - A clientbound `vehicle_move` is the rejection/correction signal: the
//   server telling the rider where the vehicle actually is. This plugin
//   applies it to the vehicle + passengers and re-emits it as
//   `vehicleRebase` so a driving layer can re-base its authored stream.
//
// Policy (speed, terrain-hugging, pathing) deliberately lives ABOVE this
// plugin — this is only the protocol primitive.
function inject (bot) {
  let rebaseCount = 0
  let lastRebase = null
  let authoredCount = 0

  // Hard protocol-safety clamp, NOT a speed policy: vanilla rejects any
  // vehicle_move whose displacement exceeds 10 blocks (measured: 9.9 ok,
  // 10.5 rejected). Refuse to author an over-envelope packet — a caller
  // bug should fail loudly here, not as a server-side rubber-band storm.
  const MAX_PACKET_DISPLACEMENT = 9.5

  bot._client.on('vehicle_move', (packet) => {
    rebaseCount++
    lastRebase = {
      x: packet.x,
      y: packet.y,
      z: packet.z,
      yaw: packet.yaw,
      pitch: packet.pitch,
      time: Date.now()
    }
    const vehicle = bot.vehicle
    if (vehicle) {
      vehicle.position.set(packet.x, packet.y, packet.z)
      // Reuse the entities plugin's passenger sync so the rider model
      // (including bot.entity) is corrected with the vehicle.
      if (typeof bot._updatePassengerPositions === 'function') {
        bot._updatePassengerPositions(vehicle)
      }
      bot.emit('entityMoved', vehicle)
    }
    bot.emit('vehicleRebase', lastRebase)
  })

  function authorVehicleMove (x, y, z, yaw = 0, pitch = 0) {
    const vehicle = bot.vehicle
    if (!vehicle) throw new Error('authorVehicleMove: not mounted on a vehicle')
    const dx = x - vehicle.position.x
    const dy = y - vehicle.position.y
    const dz = z - vehicle.position.z
    const displacement = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (displacement > MAX_PACKET_DISPLACEMENT) {
      throw new Error(`authorVehicleMove: displacement ${displacement.toFixed(2)} exceeds the ${MAX_PACKET_DISPLACEMENT} block per-packet envelope`)
    }
    // yaw/pitch are mineflayer-convention radians; the wire wants notchian
    // degrees. onGround is tolerated-extra on schemas without the field and
    // required-present on the ones that have it.
    bot._client.write('vehicle_move', {
      x,
      y,
      z,
      yaw: conv.toNotchianYaw(yaw),
      pitch: conv.toNotchianPitch(pitch),
      onGround: true
    })
    authoredCount++
    // Do NOT locally mutate vehicle/rider positions here: the server echoes
    // accepted motion via normal entity-move packets (measured on every
    // steerable class) and rejections arrive as vehicleRebase — mutating on
    // send would double-apply against that echo.
  }

  // Rider look channel (measured on the riding-yaw rig, 1.21.1): while
  // mounted, mineflayer's physics loop is gated off ('mount' sets
  // shouldUsePhysics=false), so NOTHING transmits the rider's rotation —
  // bot.look() only mutates the local model. Server-side the rider's yaw
  // stays frozen at its mount-time value, and every server tick the ridden
  // mob's rotation is re-asserted FROM the rider's stale yaw, fighting the
  // yaw we author in vehicle_move (measured: horse Rotation alternates
  // per-tick between the authored heading and the stale rider yaw).
  // Vanilla riding clients send MovePlayer.Rot ('look') each tick — the
  // server accepts rotation-only updates from passengers. This primitive is
  // that channel: one 'look' packet + local model truth, so the server's
  // rider->mob rotation copy and the authored vehicle_move yaw agree.
  function authorRiderLook (yaw = 0, pitch = 0) {
    if (!bot.vehicle) throw new Error('authorRiderLook: not mounted on a vehicle')
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) {
      throw new Error(`authorRiderLook: non-finite rotation yaw=${yaw} pitch=${pitch}`)
    }
    bot._client.write('look', {
      yaw: Math.fround(conv.toNotchianYaw(yaw)),
      pitch: Math.fround(conv.toNotchianPitch(pitch)),
      onGround: false,
      flags: { onGround: false, hasHorizontalCollision: undefined } // 1.21.3+ schemas
    })
    // Local model truth: perception reads bot.entity.yaw; the passenger sync
    // (entities.js) only touches positions, so this is the single writer.
    bot.entity.yaw = yaw
    bot.entity.pitch = pitch
  }

  bot.vehicleControl = {
    authorVehicleMove,
    authorRiderLook,
    get rebaseCount () { return rebaseCount },
    get lastRebase () { return lastRebase },
    get authoredCount () { return authoredCount },
    maxPacketDisplacement: MAX_PACKET_DISPLACEMENT
  }
}
