const assert = require('assert')
const { once } = require('../promise_utils')

module.exports = inject

// ms to wait for the crafting window to open / for the server to populate the
// result slot with the REAL craft result. Bounded so a server-side dead window
// (table broken / walked away mid-craft) errors instead of hanging bot.craft.
const CRAFT_WINDOW_TIMEOUT = 5000
const CRAFT_RESULT_TIMEOUT = 5000

function inject (bot) {
  const Item = require('prismarine-item')(bot.registry)
  const Recipe = require('prismarine-recipe')(bot.registry).Recipe
  let windowCraftingTable

  function closeCraftingWindow () {
    if (!windowCraftingTable) return
    // Only close a window that is still actually open: writing close_window
    // for a server-side dead id and copying its (stale) shared segment back
    // into the inventory would overwrite server corrections.
    if (bot.currentWindow && bot.currentWindow.id === windowCraftingTable.id) {
      bot.closeWindow(windowCraftingTable)
    }
    windowCraftingTable = undefined
  }

  async function craft (recipe, count, craftingTable) {
    assert.ok(recipe)
    count = parseInt(count ?? 1, 10)
    if (recipe.requiresTable && !craftingTable) {
      throw new Error('Recipe requires craftingTable, but one was not supplied: ' + JSON.stringify(recipe))
    }

    try {
      for (let i = 0; i < count; i++) {
        await craftOnce(recipe, craftingTable)
      }

      closeCraftingWindow()
    } catch (err) {
      closeCraftingWindow()
      throw new Error(err)
    }
  }

  // Wait for the server's REAL result-slot content (identity-checked) —
  // the client must never invent the outcome of a craft. Historic resync
  // noise cannot satisfy this wait: only the expected result item does.
  function waitForCraftResult (window, recipe) {
    const matches = item => item != null && item.type === recipe.result.id &&
      (recipe.result.metadata == null || item.metadata === recipe.result.metadata)
    if (matches(window.slots[0])) return Promise.resolve()
    return new Promise((resolve, reject) => {
      let timer = null
      const cleanup = () => {
        clearTimeout(timer)
        window.removeListener('updateSlot:0', onUpdate)
        bot.removeListener('windowClose', onClose)
      }
      const onUpdate = (oldItem, newItem) => {
        if (matches(newItem)) { cleanup(); resolve() }
      }
      const onClose = () => {
        cleanup()
        reject(new Error('crafting window closed by the server before the craft result appeared'))
      }
      window.on('updateSlot:0', onUpdate)
      bot.on('windowClose', onClose)
      timer = setTimeout(() => {
        cleanup()
        reject(new Error(`server never produced the expected craft result (item id ${recipe.result.id}) — craft rejected or window desynced`))
      }, CRAFT_RESULT_TIMEOUT)
    })
  }

  async function craftOnce (recipe, craftingTable) {
    if (craftingTable) {
      if (!windowCraftingTable) {
        bot.activateBlock(craftingTable)
        const [window] = await once(bot, 'windowOpen', CRAFT_WINDOW_TIMEOUT)
        windowCraftingTable = window
      }
      if (!windowCraftingTable.type.startsWith('minecraft:crafting')) {
        throw new Error('crafting: non craftingTable used as craftingTable: ' + windowCraftingTable.type)
      }
      await startClicking(windowCraftingTable, 3, 3)
    } else {
      await startClicking(bot.inventory, 2, 2)
    }

    async function startClicking (window, w, h) {
      const extraSlots = unusedRecipeSlots()
      let ingredientIndex = 0
      let originalSourceSlot = null
      let it
      if (recipe.inShape) {
        it = {
          x: 0,
          y: 0,
          row: recipe.inShape[0]
        }
        await clickShape()
      } else {
        await nextIngredientsClick()
      }

      function incrementShapeIterator () {
        it.x += 1
        if (it.x >= it.row.length) {
          it.y += 1
          if (it.y >= recipe.inShape.length) return null
          it.x = 0
          it.row = recipe.inShape[it.y]
        }
        return it
      }

      async function nextShapeClick () {
        if (incrementShapeIterator()) {
          await clickShape()
        } else if (!recipe.ingredients) {
          await putMaterialsAway()
        } else {
          await nextIngredientsClick()
        }
      }

      async function clickShape () {
        const destSlot = slot(it.x, it.y)
        const ingredient = it.row[it.x]
        if (ingredient.id === -1) return nextShapeClick()
        if (!window.selectedItem || window.selectedItem.type !== ingredient.id ||
          (ingredient.metadata != null &&
            window.selectedItem.metadata !== ingredient.metadata)) {
          // we are not holding the item we need. click it.
          const sourceItem = window.findInventoryItem(ingredient.id, ingredient.metadata)
          if (!sourceItem) throw new Error('missing ingredient')
          if (originalSourceSlot == null) originalSourceSlot = sourceItem.slot
          await bot.clickWindow(sourceItem.slot, 0, 0, window)
        }
        await bot.clickWindow(destSlot, 1, 0, window)
        await nextShapeClick()
      }

      async function nextIngredientsClick () {
        const ingredient = recipe.ingredients[ingredientIndex]
        const destSlot = extraSlots.pop()
        if (!window.selectedItem || window.selectedItem.type !== ingredient.id ||
          (ingredient.metadata != null &&
            window.selectedItem.metadata !== ingredient.metadata)) {
          // we are not holding the item we need. click it.
          const sourceItem = window.findInventoryItem(ingredient.id, ingredient.metadata)
          if (!sourceItem) throw new Error('missing ingredient')
          if (originalSourceSlot == null) originalSourceSlot = sourceItem.slot
          await bot.clickWindow(sourceItem.slot, 0, 0, window)
        }
        await bot.clickWindow(destSlot, 1, 0, window)
        if (++ingredientIndex < recipe.ingredients.length) {
          await nextIngredientsClick()
        } else {
          await putMaterialsAway()
        }
      }

      async function putMaterialsAway () {
        const start = window.inventoryStart
        const end = window.inventoryEnd
        await bot.putSelectedItemRange(start, end, window, originalSourceSlot)
        await grabResult()
      }

      async function grabResult () {
        assert.strictEqual(window.selectedItem, null)
        // The old code INVENTED the result here (window.updateSlot(0, new
        // Item(...))) and picked the fabrication up — if the server had
        // no-oped the sequence (stale stateId, diverged cursor, dead window)
        // the client walked away holding a phantom item while the server
        // kept the materials. Wait for the server's real result instead.
        await waitForCraftResult(window, recipe)
        await bot.putAway(0, window)
        await updateOutShape()
      }

      async function updateOutShape () {
        if (!recipe.outShape) {
          for (let i = 1; i <= w * h; i++) {
            window.updateSlot(i, null)
          }
          return
        }
        const slotsToClick = []
        for (let y = 0; y < recipe.outShape.length; ++y) {
          const row = recipe.outShape[y]
          for (let x = 0; x < row.length; ++x) {
            const _slot = slot(x, y)
            let item = null
            if (row[x].id !== -1) {
              item = new Item(row[x].id, row[x].count, row[x].metadata || null)
              slotsToClick.push(_slot)
            }
            window.updateSlot(_slot, item)
          }
        }
        for (const _slot of slotsToClick) {
          await bot.putAway(_slot, window)
        }
      }

      function slot (x, y) {
        return 1 + x + w * y
      }

      function unusedRecipeSlots () {
        const result = []
        let x
        let y
        let row
        if (recipe.inShape) {
          for (y = 0; y < recipe.inShape.length; ++y) {
            row = recipe.inShape[y]
            for (x = 0; x < row.length; ++x) {
              if (row[x].id === -1) result.push(slot(x, y))
            }
            for (; x < w; ++x) {
              result.push(slot(x, y))
            }
          }
          for (; y < h; ++y) {
            for (x = 0; x < w; ++x) {
              result.push(slot(x, y))
            }
          }
        } else {
          for (y = 0; y < h; ++y) {
            for (x = 0; x < w; ++x) {
              result.push(slot(x, y))
            }
          }
        }
        return result
      }
    }
  }

  function recipesFor (itemType, metadata, minResultCount, craftingTable) {
    minResultCount = minResultCount ?? 1
    const results = []
    Recipe.find(itemType, metadata).forEach((recipe) => {
      if (requirementsMetForRecipe(recipe, minResultCount, craftingTable)) {
        results.push(recipe)
      }
    })
    return results
  }

  function recipesAll (itemType, metadata, craftingTable) {
    const results = []
    Recipe.find(itemType, metadata).forEach((recipe) => {
      if (!recipe.requiresTable || craftingTable) {
        results.push(recipe)
      }
    })
    return results
  }

  function requirementsMetForRecipe (recipe, minResultCount, craftingTable) {
    if (recipe.requiresTable && !craftingTable) return false

    // how many times we have to perform the craft to achieve minResultCount
    const craftCount = Math.ceil(minResultCount / recipe.result.count)

    // false if not enough inventory to make all the ones that we want
    for (let i = 0; i < recipe.delta.length; ++i) {
      const d = recipe.delta[i]
      if (bot.inventory.count(d.id, d.metadata) + d.count * craftCount < 0) return false
    }

    // otherwise true
    return true
  }

  bot.craft = craft
  bot.recipesFor = recipesFor
  bot.recipesAll = recipesAll
}
