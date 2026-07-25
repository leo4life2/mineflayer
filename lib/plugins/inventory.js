const assert = require('assert')
const { Vec3 } = require('vec3')
const conv = require('../conversions')
const { once, sleep, createDoneTask, createTask, withTimeout } = require('../promise_utils')

module.exports = inject

// ms to wait before clicking on a tool so the server can send the new
// damage information
const DIG_CLICK_TIMEOUT = 500
// The number of milliseconds to wait for the server to respond with consume completion.
// This number is larger than the eat time of 1.61 seconds to account for latency and low tps.
// The eat time comes from https://minecraft.wiki/w/Food#Usage
const CONSUME_TIMEOUT = 2500
// milliseconds to wait for the server to respond to a window click transaction
const WINDOW_TIMEOUT = 5000
// 1.17+ has no transaction acks: after each click, wait for the server's
// response burst for that window to END (quiet gap) before the next click.
// Waiting for the FIRST packet is not enough — under concurrent traffic
// (pickups mid-craft) in-flight noise "pays for" the next click instantly
// and the burst outruns the server again (soak-proven 2026-07-25).
const CLICK_QUIET_MS = 60 // > 1 server tick of silence = burst is over
const CLICK_SETTLE_CAP_MS = 750 // never stall one click longer than this

const ALWAYS_CONSUMABLES = [
  'potion',
  'milk_bucket',
  'enchanted_golden_apple',
  'golden_apple'
]

function inject (bot, { hideErrors }) {
  const Item = require('prismarine-item')(bot.registry)
  const windows = require('prismarine-windows')(bot.version)

  let eatingTask = createDoneTask()
  let sequence = 0

  let nextActionNumber = 0 // < 1.17
  // Server-side, EVERY container menu has its own stateId counter (a fresh
  // menu restarts near 1); window_click must echo the last stateId the server
  // broadcast FOR THE MENU BEING CLICKED. A single global cache is poisoned
  // by every unsolicited player-inventory update (pickups, offhand refresh,
  // durability) while a container is open, which makes every click stale ->
  // the server answers each one with a full-state resync (the "resync storm"
  // behind the crafting/window desync class). Wire-proven on Paper 1.21.1
  // (tools/desync-rig, 2026-07-25). Track stateIds per windowId instead.
  const stateIds = new Map() // windowId -> last stateId broadcast for that menu
  // set_slot windowId -1 (cursor) / -2 (direct inventory write) arrive from
  // the server's ACTIVE-menu synchronizer; some protocol layers hand them to
  // us as unsigned bytes (255/254).
  const normWindowId = (id) => (id > 127 && id < 256 ? id - 256 : id)
  const stateIdFor = (windowId) => stateIds.get(windowId) ?? 0
  if (bot.supportFeature('stateIdUsed')) {
    const listener = packet => {
      if (typeof packet.stateId !== 'number') return
      const wid = normWindowId(packet.windowId)
      if (wid === -1 || wid === -2) {
        // active-menu synchronizer channels: the stateId belongs to whichever
        // menu the server is currently syncing (open container, else inventory)
        stateIds.set((bot.currentWindow || bot.inventory).id, packet.stateId)
      } else {
        stateIds.set(wid, packet.stateId)
      }
    }
    bot._client.on('window_items', listener)
    bot._client.on('set_slot', listener)
    // a fresh menu starts a fresh counter server-side
    bot._client.on('open_window', packet => { stateIds.delete(packet.windowId) })
    bot._client.on('open_horse_window', packet => { stateIds.delete(packet.windowId) })
  }
  const windowClickQueue = []

  // 0-8, null = uninitialized
  // which quick bar slot is selected
  bot.quickBarSlot = null
  bot.inventory = windows.createWindow(0, 'minecraft:inventory', 'Inventory')
  bot.currentWindow = null
  bot.usingHeldItem = false

  Object.defineProperty(bot, 'heldItem', {
    get: function () {
      return bot.inventory.slots[bot.QUICK_BAR_START + bot.quickBarSlot]
    }
  })

  bot.on('spawn', () => {
    Object.defineProperty(bot.entity, 'equipment', {
      get: bot.supportFeature('doesntHaveOffHandSlot')
        ? function () {
          return [bot.heldItem, bot.inventory.slots[8], bot.inventory.slots[7],
            bot.inventory.slots[6], bot.inventory.slots[5]]
        }
        : function () {
          return [bot.heldItem, bot.inventory.slots[45], bot.inventory.slots[8],
            bot.inventory.slots[7], bot.inventory.slots[6], bot.inventory.slots[5]]
        }
    })
  })

  bot._client.on('entity_status', (packet) => {
    if (packet.entityId === bot.entity.id && packet.entityStatus === 9 && !eatingTask.done) {
      eatingTask.finish()
    }
    bot.usingHeldItem = false
  })

  let previousHeldItem = null
  bot.on('heldItemChanged', (heldItem) => {
    // we only disable the item if the item type or count changes
    if (
      heldItem?.type === previousHeldItem?.type && heldItem?.count === previousHeldItem?.count
    ) {
      previousHeldItem = heldItem
      return
    }
    if (!eatingTask.done) {
      eatingTask.finish()
    }
    bot.usingHeldItem = false
  })

  bot._client.on('set_cooldown', (packet) => {
    if (bot.heldItem && bot.heldItem.type !== packet.itemID) return
    if (!eatingTask.done) {
      eatingTask.finish()
    }
    bot.usingHeldItem = false
  })

  async function consume () {
    if (!eatingTask.done) {
      eatingTask.cancel(new Error('Consuming cancelled due to calling bot.consume() again'))
    }

    if (bot.game.gameMode !== 'creative' && !ALWAYS_CONSUMABLES.includes(bot.heldItem.name) && bot.food === 20) {
      throw new Error('Food is full')
    }

    eatingTask = createTask()

    activateItem()

    await withTimeout(eatingTask.promise, CONSUME_TIMEOUT)
  }

  function activateItem (offHand = false) {
    bot.usingHeldItem = true
    sequence++

    if (bot.supportFeature('useItemWithBlockPlace')) {
      bot._client.write('block_place', {
        location: new Vec3(-1, 255, -1),
        direction: -1,
        heldItem: Item.toNotch(bot.heldItem),
        cursorX: -1,
        cursorY: -1,
        cursorZ: -1
      })
    } else if (bot.supportFeature('useItemWithOwnPacket')) {
      // Rotation MUST carry the bot's real look (protocol degrees:
      // x = yaw, y = pitch, negative pitch = up). A hardcoded {0,0} makes the
      // server SNAP the player rotation to yaw=0/pitch=0 on every item use —
      // rig-proven on Paper 1.21.1 (bow-25694 probes, 2026-07-24): drawn bows
      // fired due south regardless of aim, shields/food yanked the server-side
      // look the same way. A use_item with populated rotation aims correctly
      // with zero look packets (probe1d EXP-e/e2: {"x":-90,"y":0} ->
      // server Rotation [-90.0f,0.0f], arrow heading -90.52).
      // Versions whose use_item schema lacks the rotation field ignore the
      // extra param (protodef drops unknown fields) — safe across versions.
      bot._client.write('use_item', {
        hand: offHand ? 1 : 0,
        sequence,
        rotation: {
          x: Math.fround(conv.toNotchianYaw(bot.entity?.yaw ?? 0)),
          y: Math.fround(conv.toNotchianPitch(bot.entity?.pitch ?? 0))
        }
      })
    }
  }

  function deactivateItem () {
    const body = {
      status: 5,
      location: new Vec3(0, 0, 0),
      face: 5
    }

    if (bot.supportFeature('useItemWithOwnPacket')) {
      body.face = 0
      body.sequence = 0
    }

    bot._client.write('block_dig', body)

    bot.usingHeldItem = false
  }

  async function putSelectedItemRange (start, end, window, slot) {
    // put the selected item back indow the slot range in window

    // try to put it in an item that already exists and just increase
    // the count.

    while (window.selectedItem) {
      const item = window.findItemRange(start, end, window.selectedItem.type, window.selectedItem.metadata, true, window.selectedItem.nbt)

      if (item && item.stackSize !== item.count) { // something to join with
        await clickWindow(item.slot, 0, 0, window)
      } else { // nothing to join with
        const emptySlot = window.firstEmptySlotRange(start, end)
        if (emptySlot === null) { // no room left
          if (slot === null) { // no room => drop it
            await tossLeftover()
          } else { // if there is still some leftover and slot is not null, click slot
            await clickWindow(slot, 0, 0, window)
            await tossLeftover()
          }
        } else {
          await clickWindow(emptySlot, 0, 0, window)
        }
      }
    }

    async function tossLeftover () {
      if (window.selectedItem) {
        await clickWindow(-999, 0, 0, window)
      }
    }
  }

  async function activateBlock (block, direction, cursorPos) {
    direction = direction ?? new Vec3(0, 1, 0)
    const directionNum = vectorToDirection(direction) // The packet needs a number as the direction
    cursorPos = cursorPos ?? new Vec3(0.5, 0.5, 0.5)
    // TODO: tell the server that we are not sneaking while doing this
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), false)
    // place block message
    // TODO: logic below can likely be simplified
    if (bot.supportFeature('blockPlaceHasHeldItem')) {
      bot._client.write('block_place', {
        location: block.position,
        direction: directionNum,
        heldItem: Item.toNotch(bot.heldItem),
        cursorX: cursorPos.scaled(16).x,
        cursorY: cursorPos.scaled(16).y,
        cursorZ: cursorPos.scaled(16).z
      })
    } else if (bot.supportFeature('blockPlaceHasHandAndIntCursor')) {
      bot._client.write('block_place', {
        location: block.position,
        direction: directionNum,
        hand: 0,
        cursorX: cursorPos.scaled(16).x,
        cursorY: cursorPos.scaled(16).y,
        cursorZ: cursorPos.scaled(16).z
      })
    } else if (bot.supportFeature('blockPlaceHasHandAndFloatCursor')) {
      bot._client.write('block_place', {
        location: block.position,
        direction: directionNum,
        hand: 0,
        cursorX: cursorPos.x,
        cursorY: cursorPos.y,
        cursorZ: cursorPos.z
      })
    } else if (bot.supportFeature('blockPlaceHasInsideBlock')) {
      bot._client.write('block_place', {
        location: block.position,
        direction: directionNum,
        hand: 0,
        cursorX: cursorPos.x,
        cursorY: cursorPos.y,
        cursorZ: cursorPos.z,
        insideBlock: false,
        sequence: 0, // 1.19.0+
        worldBorderHit: false // 1.21.3+
      })
    }

    // swing arm animation
    bot.swingArm()
  }

  async function activateEntity (entity) {
    // TODO: tell the server that we are not sneaking while doing this
    await bot.lookAt(entity.position.offset(0, 1, 0), false)
    bot._client.write('use_entity', {
      target: entity.id,
      mouse: 0, // interact with entity
      sneaking: false,
      hand: 0 // interact with the main hand
    })
  }

  async function activateEntityAt (entity, position) {
    // TODO: tell the server that we are not sneaking while doing this
    await bot.lookAt(position, false)
    bot._client.write('use_entity', {
      target: entity.id,
      mouse: 2, // interact with entity at
      sneaking: false,
      hand: 0, // interact with the main hand
      x: position.x - entity.position.x,
      y: position.y - entity.position.y,
      z: position.z - entity.position.z
    })
  }

  async function transfer (options) {
    const window = options.window || bot.currentWindow || bot.inventory
    const itemType = options.itemType
    const metadata = options.metadata
    const nbt = options.nbt
    let count = (options.count === undefined || options.count === null) ? 1 : options.count
    let firstSourceSlot = null

    // ranges
    const sourceStart = options.sourceStart
    const destStart = options.destStart
    assert.notStrictEqual(sourceStart, null)
    assert.notStrictEqual(destStart, null)
    const sourceEnd = options.sourceEnd === null ? sourceStart + 1 : options.sourceEnd
    const destEnd = options.destEnd === null ? destStart + 1 : options.destEnd

    await transferOne()

    async function transferOne () {
      if (count === 0) {
        await putSelectedItemRange(sourceStart, sourceEnd, window, firstSourceSlot)
        return
      }
      if (!window.selectedItem || window.selectedItem.type !== itemType ||
        (metadata != null && window.selectedItem.metadata !== metadata) ||
        (nbt != null && window.selectedItem.nbt !== nbt)) {
        // we are not holding the item we need. click it.
        const sourceItem = window.findItemRange(sourceStart, sourceEnd, itemType, metadata, false, nbt)
        // The registry entry is only needed to name the item in the error
        // below. On a modded server the static registry doesn't know modded
        // ids, but the transfer itself works purely on the numeric id — a
        // hard assert here broke toss/deposit/putFuel for every modded stack.
        const mcDataEntry = bot.registry.itemsArray.find(x => x.id === itemType)
        const itemTypeName = mcDataEntry ? mcDataEntry.name : `item id ${itemType}`
        if (!sourceItem) throw new Error(`Can't find ${itemTypeName} in slots [${sourceStart} - ${sourceEnd}], (item id: ${itemType})`)
        if (firstSourceSlot === null) firstSourceSlot = sourceItem.slot
        // number of item that can be moved from that slot
        await clickWindow(sourceItem.slot, 0, 0, window)
      }
      await clickDest()

      async function clickDest () {
        assert.notStrictEqual(window.selectedItem.type, null)
        assert.notStrictEqual(window.selectedItem.metadata, null)
        let destItem
        let destSlot
        // special case for tossing
        if (destStart === -999) {
          destSlot = -999
        } else {
          // find a non full item that we can drop into
          destItem = window.findItemRange(destStart, destEnd,
            window.selectedItem.type, window.selectedItem.metadata, true, nbt)
          // if that didn't work find an empty slot to drop into
          destSlot = destItem
            ? destItem.slot
            : window.firstEmptySlotRange(destStart, destEnd)
          // if that didn't work, give up
          if (destSlot === null) {
            throw new Error('destination full')
          }
        }
        // move the maximum number of item that can be moved.
        // A left click at -999 tosses the ENTIRE held stack — that is window
        // mechanics, independent of stackSize. The stackSize math only
        // applies to real dest slots; prismarine's stackSize is a static-data
        // guess that is wrong (1) for modded items, and using it here made a
        // partial toss left-click a whole modded stack onto the ground and
        // then error out hunting for the remainder.
        const destSlotCount = destItem && destItem.count ? destItem.count : 0
        const movedItems = destSlot === -999
          ? window.selectedItem.count
          : Math.min(window.selectedItem.stackSize - destSlotCount, window.selectedItem.count)
        // if the number of item the left click moves is less than the number of item we want to move
        // several at the same time (left click)
        if (movedItems <= count) {
          await clickWindow(destSlot, 0, 0, window)
          // update the number of item we want to move (count)
          count -= movedItems
          await transferOne()
        } else {
          // one by one (right click)
          await clickWindow(destSlot, 1, 0, window)
          count -= 1
          await transferOne()
        }
      }
    }
  }

  function extendWindow (window) {
    window.close = () => {
      closeWindow(window)
      window.emit('close')
    }

    window.withdraw = async (itemType, metadata, count, nbt) => {
      if (bot.inventory.emptySlotCount() === 0) {
        throw new Error('Unable to withdraw, Bot inventory is full.')
      }
      const options = {
        window,
        itemType,
        metadata,
        count,
        nbt,
        sourceStart: 0,
        sourceEnd: window.inventoryStart,
        destStart: window.inventoryStart,
        destEnd: window.inventoryEnd
      }
      await transfer(options)
    }
    window.deposit = async (itemType, metadata, count, nbt) => {
      const options = {
        window,
        itemType,
        metadata,
        count,
        nbt,
        sourceStart: window.inventoryStart,
        sourceEnd: window.inventoryEnd,
        destStart: 0,
        destEnd: window.inventoryStart
      }
      await transfer(options)
    }
  }

  async function openBlock (block, direction, cursorPos) {
    bot.activateBlock(block, direction, cursorPos)
    const [window] = await once(bot, 'windowOpen')
    extendWindow(window)
    return window
  }

  async function openEntity (entity) {
    bot.activateEntity(entity)
    const [window] = await once(bot, 'windowOpen')
    extendWindow(window)
    return window
  }

  function createActionNumber () {
    nextActionNumber = nextActionNumber === 32767 ? 1 : nextActionNumber + 1
    return nextActionNumber
  }

  function updateHeldItem () {
    bot.emit('heldItemChanged', bot.heldItem)
  }

  function closeWindow (window) {
    bot._client.write('close_window', {
      windowId: window.id
    })
    copyInventory(window)
    if (window.id !== 0) stateIds.delete(window.id)
    bot.currentWindow = null
    bot.emit('windowClose', window)
  }

  function copyInventory (window) {
    const slotOffset = window.inventoryStart - bot.inventory.inventoryStart
    for (let i = window.inventoryStart; i < window.inventoryEnd; i++) {
      const item = window.slots[i]
      const slot = i - slotOffset
      if (item) {
        item.slot = slot
      }
      if (!Item.equal(bot.inventory.slots[slot], item, true)) bot.inventory.updateSlot(slot, item)
    }
  }

  function tradeMatch (limitItem, targetItem) {
    return (
      targetItem !== null &&
      limitItem !== null &&
      targetItem.type === limitItem.type &&
      targetItem.count >= limitItem.count
    )
  }

  function expectTradeUpdate (window) {
    const trade = window.selectedTrade
    const hasItem = !!window.slots[2]

    if (hasItem !== tradeMatch(trade.inputItem1, window.slots[0])) {
      if (trade.hasItem2) {
        return hasItem !== tradeMatch(trade.inputItem2, window.slots[1])
      }
      return true
    }
    return false
  }

  async function waitForWindowUpdate (window, slot) {
    if (window.type === 'minecraft:inventory') {
      if (slot >= 1 && slot <= 4) {
        await once(bot.inventory, 'updateSlot:0')
      }
    } else if (window.type === 'minecraft:crafting') {
      if (slot >= 1 && slot <= 9) {
        await once(bot.currentWindow, 'updateSlot:0')
      }
    } else if (window.type === 'minecraft:merchant') {
      const toUpdate = []
      if (slot <= 1 && !window.selectedTrade.tradeDisabled && expectTradeUpdate(window)) {
        toUpdate.push(once(bot.currentWindow, 'updateSlot:2'))
      }
      if (slot === 2) {
        for (const item of bot.currentWindow.containerItems()) {
          toUpdate.push(once(bot.currentWindow, `updateSlot:${item.slot}`))
        }
      }
      await Promise.all(toUpdate)

      if (slot === 2 && !window.selectedTrade.tradeDisabled && expectTradeUpdate(window)) {
        // After the trade goes through, if the inputs are still satisfied,
        // expect another update in slot 2
        await once(bot.currentWindow, 'updateSlot:2')
      }
    }
  }

  function confirmTransaction (windowId, actionId, accepted) {
    // drop the queue entries for all the clicks that the server did not send
    // transaction packets for.
    // Also reject transactions that aren't sent from mineflayer
    let click = windowClickQueue[0]
    if (click === undefined || !windowClickQueue.some(clicks => clicks.id === actionId)) {
      // mimic vanilla client and send a rejection for faulty transaction packets
      bot._client.write('transaction', {
        windowId,
        action: actionId,
        accepted: true
        // bot.emit(`confirmTransaction${click.id}`, false)
      })
      return
    }
    // shift it later if packets are sent out of order
    click = windowClickQueue.shift()

    assert.ok(click.id <= actionId)
    while (actionId > click.id) {
      onAccepted()
      click = windowClickQueue.shift()
    }
    assert.ok(click)

    if (accepted) {
      onAccepted()
    } else {
      onRejected()
    }
    updateHeldItem()

    function onAccepted () {
      const window = windowId === 0 ? bot.inventory : bot.currentWindow
      if (!window || window.id !== click.windowId) return
      window.acceptClick(click)
      bot.emit(`confirmTransaction${click.id}`, true)
    }

    function onRejected () {
      bot._client.write('transaction', {
        windowId: click.windowId,
        action: click.id,
        accepted: true
      })
      bot.emit(`confirmTransaction${click.id}`, false)
    }
  }

  function getChangedSlots (oldSlots, newSlots) {
    assert.equal(oldSlots.length, newSlots.length)

    const changedSlots = []

    for (let i = 0; i < newSlots.length; i++) {
      if (!Item.equal(oldSlots[i], newSlots[i])) {
        changedSlots.push(i)
      }
    }

    return changedSlots
  }

  // Bounded response wait after each 1.17+ click. Server semantics (wire-
  // proven on Paper 1.21.1): a click whose stateId matches and whose predicted
  // changedSlots agree is answered with SILENCE; any divergence is answered
  // with set_slot corrections / a full-state resync within a server tick.
  // The barrier: wait until the channel has been QUIET for CLICK_QUIET_MS
  // (ping-adjusted) — i.e. the response burst, if any, has ended and every
  // correction in it has been applied locally. Only then is the local
  // cursor/grid provably the server's, and the next click is built on truth
  // instead of racing it. Cursor and craft-grid state are mutated ONLY by our
  // own clicks server-side, so per-click quiet barriers keep those two — the
  // craft-critical state — in lockstep even while pickups churn the inventory
  // slots (those get corrected in-burst and re-read before use).
  // Tradeoff: a click costs ~quiet-gap ms (bounded by CLICK_SETTLE_CAP_MS);
  // that is the price of the acknowledgment 1.17+ removed, and roughly the
  // pacing a human-clicked vanilla client gives the server for free.
  function waitForClickSettle (window) {
    return new Promise(resolve => {
      const client = bot._client
      const ping = bot.player?.ping ?? 0
      const quietMs = Math.min(Math.max(CLICK_QUIET_MS, ping + CLICK_QUIET_MS), 300)
      let quietTimer = null
      let capTimer = null
      const cleanup = () => {
        clearTimeout(quietTimer)
        clearTimeout(capTimer)
        client.removeListener('set_slot', onTraffic)
        client.removeListener('window_items', onTraffic)
        bot.removeListener('windowClose', onClose)
      }
      const finish = () => { cleanup(); resolve() }
      const onTraffic = packet => {
        const wid = normWindowId(packet.windowId)
        if (wid !== window.id && wid !== 0 && wid !== -1 && wid !== -2) return
        clearTimeout(quietTimer)
        quietTimer = setTimeout(finish, quietMs)
      }
      const onClose = () => finish()
      client.on('set_slot', onTraffic)
      client.on('window_items', onTraffic)
      bot.on('windowClose', onClose)
      quietTimer = setTimeout(finish, quietMs)
      capTimer = setTimeout(finish, CLICK_SETTLE_CAP_MS)
    })
  }

  async function clickWindow (slot, mouseButton, mode, targetWindow = null) {
    // if you click on the quick bar and have dug recently,
    // wait a bit
    if (slot >= bot.QUICK_BAR_START && bot.lastDigTime != null) {
      let timeSinceLastDig
      while ((timeSinceLastDig = new Date() - bot.lastDigTime) < DIG_CLICK_TIMEOUT) {
        await sleep(DIG_CLICK_TIMEOUT - timeSinceLastDig)
      }
    }
    // Multi-click sequences (craft, transfer, putAway...) pass the window they
    // started on. If the server closed it mid-sequence, FAIL the click instead
    // of silently rerouting it to windowId 0 — rerouted container-numbered
    // clicks land on hotbar/armor slots (equip scramble) and strand the
    // sequence's cursor stack (wire-proven dead-window class).
    if (targetWindow && targetWindow.id !== bot.inventory.id &&
        (!bot.currentWindow || bot.currentWindow.id !== targetWindow.id)) {
      throw new Error(`Window ${targetWindow.id} (${targetWindow.type}) closed during click sequence`)
    }
    const window = targetWindow || bot.currentWindow || bot.inventory

    assert.ok(mode >= 0 && mode <= 4)
    const actionId = createActionNumber()

    const click = {
      slot,
      mouseButton,
      mode,
      id: actionId,
      windowId: window.id,
      item: slot === -999 ? null : window.slots[slot]
    }

    let changedSlots
    if (bot.supportFeature('transactionPacketExists')) {
      windowClickQueue.push(click)
    } else {
      if (
      // this array indicates the clicks that return changedSlots
        [
          0,
          // 1,
          // 2,
          3,
          4
          // 5,
          // 6
        ].includes(click.mode)) {
        changedSlots = window.acceptClick(click)
      } else {
        // this is used as a fallback
        const oldSlots = JSON.parse(JSON.stringify(window.slots))

        window.acceptClick(click)

        changedSlots = getChangedSlots(oldSlots, window.slots)
      }

      changedSlots = changedSlots.map(slot => {
        return {
          location: slot,
          item: Item.toNotch(window.slots[slot])
        }
      })
    }

    // WHEN ADDING SUPPORT FOR OTHER CLICKS, MAKE SURE TO CHANGE changedSlots TO SUPPORT THEM
    if (bot.supportFeature('stateIdUsed')) { // 1.17.1 +
      bot._client.write('window_click', {
        windowId: window.id,
        stateId: stateIdFor(window.id),
        slot,
        mouseButton,
        mode,
        changedSlots,
        cursorItem: Item.toNotch(window.selectedItem)
      })
    } else if (bot.supportFeature('actionIdUsed')) { // <= 1.16.5
      bot._client.write('window_click', {
        windowId: window.id,
        slot,
        mouseButton,
        action: actionId,
        mode,
        // protocol expects null even if there is an item at the slot in mode 2 and 4
        item: Item.toNotch((mode === 2 || mode === 4) ? null : click.item)
      })
    } else { // 1.17
      bot._client.write('window_click', {
        windowId: window.id,
        slot,
        mouseButton,
        mode,
        changedSlots,
        cursorItem: Item.toNotch(window.selectedItem)
      })
    }

    if (bot.supportFeature('transactionPacketExists')) {
      const response = once(bot, `confirmTransaction${actionId}`)
      if (!window.transactionRequiresConfirmation(click)) {
        confirmTransaction(window.id, actionId, true)
      }
      const [success] = await withTimeout(response, WINDOW_TIMEOUT)
        .catch(() => {
          throw new Error(`Server didn't respond to transaction for clicking on slot ${slot} on window with id ${window?.id}.`)
        })
      if (!success) {
        throw new Error(`Server rejected transaction for clicking on slot ${slot}, on window with id ${window?.id}.`)
      }
    } else if (window.type === 'minecraft:merchant') {
      // trades need their slot-2 output semantics, not just packet pacing
      await waitForWindowUpdate(window, slot)
    } else {
      // 1.17+: bounded per-click settle. The old waitForWindowUpdate waited
      // for "any update of the result slot", which under concurrent traffic
      // is satisfied by HISTORIC updates — the whole click burst then runs
      // ahead of the server's queue and client/server apply the same clicks
      // to different window contents.
      await waitForClickSettle(window)
    }
  }

  async function putAway (slot, targetWindow = null) {
    const window = targetWindow || bot.currentWindow || bot.inventory
    const promisePutAway = once(window, `updateSlot:${slot}`)
    await clickWindow(slot, 0, 0, window)
    const start = window.inventoryStart
    const end = window.inventoryEnd
    await putSelectedItemRange(start, end, window, null)
    await promisePutAway
  }

  async function moveSlotItem (sourceSlot, destSlot) {
    const window = bot.currentWindow || bot.inventory
    await clickWindow(sourceSlot, 0, 0, window)
    await clickWindow(destSlot, 0, 0, window)
    // if we're holding an item, put it back where the source item was.
    // otherwise we're done.
    updateHeldItem()
    if (bot.inventory.selectedItem) {
      await clickWindow(sourceSlot, 0, 0, window)
    }
  }

  bot._client.on('transaction', (packet) => {
    // confirm transaction
    confirmTransaction(packet.windowId, packet.action, packet.accepted)
  })

  bot._client.on('held_item_slot', (packet) => {
    // held item change
    bot.setQuickBarSlot(packet.slot)
  })

  // At most one window is ever opening (bot.currentWindow is a single slot),
  // so at most one pending `setWindowItems:<id>` once-listener may exist. It
  // must be torn down when the window closes (or another opens) before the
  // items arrive — otherwise it lingers forever and, because window ids
  // recycle, can later fire windowOpen with a stale window object.
  let pendingWindowOpen = null // { event, handler }
  function clearPendingWindowOpen () {
    if (pendingWindowOpen) {
      bot.off(pendingWindowOpen.event, pendingWindowOpen.handler)
      pendingWindowOpen = null
    }
  }

  function prepareWindow (window) {
    clearPendingWindowOpen()
    // Don't emit windowOpen until we have the slot data. The server always
    // sends open_window before this menu's window_items (TCP-ordered), so
    // there is nothing to pre-apply here — the old "stashed window_items"
    // path only ever fired for a STALE stash left by a closed window whose
    // id got recycled, corrupting the fresh window.
    const event = `setWindowItems:${window.id}`
    const handler = () => {
      pendingWindowOpen = null
      extendWindow(window)
      bot.emit('windowOpen', window)
    }
    pendingWindowOpen = { event, handler }
    bot.once(event, handler)
  }

  bot._client.on('open_window', (packet) => {
    // open window
    bot.currentWindow = windows.createWindow(packet.windowId,
      packet.inventoryType, packet.windowTitle, packet.slotCount)
    prepareWindow(bot.currentWindow)
  })
  bot._client.on('open_horse_window', (packet) => {
    // open window
    bot.currentWindow = windows.createWindow(packet.windowId,
      'HorseWindow', 'Horse', packet.nbSlots)
    prepareWindow(bot.currentWindow)
  })
  bot._client.on('close_window', (packet) => {
    // server-initiated close (stillValid failure: walked away, block broken,
    // ...). In-flight click sequences on this window abort via the
    // targetWindow guard in clickWindow; grid/cursor contents come back on
    // the -2/-1 correction channels, which are honored above.
    clearPendingWindowOpen()
    const oldWindow = bot.currentWindow
    if (oldWindow && oldWindow.id !== 0) stateIds.delete(oldWindow.id)
    bot.currentWindow = null
    bot.emit('windowClose', oldWindow)
  })
  bot._client.on('login', () => {
    // close window when switch subserver
    clearPendingWindowOpen()
    stateIds.clear()
    const oldWindow = bot.currentWindow
    if (!oldWindow) return
    bot.currentWindow = null
    bot.emit('windowClose', oldWindow)
  })
  bot._setSlot = (slotId, newItem, window = bot.inventory) => {
    // set slot
    const oldItem = window.slots[slotId]
    window.updateSlot(slotId, newItem)
    updateHeldItem()
    bot.emit(`setSlot:${window.id}`, oldItem, newItem)
  }
  // vanilla Inventory indexing (set_slot windowId -2): 0-8 hotbar,
  // 9-35 main, 36-39 armor (boots->helmet), 40 offhand -> window-0 slots
  function directInvSlotToWindow0 (slot) {
    if (slot >= 0 && slot <= 8) return 36 + slot // hotbar
    if (slot >= 9 && slot <= 35) return slot // main inventory
    if (slot >= 36 && slot <= 39) return 44 - slot // 36 boots->8 ... 39 helmet->5
    if (slot === 40) return 45 // offhand
    return null
  }
  bot._client.on('set_slot', (packet) => {
    const wid = normWindowId(packet.windowId)
    const newItem = Item.fromNotch(packet.item)
    if (wid === -1) {
      // cursor correction for the active menu. Dropping it leaves the local
      // cursor on a diverged timeline for the rest of the session (this is
      // the channel that decides "vanish" vs "phantom persists").
      const active = bot.currentWindow || bot.inventory
      active.selectedItem = newItem
      updateHeldItem()
      return
    }
    if (wid === -2) {
      // direct player-inventory write (the server returns crafting-grid /
      // cursor contents through this channel after a container closes)
      const invSlot = directInvSlotToWindow0(packet.slot)
      if (invSlot === null) return
      bot._setSlot(invSlot, newItem, bot.inventory)
      // the open container's shared segment views the same backing inventory
      const cur = bot.currentWindow
      if (cur && invSlot >= 9 && invSlot <= 44) {
        cur.updateSlot(cur.inventoryStart + (invSlot - 9), newItem ? Item.fromNotch(packet.item) : null)
      }
      return
    }
    const window = wid === 0 ? bot.inventory : bot.currentWindow
    if (!window || window.id !== wid) return
    bot._setSlot(packet.slot, newItem, window)
  })
  bot._client.on('window_items', (packet) => {
    const wid = normWindowId(packet.windowId)
    const window = wid === 0 ? bot.inventory : bot.currentWindow
    if (!window || window.id !== wid) {
      // Full state for a window we no longer (or don't yet) have. Window ids
      // recycle, so NEVER stash this against the id for later application —
      // a stale stash applied to a future window corrupts it wholesale.
      // Instead heal the one segment that is unambiguous across every
      // standard container: the shared player inventory (last 36 slots =
      // main 27 + hotbar 9).
      const items = packet.items ?? []
      if (wid > 0 && items.length >= 36) {
        const base = items.length - 36
        for (let i = 0; i < 36; ++i) {
          bot.inventory.updateSlot(9 + i, Item.fromNotch(items[base + i]))
        }
        updateHeldItem()
      }
      return
    }

    // set window items
    for (let i = 0; i < packet.items.length; ++i) {
      const item = Item.fromNotch(packet.items[i])
      window.updateSlot(i, item)
    }
    // 1.17.1+ full resyncs carry the server's cursor stack — honor it, the
    // cursor has no other unsolicited correction path
    if (packet.carriedItem !== undefined) {
      window.selectedItem = Item.fromNotch(packet.carriedItem)
    }
    updateHeldItem()
    bot.emit(`setWindowItems:${window.id}`)
  })

  /**
   * Convert a vector direction to minecraft packet number direction
   * @param {Vec3} v
   * @returns {number}
   */
  function vectorToDirection (v) {
    if (v.y < 0) {
      return 0
    } else if (v.y > 0) {
      return 1
    } else if (v.z < 0) {
      return 2
    } else if (v.z > 0) {
      return 3
    } else if (v.x < 0) {
      return 4
    } else if (v.x > 0) {
      return 5
    }
    assert.ok(false, `invalid direction vector ${v}`)
  }

  bot.activateBlock = activateBlock
  bot.activateEntity = activateEntity
  bot.activateEntityAt = activateEntityAt
  bot.consume = consume
  bot.activateItem = activateItem
  bot.deactivateItem = deactivateItem

  // not really in the public API
  bot.clickWindow = clickWindow
  bot.putSelectedItemRange = putSelectedItemRange
  bot.putAway = putAway
  bot.closeWindow = closeWindow
  bot.transfer = transfer
  bot.openBlock = openBlock
  bot.openEntity = openEntity
  bot.moveSlotItem = moveSlotItem
  bot.updateHeldItem = updateHeldItem
}
