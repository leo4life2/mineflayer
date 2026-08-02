/**
 * Repair minecraft-data's materials table for the 1.20.5+
 * 'incorrect_for_<tier>_tool' material names.
 *
 * Mojang 1.20.5 renamed the tool block-tags to `incorrect_for_wooden_tool`
 * etc. — naming the *insufficient* tier instead of the mineable family.
 * minecraft-data followed the tag rename for `block.material`, but its
 * materials table entry for those names carries only the ids of the
 * INSUFFICIENT tools (e.g. the four wooden tools @ 2x). The correct-family
 * speed multipliers (stone 4x, iron 6x, diamond 8x, gold 12x, netherite 9x)
 * are missing, so prismarine-block's digTime() computes multiplier 1 for
 * every correct tool on every tier-gated block: a stone pickaxe digs
 * iron_ore in 4.5 s instead of the vanilla 1.15 s. Every
 * `incorrect_for_*_tool` block is affected (iron/gold/diamond/redstone/
 * emerald ores, obsidian, ancient_debris, ...) in every digTime consumer
 * (bot.dig progress loop, pathfinder dig costs).
 *
 * The repair is data-driven — no per-block patches:
 *   for each materials key containing an `incorrect_for_<tier>_tool`
 *   component, derive the tool family from the union of `harvestTools` ids
 *   of the blocks that carry that material — that union is a subset of
 *   exactly one `mineable/<family>` table in the same registry — and use
 *   the family's full multiplier map as the repaired entry.
 *
 * What this deliberately does NOT change:
 *  - harvest gating: canHarvest()/harvestTools are untouched — a wrong-tier
 *    tool still takes the vanilla 100-divisor slow time and yields nothing.
 *  - versions before 1.20.5 (materials are already `mineable/<family>`):
 *    nothing matches, the repair is a no-op.
 *  - materials with no derivable family (unused keys, exotic modded data):
 *    left as stock.
 *
 * Vanilla side effect in the correct direction: the stock entry granted the
 * wooden shovel/axe/hoe a 2x multiplier on pickaxe-gated blocks; vanilla
 * gives non-family tools multiplier 1 (wooden shovel on iron_ore is 15 s,
 * not 7.5 s). The family map restores that too.
 *
 * Idempotent, and builds a NEW materials object — the minecraft-data module
 * cache is never mutated; the swap is scoped to the registry instance
 * passed in (mineflayer: bot.registry, which every digTime lookup reads at
 * call time).
 */

const INCORRECT_COMPONENT_RE = /^incorrect_for_.+_tool$/
const REPAIR_FLAG = '__toolSpeedRepaired'

function repairToolMaterials (registry) {
  const materials = registry && registry.materials
  if (!materials || materials[REPAIR_FLAG]) return registry

  const blocks = registry.blocksArray || Object.values(registry.blocks || {})
  const familyEntries = Object.entries(materials)
    .filter(([name]) => name.startsWith('mineable/'))

  // Union of harvestTools ids per material name, over all blocks.
  const harvestIdsByMaterial = {}
  for (const block of blocks) {
    if (!block || !block.material || !block.harvestTools) continue
    const set = harvestIdsByMaterial[block.material] ||
      (harvestIdsByMaterial[block.material] = new Set())
    for (const id of Object.keys(block.harvestTools)) set.add(id)
  }

  const repaired = {}
  for (const name of Object.keys(materials)) {
    const components = name.split(';')
    if (!components.some(c => INCORRECT_COMPONENT_RE.test(c))) continue
    const ids = harvestIdsByMaterial[name]
    if (!ids || ids.size === 0) continue // key unused by any gated block: leave stock
    const matches = familyEntries
      .filter(([, tools]) => [...ids].every(id => id in tools))
    if (matches.length !== 1) continue // ambiguous or unknown family: leave stock
    const familyMap = matches[0][1]
    repaired[name] = components.length === 1
      ? { ...familyMap } // pure incorrect_for_* key: vanilla-exact family map
      : { ...materials[name], ...familyMap } // compound: keep other components, family wins
  }

  const next = Object.assign({}, materials, repaired)
  Object.defineProperty(next, REPAIR_FLAG, { value: true, enumerable: false })
  registry.materials = next
  return registry
}

module.exports = repairToolMaterials
