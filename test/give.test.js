import { test } from "node:test";
import assert from "node:assert/strict";
import { recipients, responder, findStack, planItem, planCoins } from "../scripts/give.js";

test("recipients: other player characters, no groups", () => {
  const actors = [
    { id: "me", hasPlayerOwner: true },
    { id: "ally", hasPlayerOwner: true },
    { id: "goblin", hasPlayerOwner: false },
    { id: "party", hasPlayerOwner: true, isGroup: true },
  ];
  assert.deepEqual(recipients(actors, "me").map((a) => a.id), ["ally"]);
});

test("responder: online owner first, GM when the owner is away", () => {
  const users = [
    { id: "gm", active: true, isGM: true, owns: true },
    { id: "away", active: false, isGM: false, owns: true },
    { id: "b", active: true, isGM: false, owns: true },
  ];
  assert.equal(responder(users, "gm"), "b");
  assert.equal(responder(users.slice(0, 2), "gm"), "gm");
  assert.equal(responder([], null), null);
});

test("findStack: consumables from the same source and name, top level only", () => {
  const potion = { type: "consumable", name: "Potion", compendiumSource: "C.potion" };
  const items = [
    { id: "in-bag", ...potion, container: "bag" },
    { id: "loose", ...potion, container: null },
  ];
  assert.equal(findStack(items, potion)?.id, "loose");
  assert.equal(findStack(items, { ...potion, name: "Potion (renamed)" }), null);
  assert.equal(findStack(items, { ...potion, compendiumSource: null }), null);
  assert.equal(findStack([{ id: "s", type: "weapon", name: "Sword", compendiumSource: "C.s" }],
    { type: "weapon", name: "Sword", compendiumSource: "C.s" }), null);
});

test("planItem: part of a stack, all of it, onto a stack", () => {
  assert.deepEqual(planItem({ have: 5, amount: 2 }), { giver: { quantity: 3 }, receiver: { create: 2 } });
  assert.deepEqual(planItem({ have: 2, amount: 2, stack: { id: "x", quantity: 1 } }),
    { giver: { delete: true }, receiver: { stackId: "x", quantity: 3 } });
});

test("planItem: refuses more than the giver has, or nonsense", () => {
  assert.equal(planItem({ have: 1, amount: 2 }), null);
  assert.equal(planItem({ have: 3, amount: 0 }), null);
  assert.equal(planItem({ have: 3, amount: 1.5 }), null);
});

test("planCoins: moves only what was entered", () => {
  assert.deepEqual(planCoins({ gp: 10, sp: 5 }, { gp: 1 }, { gp: "4", sp: 0, cp: "" }),
    { given: { gp: 4 }, giver: { gp: 6 }, receiver: { gp: 5 } });
});

test("planCoins: nothing entered or not enough", () => {
  assert.equal(planCoins({ gp: 10 }, {}, { gp: 0 }), null);
  assert.equal(planCoins({ gp: 10 }, {}, { gp: 11 }), null);
  assert.equal(planCoins({ gp: 10 }, {}, { pp: 1 }), null);
  assert.equal(planCoins({ gp: 10 }, {}, { gp: -3 }), null);
});
