const { onceWithCleanup } = require('../promise_utils')

const USERNAME_REGEX = '(?:\\(.{1,15}\\)|\\[.{1,15}\\]|.){0,5}?(\\w+)'
const LEGACY_VANILLA_CHAT_REGEX = new RegExp(`^${USERNAME_REGEX}\\s?[>:\\-»\\]\\)~]+\\s(.*)$`)

module.exports = inject

function inject (bot, options) {
  const CHAT_LENGTH_LIMIT = options.chatLengthLimit ?? (bot.supportFeature('lessCharsInChat') ? 100 : 256)
  const defaultChatPatterns = options.defaultChatPatterns ?? true

  const ChatMessage = require('prismarine-chat')(bot.registry)
  // chat.pattern.type will emit an event for bot.on() of the same type, eg chatType = whisper will trigger bot.on('whisper')
  const _patterns = {}
  let _length = 0
  // deprecated
  bot.chatAddPattern = (patternValue, typeValue) => {
    return bot.addChatPattern(typeValue, patternValue, { deprecated: true })
  }

  bot.addChatPatternSet = (name, patterns, opts = {}) => {
    if (!patterns.every(p => p instanceof RegExp)) throw new Error('Pattern parameter should be of type RegExp')
    const { repeat = true, parse = false } = opts
    _patterns[_length++] = {
      name,
      patterns,
      position: 0,
      matches: [],
      messages: [],
      repeat,
      parse
    }
    return _length
  }

  bot.addChatPattern = (name, pattern, opts = {}) => {
    if (!(pattern instanceof RegExp)) throw new Error('Pattern parameter should be of type RegExp')
    const { repeat = true, deprecated = false, parse = false } = opts
    _patterns[_length] = {
      name,
      patterns: [pattern],
      position: 0,
      matches: [],
      messages: [],
      deprecated,
      repeat,
      parse
    }
    return _length++ // increment length after we give it back to the user
  }

  bot.removeChatPattern = name => {
    if (typeof name === 'number') {
      _patterns[name] = undefined
    } else {
      const matchingPatterns = Object.entries(_patterns).filter(pattern => pattern[1]?.name === name)
      matchingPatterns.forEach(([indexString]) => {
        _patterns[+indexString] = undefined
      })
    }
  }

  function findMatchingPatterns (msg) {
    const found = []
    for (const [indexString, pattern] of Object.entries(_patterns)) {
      if (!pattern) continue
      const { position, patterns } = pattern
      if (patterns[position].test(msg)) {
        found.push(+indexString)
      }
    }
    return found
  }

  bot.on('messagestr', (msg, _, originalMsg) => {
    const foundPatterns = findMatchingPatterns(msg)

    for (const ix of foundPatterns) {
      _patterns[ix].matches.push(msg)
      _patterns[ix].messages.push(originalMsg)
      _patterns[ix].position++

      if (_patterns[ix].deprecated) {
        const [, ...matches] = _patterns[ix].matches[0].match(_patterns[ix].patterns[0])
        bot.emit(_patterns[ix].name, ...matches, _patterns[ix].messages[0].translate, ..._patterns[ix].messages)
        _patterns[ix].messages = [] // clear out old messages
      } else { // regular parsing
        if (_patterns[ix].patterns.length > _patterns[ix].matches.length) return // we have all the matches, so we can emit the done event
        if (_patterns[ix].parse) {
          const matches = _patterns[ix].patterns.map((pattern, i) => {
            const [, ...matches] = _patterns[ix].matches[i].match(pattern) // delete full message match
            return matches
          })
          bot.emit(`chat:${_patterns[ix].name}`, matches)
        } else {
          bot.emit(`chat:${_patterns[ix].name}`, _patterns[ix].matches)
        }
        // these are possibly null-ish if the user deletes them as soon as the event for the match is emitted
      }
      if (_patterns[ix]?.repeat) {
        _patterns[ix].position = 0
        _patterns[ix].matches = []
      } else {
        _patterns[ix] = undefined
      }
    }
  })

  addDefaultPatterns()

  // Chat self-heal (MinePal crash hardening): modded servers register custom
  // chat types (inline holders, remapped registries) and a dropped
  // registry_data leaves chatFormattingById empty — either used to make
  // ChatMessage.fromNetwork/fromNotch throw INSIDE a packet handler (process
  // death before the handler boundary; a dead chat pipeline after it). The
  // wire carries plainMessage on 1.19.1+, so the CONTENT is deliverable even
  // when the format is not: fall back to a plain-text ChatMessage and log
  // once per failure signature.
  const chatHealCounts = {}
  function plainTextOf (raw) {
    if (typeof raw !== 'string') return ''
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed === 'string') return parsed
      if (parsed && typeof parsed.text === 'string') return parsed.text
    } catch { /* not JSON — deliver as-is */ }
    return raw
  }
  function healChatMessage (err, fallbackText) {
    const key = String(err && err.message).slice(0, 80)
    chatHealCounts[key] = (chatHealCounts[key] || 0) + 1
    if (chatHealCounts[key] === 1 || chatHealCounts[key] % 100 === 0) {
      console.warn(`[chat] chat format unreadable (${chatHealCounts[key]}x): ${err && err.message} — delivering plain text`)
    }
    return new ChatMessage({ text: typeof fallbackText === 'string' ? fallbackText : '' })
  }

  bot._client.on('playerChat', (data) => {
    const message = data.formattedMessage
    const verified = data.verified
    let msg
    try {
      if (bot.supportFeature('clientsideChatFormatting')) {
        const parameters = {
          sender: data.senderName ? JSON.parse(data.senderName) : undefined,
          target: data.targetName ? JSON.parse(data.targetName) : undefined,
          content: message ? JSON.parse(message) : { text: data.plainMessage }
        }
        // Determine the chat registry index in a version-tolerant way
        let registryIndex
        const t = data.type
        if (t && typeof t === 'object') {
          if (t.chatType != null) registryIndex = t.chatType
          else if (typeof t.registryIndex === 'number') registryIndex = t.registryIndex
        }
        if (registryIndex == null) registryIndex = (typeof t === 'number') ? t : 0
        msg = ChatMessage.fromNetwork(registryIndex, parameters)

        if (data.unsignedContent) {
          msg.unsigned = ChatMessage.fromNetwork(registryIndex, { sender: parameters.sender, target: parameters.target, content: JSON.parse(data.unsignedContent) })
        }
      } else {
        msg = ChatMessage.fromNotch(message)
      }
    } catch (err) {
      msg = healChatMessage(err, data.plainMessage != null ? String(data.plainMessage) : plainTextOf(message))
    }
    bot.emit('message', msg, 'chat', data.sender, verified)
    bot.emit('messagestr', msg.toString(), 'chat', msg, data.sender, verified)
  })

  bot._client.on('systemChat', (data) => {
    let msg
    try {
      msg = ChatMessage.fromNotch(data.formattedMessage)
    } catch (err) {
      msg = healChatMessage(err, plainTextOf(data.formattedMessage))
    }
    const chatPositions = {
      1: 'system',
      2: 'game_info'
    }
    bot.emit('message', msg, chatPositions[data.positionId], null)
    bot.emit('messagestr', msg.toString(), chatPositions[data.positionId], msg, null)
    if (data.positionId === 2) bot.emit('actionBar', msg, null)
  })

  function chatWithHeader (header, message) {
    if (typeof message === 'number') message = message.toString()
    if (typeof message !== 'string') {
      throw new Error('Chat message type must be a string or number: ' + typeof message)
    }

    if (!header && message.startsWith('/')) {
      // Do not try and split a command without a header
      bot._client.chat(message)
      return
    }

    const lengthLimit = CHAT_LENGTH_LIMIT - header.length
    message.split('\n').forEach((subMessage) => {
      if (!subMessage) return
      let i
      let smallMsg
      for (i = 0; i < subMessage.length; i += lengthLimit) {
        smallMsg = header + subMessage.substring(i, i + lengthLimit)
        bot._client.chat(smallMsg)
        // F66: plain player chat carries a wire receipt (the server's echo
        // broadcast); commands (incl. whisper headers) do not — track only
        // the former, post-split so entries mirror actual chat_message
        // packets one-to-one.
        if (!smallMsg.startsWith('/')) trackOutgoingChat(smallMsg)
      }
    })
  }

  // ------------------------------------------------------------------------
  // F66 chat-delivery truth organ. Every vanilla-core server (1.8 → 1.21.x)
  // that ACCEPTS a player chat message relays it back to the sender as a
  // player chat broadcast — the only wire-level receipt that the message was
  // accepted and relayed. Its absence, or an inbound chat.disabled.* system
  // line (the 1.19.1+ silent-refusal rails: chat visibility dropped,
  // missing/expired profile key, broken chain), is the only honest signal of
  // a silently muted bot. Emits:
  //   'chatDelivered'    { message, waitedMs }
  //   'chatDeliveryMiss' { message, waitedMs, missStreak }
  //   'chatRefused'      { key }
  // Policy (what to tell the player, cooldowns) intentionally lives in the
  // consumer; this organ only reports packet truth.
  const deliveryTimeoutMs = options.chatDeliveryTimeoutMs ?? 10000
  const pendingDelivery = []
  let deliveryMissStreak = 0

  function trackOutgoingChat (message) {
    pendingDelivery.push({ message, at: Date.now() })
    if (pendingDelivery.length > 16) pendingDelivery.shift() // bounded
  }

  function sweepDelivery () {
    const now = Date.now()
    while (pendingDelivery.length > 0 && now - pendingDelivery[0].at > deliveryTimeoutMs) {
      const entry = pendingDelivery.shift()
      deliveryMissStreak++
      bot.emit('chatDeliveryMiss', { message: entry.message, waitedMs: now - entry.at, missStreak: deliveryMissStreak })
    }
  }
  const deliverySweeper = setInterval(sweepDelivery, Math.min(deliveryTimeoutMs, 2500))
  if (deliverySweeper.unref) deliverySweeper.unref()
  bot.once('end', () => clearInterval(deliverySweeper))

  function resolveDelivered (index, waitedMs) {
    const [entry] = pendingDelivery.splice(index, 1)
    deliveryMissStreak = 0
    bot.emit('chatDelivered', { message: entry.message, waitedMs })
  }

  bot._client.on('playerChat', (data) => {
    if (pendingDelivery.length === 0) return
    const selfUuid = bot._client.uuid ?? bot.player?.uuid ?? null
    const senderMatches = data.sender != null && selfUuid != null && data.sender === selfUuid
    const plain = typeof data.plainMessage === 'string' ? data.plainMessage : null
    if (plain != null) {
      const ix = pendingDelivery.findIndex((e) => e.message === plain)
      if (ix !== -1 && (senderMatches || data.sender == null)) {
        resolveDelivered(ix, Date.now() - pendingDelivery[ix].at)
      }
      return
    }
    // Legacy (<1.19.1) echoes carry only formatted text; the sender uuid is
    // still wire truth and servers echo in order — resolve FIFO on match.
    if (senderMatches) resolveDelivered(0, Date.now() - pendingDelivery[0].at)
  })

  function collectTranslateKeys (formatted, out = []) {
    try {
      const node = typeof formatted === 'string' ? JSON.parse(formatted) : formatted
      const walk = (n) => {
        if (n == null || typeof n !== 'object') return
        if (typeof n.translate === 'string') out.push(n.translate)
        for (const child of [].concat(n.extra ?? [], n.with ?? [])) walk(child)
      }
      walk(node)
    } catch { /* non-JSON system text has no translate keys */ }
    return out
  }

  bot._client.on('systemChat', (data) => {
    const refusal = collectTranslateKeys(data.formattedMessage).find((k) => typeof k === 'string' && k.startsWith('chat.disabled'))
    if (refusal) bot.emit('chatRefused', { key: refusal })
  })

  async function tabComplete (text, assumeCommand = false, sendBlockInSight = true, timeout = 5000) {
    let position

    if (sendBlockInSight) {
      const block = bot.blockAtCursor()

      if (block) {
        position = block.position
      }
    }

    bot._client.write('tab_complete', {
      text,
      assumeCommand,
      lookedAtBlock: position
    })

    const [packet] = await onceWithCleanup(bot._client, 'tab_complete', { timeout })
    return packet.matches
  }

  bot.whisper = (username, message) => {
    chatWithHeader(`/tell ${username} `, message)
  }
  bot.chat = (message) => {
    if (bot.whisper_to_player && bot.owner && !message.startsWith('/')) {
      chatWithHeader(`/tell ${bot.owner} `, message)
    } else {
      chatWithHeader('', message)
    }
  }

  bot.tabComplete = tabComplete

  function addDefaultPatterns () {
    // 1.19 changes the chat format to move <sender> prefix from message contents to a separate field.
    // TODO: new chat lister to handle this
    if (!defaultChatPatterns) return
    bot.addChatPattern('whisper', new RegExp(`^${USERNAME_REGEX} whispers(?: to you)?:? (.*)$`), { deprecated: true })
    bot.addChatPattern('whisper', new RegExp(`^\\[${USERNAME_REGEX} -> \\w+\\s?\\] (.*)$`), { deprecated: true })
    bot.addChatPattern('chat', LEGACY_VANILLA_CHAT_REGEX, { deprecated: true })
  }

  function awaitMessage (...args) {
    const timeout = typeof args[args.length - 1] === 'number' ? args.pop() : 20000
    return new Promise((resolve, reject) => {
      const resolveMessages = args.flatMap(x => x)
      const timeoutHandle = setTimeout(() => {
        bot.off('messagestr', messageListener)
        reject(new Error(`Timeout waiting for message after ${timeout}ms`))
      }, timeout)

      function messageListener (msg) {
        if (resolveMessages.some(x => x instanceof RegExp ? x.test(msg) : msg === x)) {
          clearTimeout(timeoutHandle)
          resolve(msg)
          bot.off('messagestr', messageListener)
        }
      }
      bot.on('messagestr', messageListener)
    })
  }
  bot.awaitMessage = awaitMessage
}
