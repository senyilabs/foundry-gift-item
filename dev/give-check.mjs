// End-to-end check in the victory-test world: the GM "Tester", "Player A" gives, "Player B" answers.
// Run from this folder with Foundry up: node dev/give-check.mjs
import { chromium } from "playwright-core";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log("FAIL  watchdog: stuck for 4 minutes"); process.exit(1); }, 240000);
const b = await chromium.launch();
const errs = [];
async function login(name) {
  const p = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  p.on("pageerror", (e) => errs.push(`${name} pageerror: ${e.message}`));
  p.on("console", (m) => { if (m.type() === "error" && !/404/.test(m.text())) errs.push(`${name} console: ${m.text().slice(0, 400)}`); });
  // A user still connected from an earlier run is left off the join list for a while.
  let id;
  for (let tries = 0; !id && tries < 20; tries++) {
    if (tries) await sleep(3000);
    await p.goto("http://localhost:30000/join", { waitUntil: "networkidle" });
    id = await p.evaluate((n) => [...document.querySelectorAll("select[name=userId] option")].find((o) => o.textContent.trim() === n)?.value, name);
  }
  await p.selectOption("select[name=userId]", id);
  await p.click("button[name=join]");
  await p.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 60000 });
  return p;
}
const check = (label, ok, detail = "") => console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);

let gm = await login("Tester");
await gm.evaluate(async () => {
  const config = game.settings.get("core", "moduleConfiguration");
  if (!config["give-item"]) await game.settings.set("core", "moduleConfiguration", { ...config, "give-item": true });
  if (!game.users.getName("Player B")) await User.create({ name: "Player B", role: CONST.USER_ROLES.PLAYER });
});
await gm.evaluate(() => game.socket.emit("reload"));
await sleep(1500);
await gm.close();
gm = await login("Tester");
await sleep(2000);
check("module active", await gm.evaluate(() => game.modules.get("give-item")?.active));

const ids = await gm.evaluate(async () => {
  await game.settings.set("give-item", "accept", true);
  await game.settings.set("give-item", "announce", true);
  for (const s of game.scenes.filter((s) => s.getFlag("world", "giTest"))) await s.delete();
  for (const a of game.actors.filter((a) => a.getFlag("world", "giTest"))) await a.delete();
  for (const m of game.messages.contents) await m.delete();
  const a = game.users.getName("Player A"), bUser = game.users.getName("Player B");
  const potion = { name: "Potion of Healing", type: "consumable", _stats: { compendiumSource: "Compendium.dnd5e.items.Item.giTestPotion0001" } };
  const aldric = await Actor.create({ name: "Aldric", type: "character", ownership: { default: 0, [a.id]: 3 },
    flags: { world: { giTest: true } }, system: { currency: { gp: 50, sp: 0, cp: 0, ep: 0, pp: 0 } } });
  const brenna = await Actor.create({ name: "Brenna", type: "character", ownership: { default: 0, [bUser.id]: 3 },
    flags: { world: { giTest: true } }, system: { currency: { gp: 5, sp: 0, cp: 0, ep: 0, pp: 0 } } });
  await aldric.createEmbeddedDocuments("Item", [
    { ...potion, system: { quantity: 3 } },
    { name: "Longsword", type: "weapon", system: { quantity: 1, equipped: true } },
    { name: "Ring of Spell Storing", type: "equipment", system: { quantity: 1, identified: false, unidentified: { name: "Plain Ring" } } },
    { name: "Backpack", type: "container", system: { quantity: 1 } },
  ]);
  const by = (type) => aldric.items.find((i) => i.type === type);
  const [p, sword, ring, bag] = ["consumable", "weapon", "equipment", "container"].map(by);
  if (!p || !sword || !ring || !bag) throw new Error("setup items missing: " + aldric.items.map((i) => i.type).join(","));
  await aldric.createEmbeddedDocuments("Item", [{ name: "Rope", type: "loot", system: { quantity: 1, container: bag.id } }]);
  await brenna.createEmbeddedDocuments("Item", [{ ...potion, system: { quantity: 1 } }]);
  const scene = await Scene.create({ name: "Give test", flags: { world: { giTest: true } }, width: 1000, height: 1000, grid: { size: 100 } });
  await scene.createEmbeddedDocuments("Token", [
    { ...(await aldric.getTokenDocument({ x: 100, y: 100 })).toObject() },
    { ...(await brenna.getTokenDocument({ x: 400, y: 400 })).toObject() },
  ]);
  await scene.activate();
  return { aldric: aldric.id, brenna: brenna.id, potion: p.id, sword: sword.id, ring: ring.id, bag: bag.id };
});
const pa = await login("Player A");
const pb = await login("Player B");
await sleep(2000);

const state = () => gm.evaluate(({ aldric, brenna }) => {
  const sum = (actor) => ({
    gp: game.actors.get(actor).system.currency.gp,
    items: game.actors.get(actor).items.map((i) => `${i.name}×${i.system.quantity}${i.system.equipped ? " (eq)" : ""}${i.system.container ? " in" : ""}`).sort(),
  });
  return { aldric: sum(aldric), brenna: sum(brenna), chat: game.messages.contents.map((m) => m.content.replace(/<[^>]+>/g, "")) };
}, ids);

// Clicks a button in the newest open dialog of a page, filling fields first.
async function dialog(page, action, fields = {}) {
  // Dialogs already answered linger while they fade out, so they're marked and skipped.
  await page.waitForSelector(".application.dialog:not([data-answered])", { timeout: 5000 });
  const text = await page.evaluate(({ action, fields }) => {
    const d = [...document.querySelectorAll(".application.dialog:not([data-answered])")].at(-1);
    d.dataset.answered = "1";
    for (const [name, value] of Object.entries(fields)) {
      const el = d.querySelector(`[name="${name}"]`);
      if (!el) throw new Error(`no field ${name} in: ${d.innerText.replace(/\s+/g, " ")}`);
      el.value = value;
    }
    const t = d.innerText.replace(/\s+/g, " ");
    d.querySelector(`button[data-action="${action}"]`).click();
    return t;
  }, { action, fields });
  await sleep(1200);
  return text;
}
const give = (itemId, receiverId) => pa.evaluate(({ aldric, itemId, receiverId }) => {
  game.modules.get("give-item").api.giveItem(game.actors.get(aldric).items.get(itemId), receiverId);
}, { ...ids, itemId, receiverId });

// 1. Two of three potions, accepted: they stack onto Brenna's potion.
await give(ids.potion, ids.brenna);
console.log("give dialog:", await dialog(pa, "ok", { amount: 2 }));
console.log("offer prompt:", await dialog(pb, "yes"));
await sleep(1500);
let s = await state();
check("potions moved and stacked", s.aldric.items.includes("Potion of Healing×1") && s.brenna.items.includes("Potion of Healing×3"), JSON.stringify(s));
check("chat line posted", s.chat.length === 1, JSON.stringify(s.chat));

// 2. Sword, declined: nothing moves, Player A hears about it.
await give(ids.sword, ids.brenna);
await dialog(pa, "ok");
await dialog(pb, "no");
await sleep(1000);
s = await state();
const note = await pa.evaluate(() => [...document.querySelectorAll("#notifications .notification")].map((n) => n.innerText).join(" | "));
check("declined sword stays", s.aldric.items.includes("Longsword×1 (eq)") && !s.brenna.items.some((i) => i.startsWith("Longsword")), note);

// 3. Sword again, accepted: arrives unequipped.
await give(ids.sword, ids.brenna);
await dialog(pa, "ok");
await dialog(pb, "yes");
await sleep(1500);
s = await state();
check("sword moved, unequipped", s.brenna.items.includes("Longsword×1") && !s.aldric.items.some((i) => i.startsWith("Longsword")), JSON.stringify(s.brenna.items));

// 4. Unidentified ring: the prompt shows only the unidentified name.
await give(ids.ring, ids.brenna);
await dialog(pa, "ok");
const ringPrompt = await dialog(pb, "yes");
check("ring prompt hides the real name", ringPrompt.includes("Plain Ring") && !ringPrompt.includes("Spell Storing"), ringPrompt);

// 5. Backpack with rope inside: both go over.
await give(ids.bag, ids.brenna);
await dialog(pa, "ok");
await dialog(pb, "yes");
await sleep(1500);
s = await state();
check("container goes with contents", s.brenna.items.includes("Backpack×1") && s.brenna.items.includes("Rope×1 in") && !s.aldric.items.includes("Rope×1 in"), JSON.stringify(s));

// 6. Coins: 20 gp.
await pa.evaluate(({ aldric }) => { game.modules.get("give-item").api.giveCoins(game.actors.get(aldric)); }, ids);
console.log("coins dialog:", await dialog(pa, "ok", { gp: 20, receiver: ids.brenna }));
await dialog(pb, "yes");
await sleep(1500);
s = await state();
check("coins moved", s.aldric.gp === 30 && s.brenna.gp === 25, `${s.aldric.gp} / ${s.brenna.gp}`);

// 7. A forged offer: Player B claims to give Aldric's potion to Brenna. The GM must ignore it.
await pb.evaluate(({ aldric, brenna, potion }) => {
  const a = game.actors.get(aldric), r = game.actors.get(brenna);
  game.socket.emit("module.give-item", { action: "offer", offer: { id: "forged", giver: a.uuid, giverName: a.name,
    receiver: r.uuid, receiverName: r.name, responder: game.user.id, itemId: potion, itemName: "x", amount: 1 } });
  game.socket.emit("module.give-item", { action: "answer", id: "forged", accepted: true });
}, ids);
await sleep(1500);
s = await state();
check("forged offer ignored", s.aldric.items.includes("Potion of Healing×1"), JSON.stringify(s.aldric.items));

// 8. Without the accept setting it goes straight over.
await gm.evaluate(() => game.settings.set("give-item", "accept", false));
await sleep(500);
await give(ids.potion, ids.brenna);
await dialog(pa, "ok");
await sleep(1500);
s = await state();
check("no prompt when accept is off", !s.aldric.items.some((i) => i.startsWith("Potion")) && s.brenna.items.includes("Potion of Healing×4"), JSON.stringify(s));
await gm.evaluate(() => game.settings.set("give-item", "accept", true));

// 9. The sheet: context menu entry and coin button for Player A.
const sheet = await pa.evaluate(async ({ aldric, brenna }) => {
  const actor = game.actors.get(aldric);
  await actor.createEmbeddedDocuments("Item", [{ name: "Lantern", type: "loot", system: { quantity: 1 } }]);
  await actor.sheet.render({ force: true });
  await new Promise((r) => setTimeout(r, 1500));
  const el = actor.sheet.element;
  el.querySelector('[data-tab="inventory"]')?.click();
  await new Promise((r) => setTimeout(r, 800));
  const coin = !!el.querySelector("section.currency .give-item-coins");
  const row = el.querySelector(".inventory-element [data-item-id]");
  row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 300, clientY: 300 }));
  await new Promise((r) => setTimeout(r, 800));
  const menu = [...document.querySelectorAll("#context-menu li")].map((li) => li.innerText.trim());
  document.querySelector("#context-menu")?.remove();
  // Brenna's sheet (only observed by Player A, if at all) must not get a coin button.
  return { coin, menu };
}, ids);
check("coin button on own sheet", sheet.coin);
check("context menu entry", sheet.menu.some((m) => m.includes("give this item")), JSON.stringify(sheet.menu));
await pa.screenshot({ path: "dev/sheet.png" });

// 10. Dropping an item on Brenna's token opens the give dialog with her picked.
const dropped = await pa.evaluate(async ({ aldric, brenna }) => {
  const actor = game.actors.get(aldric);
  await actor.createEmbeddedDocuments("Item", [{ name: "Torch", type: "loot", system: { quantity: 1 } }]);
  const torch = actor.items.getName("Torch");
  const allowed = Hooks.call("dropCanvasData", canvas, { type: "Item", uuid: torch.uuid, x: 450, y: 450 });
  await new Promise((r) => setTimeout(r, 1000));
  const d = [...document.querySelectorAll(".application.dialog:not([data-answered])")].at(-1);
  return { allowed, picked: d?.querySelector("[name=receiver]")?.value === brenna };
}, ids);
check("drop on token opens dialog for that character", dropped.allowed === false && dropped.picked, JSON.stringify(dropped));
await dialog(pa, "ok");
await dialog(pb, "yes");
await sleep(1500);
s = await state();
check("torch arrived", s.brenna.items.includes("Torch×1"));
console.log("chat:", JSON.stringify(s.chat, null, 1));

console.log(errs.length ? errs.join("\n") : "no page errors");
await b.close();
process.exit(0);
