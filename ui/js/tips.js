// Facts and tips shown on the launch screen while Minecraft loads.
export const TIPS = [
  'The Creeper started as a mistake: Notch swapped the height and length while modelling a pig.',
  'A full Minecraft day lasts 20 real-world minutes.',
  'Endermen are three blocks tall, so a two-block-high tunnel keeps them out.',
  "The Ghast's cries were recorded from C418's cat.",
  'Beds explode if you try to sleep in the Nether or the End.',
  "Piglins won't attack you if you're wearing at least one piece of gold armour.",
  'Creepers and phantoms are scared of cats.',
  'Sneaking stops you walking off the edge of a block.',
  "Netherite items don't burn in lava — they float.",
  'A campfire under a beehive keeps the bees calm while you harvest honey.',
  'Water poured in the Nether evaporates instantly.',
  'Diamonds are most common deep down, below about Y -50.',
  "The Warden is blind: it tracks you by sound and smell, so sneak around it.",
  'Wool blocks stop vibrations from reaching sculk sensors.',
  'A compass spins in the Nether — unless it is linked to a lodestone.',
  'Axolotls fight alongside you underwater and can give you Regeneration.',
  'Iron golems sometimes offer poppies to villagers.',
  'Honey blocks slow your fall and stop you jumping high.',
  'Shift-click moves a whole stack between inventories.',
  'Press F5 to switch between first and third person.',
  'Elytra plus firework rockets is the fastest way to travel.',
  'A frost walker boot turns water into ice as you walk.',
  'Smelting a sponge in a furnace dries it out for reuse.',
  'Orbit: press Ctrl+K to launch or open anything.',
  'Orbit: drag a .mrpack onto the window to import a modpack.',
  'Orbit: Settings → Customize lets you restyle the whole launcher.',
];

export function randomTips() {
  return [...TIPS].sort(() => Math.random() - 0.5);
}
