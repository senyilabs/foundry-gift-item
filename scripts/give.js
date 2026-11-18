// The rules for handing things over, with no Foundry code, so they can be unit tested.

// Characters something can be given to: owned by a player, not the giver, not a party/group actor.
export function recipients(actors, giverId) {
  return actors.filter((a) => a.id !== giverId && a.hasPlayerOwner && !a.isGroup);
}

// Who answers an offer: a player online who owns the receiver, else the active GM (who then
// answers for an absent player). Users are { id, active, isGM, owns }.
export function responder(users, activeGM) {
  return users.find((u) => u.active && !u.isGM && u.owns)?.id ?? activeGM ?? null;
}

// Same rule as dnd5e's own sheet drop: only consumables stack, and only onto a top-level item
// with the same name that came from the same compendium entry.
export function findStack(receiverItems, item) {
  const source = item.compendiumSource;
  if (item.type !== "consumable" || !source) return null;
  return receiverItems.find((i) => i.type === "consumable" && i.compendiumSource === source
    && i.name === item.name && !i.container) ?? null;
}

// What to do on both sides. Returns null when the giver no longer has that many.
export function planItem({ have, amount, stack }) {
  if (!Number.isInteger(amount) || amount < 1 || amount > have) return null;
  return {
    giver: amount === have ? { delete: true } : { quantity: have - amount },
    receiver: stack ? { stackId: stack.id, quantity: stack.quantity + amount } : { create: amount },
  };
}

// Coins: keeps only positive whole amounts. Returns null when nothing is given or the purse
// is short of any coin.
export function planCoins(from, to, amounts) {
  const given = Object.fromEntries(Object.entries(amounts)
    .map(([k, v]) => [k, Math.floor(Number(v) || 0)]).filter(([, v]) => v > 0));
  const keys = Object.keys(given);
  if (!keys.length || keys.some((k) => !((from[k] ?? 0) >= given[k]))) return null;
  return {
    given,
    giver: Object.fromEntries(keys.map((k) => [k, from[k] - given[k]])),
    receiver: Object.fromEntries(keys.map((k) => [k, (to[k] ?? 0) + given[k]])),
  };
}
