/* eslint-env mocha */
// Unit tests for lib/materials_repair.js — the 1.20.5+ 'incorrect_for_*_tool'
// materials-table hole (tier-gated ores dug with no correct-tool speed credit).
// Times asserted are the vanilla Breaking-formula values, server-verified on a
// live 1.21.1 rig (mining campaign probe-log T6/T7).
const assert = require('assert')
const repairToolMaterials = require('../lib/materials_repair')

function freshRegistry (version) {
  // prismarine-registry returns a fresh instance per call; materials however
  // references the minecraft-data cached object until repaired.
  return require('prismarine-registry')(version)
}

function digMs (registry, Block, blockName, toolName) {
  const block = Block.fromStateId(registry.blocksByName[blockName].defaultState, 0)
  const toolId = toolName ? registry.itemsByName[toolName].id : null
  return block.digTime(toolId, false, false, false, [], {})
}

describe('materials_repair', () => {
  describe('1.21.1 (incorrect_for_* era)', () => {
    const registry = freshRegistry('1.21.1')
    const Block = require('prismarine-block')(registry)

    it('stock data reproduces the defect (stone pick on iron_ore = 4.55 s)', () => {
      // 91 ticks: multiplier-1 formula (90 ticks) + prismarine-block's FP ceil
      // wart adds one — exactly the 4.55 s measured live on the probe rig.
      assert.strictEqual(digMs(registry, Block, 'iron_ore', 'stone_pickaxe'), 4550)
    })

    it('existing Block instances pick up the repair (call-time lookup)', () => {
      const preRepairBlock = Block.fromStateId(registry.blocksByName.iron_ore.defaultState, 0)
      repairToolMaterials(registry)
      const stonePick = registry.itemsByName.stone_pickaxe.id
      // instance created BEFORE the repair — pathfinder-cached blocks behave the same
      assert.strictEqual(preRepairBlock.digTime(stonePick, false, false, false, [], {}), 1150)
    })

    it('restores vanilla correct-tool times on tier-gated blocks', () => {
      repairToolMaterials(registry)
      assert.strictEqual(digMs(registry, Block, 'iron_ore', 'stone_pickaxe'), 1150)
      assert.strictEqual(digMs(registry, Block, 'iron_ore', 'iron_pickaxe'), 750)
      assert.strictEqual(digMs(registry, Block, 'deepslate_iron_ore', 'stone_pickaxe'), 1700)
      assert.strictEqual(digMs(registry, Block, 'deepslate_iron_ore', 'iron_pickaxe'), 1150)
      assert.strictEqual(digMs(registry, Block, 'diamond_ore', 'iron_pickaxe'), 750)
      assert.strictEqual(digMs(registry, Block, 'obsidian', 'diamond_pickaxe'), 9400)
    })

    it('keeps wrong-tier family tools slow (vanilla law: wood pick on iron_ore 7.5 s)', () => {
      repairToolMaterials(registry)
      // wooden pick: family multiplier 2 applies, but canHarvest=false -> /100 divisor
      assert.strictEqual(digMs(registry, Block, 'iron_ore', 'wooden_pickaxe'), 7500)
      // stone pick on an iron-gated block: 4x speed, /100 divisor (gold_ore needs iron)
      assert.strictEqual(digMs(registry, Block, 'gold_ore', 'stone_pickaxe'), 3750)
    })

    it('corrects the stock bogus 2x for non-family wooden tools (shovel on iron_ore)', () => {
      repairToolMaterials(registry)
      // vanilla: non-family tool = multiplier 1, cannot harvest -> hardness*5 = 15 s
      assert.strictEqual(digMs(registry, Block, 'iron_ore', 'wooden_shovel'), 15000)
    })

    it('does not touch non-gated blocks (before/after invariance + vanilla anchors)', () => {
      const fresh = freshRegistry('1.21.1')
      const FreshBlock = require('prismarine-block')(fresh)
      const cases = [
        ['coal_ore', 'stone_pickaxe'], ['coal_ore', 'wooden_pickaxe'],
        ['stone', 'wooden_pickaxe'], ['stone', null],
        ['oak_log', 'iron_axe'], ['dirt', null], ['deepslate', 'iron_pickaxe']
      ]
      const before = cases.map(([b, t]) => digMs(fresh, FreshBlock, b, t))
      repairToolMaterials(fresh)
      const after = cases.map(([b, t]) => digMs(fresh, FreshBlock, b, t))
      assert.deepStrictEqual(after, before)
      // vanilla anchors (server-verified on the probe rig)
      assert.strictEqual(digMs(fresh, FreshBlock, 'coal_ore', 'stone_pickaxe'), 1150)
      assert.strictEqual(digMs(fresh, FreshBlock, 'stone', 'wooden_pickaxe'), 1150)
      assert.strictEqual(digMs(fresh, FreshBlock, 'deepslate', 'iron_pickaxe'), 750)
    })

    it('leaves harvest gating untouched (yield law is canHarvest, not speed)', () => {
      repairToolMaterials(registry)
      const iron = Block.fromStateId(registry.blocksByName.iron_ore.defaultState, 0)
      assert.ok(!iron.canHarvest(registry.itemsByName.wooden_pickaxe.id))
      assert.ok(iron.canHarvest(registry.itemsByName.stone_pickaxe.id))
    })

    it('is idempotent and does not mutate the minecraft-data cache', () => {
      const mdMaterials = require('minecraft-data')('1.21.1').materials
      assert.deepStrictEqual(mdMaterials.incorrect_for_wooden_tool,
        { 819: 2, 820: 2, 821: 2, 822: 2 }) // module cache untouched
      repairToolMaterials(registry)
      const once = registry.materials
      repairToolMaterials(registry)
      assert.strictEqual(registry.materials, once) // second call is a no-op
    })
  })

  describe('pre-1.20.5 versions (mineable/* era)', () => {
    it('is a strict no-op on 1.20.1', () => {
      const registry = freshRegistry('1.20.1')
      const before = JSON.parse(JSON.stringify(registry.materials))
      repairToolMaterials(registry)
      assert.deepStrictEqual(JSON.parse(JSON.stringify(registry.materials)), before)
    })

    it('1.20.1 dig times unchanged (stone pick on iron_ore already correct)', () => {
      const registry = freshRegistry('1.20.1')
      const Block = require('prismarine-block')(registry)
      repairToolMaterials(registry)
      assert.strictEqual(digMs(registry, Block, 'iron_ore', 'stone_pickaxe'), 1150)
    })
  })
})
