import { recipients, responder, findStack, planItem, planCoins } from "./give.js";

const MODULE_ID = "gift-item";
const SOCKET = `module.${MODULE_ID}`;
const { DialogV2 } = foundry.applications.api;

const t = (key, data) => (data ? game.i18n.format(key, data) : game.i18n.localize(key));
const setting = (key) => game.settings.get(MODULE_ID, key);
const isPhysical = (item) => item?.system && "quantity" in item.system;

// Players should not learn what an unidentified item is from the prompt or the chat line.
const itemName = (item) => (item.system.identified === false
  ? item.system.unidentified?.name || t("DND5E.Unidentified.Title")
  : item.name);

const coinText = (coins) => Object.entries(coins)
  .map(([k, v]) => `${v} ${t(CONFIG.DND5E.currencies[k]?.abbreviation ?? k)}`).join(", ");

/* -------------------------------------------- */
/*  Messages                                    */
/* -------------------------------------------- */

// An offer goes to every client. The responder (the receiver's player, or the GM for an absent
// player) answers it, and the active GM carries it out. The server stamps each message with its
// sender, so the GM checks the offer against who really sent it.
const offers = new Map(); // id -> offer, kept by the active GM until it's settled

function send(msg) {
  game.socket.emit(SOCKET, msg);
  handle(msg, game.user.id);
}

function handle(msg, senderId) {
  if (msg.action === "offer") {
    if (game.users.activeGM?.isSelf) receiveOffer(msg.offer, senderId);
    if (msg.offer.responder === game.user.id && setting("accept")) ask(msg.offer);
  } else if (msg.action === "answer") {
    const offer = offers.get(msg.id);
    if (!offer || !game.users.activeGM?.isSelf || senderId !== offer.responder) return;
    offers.delete(msg.id);
    if (msg.accepted) settle(offer);
    else send({ action: "result", id: offer.id, giverUser: offer.giverUser, status: "declined", receiverName: offer.receiverName });
  } else if (msg.action === "result" && msg.giverUser === game.user.id) {
    if (msg.status === "declined") ui.notifications.info(t("GIVEITEM.Declined", { receiver: msg.receiverName }));
    if (msg.status === "gone") ui.notifications.warn(t("GIVEITEM.Error.Gone"));
  }
}

function receiveOffer(offer, senderId) {
  const user = game.users.get(senderId);
  const giver = fromUuidSync(offer.giver);
  const receiver = fromUuidSync(offer.receiver);
  if (!user || !giver?.testUserPermission(user, "OWNER") || !receiver?.hasPlayerOwner) return;
  const answerer = game.users.get(offer.responder);
  if (!answerer?.isGM && !receiver.testUserPermission(answerer, "OWNER")) return;
  offer = { ...offer, giverUser: senderId };
  if (!setting("accept")) return settle(offer);
  offers.set(offer.id, offer);
}

async function ask(offer) {
  const content = offer.coins
    ? t("GIVEITEM.Offer.Coins", { giver: offer.giverName, coins: coinText(offer.coins), receiver: offer.receiverName })
    : t("GIVEITEM.Offer.Item", { giver: offer.giverName, quantity: offer.amount, item: offer.itemName, receiver: offer.receiverName });
  const accepted = await DialogV2.confirm({
    window: { title: "GIVEITEM.Offer.Title" },
    content: `<p>${foundry.utils.escapeHTML(content)}</p>`,
  });
  send({ action: "answer", id: offer.id, accepted: !!accepted });
}

/* -------------------------------------------- */
/*  Handing over (active GM only)               */
/* -------------------------------------------- */

async function settle(offer) {
  const giver = await fromUuid(offer.giver);
  const receiver = await fromUuid(offer.receiver);
  const done = giver && receiver && (offer.coins ? await moveCoins(giver, receiver, offer.coins) : await moveItem(giver, receiver, offer));
  if (!done) {
    send({ action: "result", id: offer.id, giverUser: offer.giverUser, status: "gone" });
    return;
  }
  if (!setting("announce")) return;
  const content = offer.coins
    ? t("GIVEITEM.Chat.Coins", { giver: giver.name, coins: coinText(offer.coins), receiver: receiver.name })
    : t("GIVEITEM.Chat.Item", { giver: giver.name, quantity: offer.amount, item: offer.itemName, receiver: receiver.name });
  ChatMessage.create({ content: `<p>${foundry.utils.escapeHTML(content)}</p>`, speaker: ChatMessage.getSpeaker({ actor: giver }) });
}

async function moveItem(giver, receiver, offer) {
  const item = giver.items.get(offer.itemId);
  if (!isPhysical(item)) return false;
  const stack = findStack(receiver.items.map((i) => ({
    id: i.id, type: i.type, name: i.name, container: i.system.container, quantity: i.system.quantity,
    compendiumSource: i._stats.compendiumSource,
  })), { type: item.type, name: item.name, compendiumSource: item._stats.compendiumSource });
  const plan = planItem({ have: item.system.quantity, amount: offer.amount, stack });
  if (!plan) return false;

  if (plan.receiver.stackId) {
    await receiver.items.get(plan.receiver.stackId).update({ "system.quantity": plan.receiver.quantity });
  } else {
    // Containers go over with everything inside them.
    const data = await CONFIG.Item.documentClass.createWithContents([item], {
      transformFirst: (doc) => {
        const d = doc instanceof Item ? doc.toObject() : doc;
        foundry.utils.mergeObject(d, { "system.quantity": plan.receiver.create, "system.equipped": false, "system.attuned": false });
        return d;
      },
    });
    await receiver.createEmbeddedDocuments("Item", data, { keepId: true });
  }

  if (plan.giver.delete) await item.delete({ deleteContents: true });
  else await item.update({ "system.quantity": plan.giver.quantity });
  return true;
}

async function moveCoins(giver, receiver, coins) {
  const plan = planCoins(giver.system.currency ?? {}, receiver.system.currency ?? {}, coins);
  if (!plan) return false;
  await giver.update(Object.fromEntries(Object.entries(plan.giver).map(([k, v]) => [`system.currency.${k}`, v])));
  await receiver.update(Object.fromEntries(Object.entries(plan.receiver).map(([k, v]) => [`system.currency.${k}`, v])));
  return true;
}

/* -------------------------------------------- */
/*  Giving                                      */
/* -------------------------------------------- */

const candidates = (giver) => recipients(game.actors.map((a) => ({
  id: a.id, hasPlayerOwner: a.hasPlayerOwner, isGroup: !!a.system.isGroup, actor: a,
})), giver.id).map((c) => c.actor);

function recipientSelect(list, selectedId) {
  const options = list.map((a) => `<option value="${a.id}" ${a.id === selectedId ? "selected" : ""}>${foundry.utils.escapeHTML(a.name)}</option>`);
  return `<div class="form-group"><label>${t("GIVEITEM.Dialog.Recipient")}</label>
    <div class="form-fields"><select name="receiver">${options.join("")}</select></div></div>`;
}

// Fills in the parts every offer needs and sends it. Without an active GM nobody could carry it out.
function offer(giver, receiver, parts) {
  if (!game.users.activeGM) {
    ui.notifications.warn(t("GIVEITEM.Error.NoGM"));
    return;
  }
  const users = game.users.map((u) => ({ id: u.id, active: u.active, isGM: u.isGM, owns: receiver.testUserPermission(u, "OWNER") }));
  send({ action: "offer", offer: {
    id: foundry.utils.randomID(),
    giver: giver.uuid, giverName: giver.name,
    receiver: receiver.uuid, receiverName: receiver.name,
    responder: responder(users, game.users.activeGM.id),
    ...parts,
  } });
  if (setting("accept")) ui.notifications.info(t("GIVEITEM.Sent", { receiver: receiver.name }));
}

async function giveItem(item, receiverId) {
  const giver = item.actor;
  const list = candidates(giver);
  if (!list.length) return ui.notifications.warn(t("GIVEITEM.Error.NoRecipients"));
  const have = item.system.quantity ?? 1;
  const quantity = have > 1
    ? `<div class="form-group"><label>${t("GIVEITEM.Dialog.Quantity")}</label>
        <div class="form-fields"><input type="number" name="amount" value="1" min="1" max="${have}" step="1"></div></div>`
    : "";
  const result = await DialogV2.prompt({
    window: { title: t("GIVEITEM.Dialog.Title", { item: itemName(item) }) },
    content: recipientSelect(list, receiverId) + quantity,
    ok: {
      label: "GIVEITEM.Dialog.Confirm",
      callback: (event, button) => ({
        receiver: button.form.elements.receiver.value,
        amount: have > 1 ? Number(button.form.elements.amount.value) : 1,
      }),
    },
  });
  if (!result) return;
  const receiver = game.actors.get(result.receiver);
  if (!receiver || !planItem({ have, amount: result.amount })) return;
  offer(giver, receiver, { itemId: item.id, itemName: itemName(item), amount: result.amount });
}

async function giveCoins(giver) {
  const list = candidates(giver);
  if (!list.length) return ui.notifications.warn(t("GIVEITEM.Error.NoRecipients"));
  const purse = giver.system.currency ?? {};
  const inputs = Object.entries(CONFIG.DND5E.currencies).map(([k, c]) => `
    <div class="form-group"><label>${t(c.label)}</label>
      <div class="form-fields"><input type="number" name="${k}" value="0" min="0" max="${purse[k] ?? 0}" step="1"></div></div>`);
  const result = await DialogV2.prompt({
    window: { title: "GIVEITEM.Dialog.CoinsTitle" },
    content: recipientSelect(list) + inputs.join(""),
    ok: {
      label: "GIVEITEM.Dialog.Confirm",
      callback: (event, button) => {
        const els = button.form.elements;
        return { receiver: els.receiver.value, coins: Object.fromEntries(Object.keys(CONFIG.DND5E.currencies).map((k) => [k, els[k].value])) };
      },
    },
  });
  if (!result) return;
  const receiver = game.actors.get(result.receiver);
  const plan = receiver && planCoins(purse, receiver.system.currency ?? {}, result.coins);
  if (!plan) return ui.notifications.warn(t("GIVEITEM.Error.NoCoins"));
  offer(giver, receiver, { coins: plan.given });
}

/* -------------------------------------------- */
/*  Hooks                                       */
/* -------------------------------------------- */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "accept", {
    name: "GIVEITEM.Settings.Accept.Name", hint: "GIVEITEM.Settings.Accept.Hint",
    scope: "world", config: true, type: Boolean, default: true,
  });
  game.settings.register(MODULE_ID, "announce", {
    name: "GIVEITEM.Settings.Announce.Name", hint: "GIVEITEM.Settings.Announce.Hint",
    scope: "world", config: true, type: Boolean, default: true,
  });
});

Hooks.once("ready", () => {
  if (game.system.id !== "dnd5e") return;
  game.socket.on(SOCKET, handle);
  game.modules.get(MODULE_ID).api = { giveItem, giveCoins };
});

const canGive = (item) => isPhysical(item) && item.actor && item.isOwner && !item.actor.system.isGroup;

// Right-click an item on the character sheet.
Hooks.on("dnd5e.getItemContextOptions", (item, options) => {
  options.push({
    label: "GIVEITEM.Give",
    icon: "fa-solid fa-hand-holding-hand",
    visible: () => canGive(item),
    onClick: () => giveItem(item),
  });
});

// A button next to the purse for coins.
Hooks.on("renderActorSheetV2", (app, html) => {
  const actor = app.actor;
  if (game.system.id !== "dnd5e" || !actor?.isOwner || actor.system.isGroup || !actor.system.currency) return;
  const purse = html.querySelector("section.currency");
  if (!purse || purse.querySelector(".gift-item-coins")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "gift-item-coins unbutton always-interactive";
  button.dataset.tooltip = "GIVEITEM.GiveCoins";
  button.setAttribute("aria-label", t("GIVEITEM.GiveCoins"));
  button.innerHTML = `<i class="fa-solid fa-hand-holding-dollar" inert></i>`;
  button.addEventListener("click", () => giveCoins(actor));
  purse.prepend(button);
});

// Drop an item from your sheet onto someone else's token.
Hooks.on("dropCanvasData", (canvas, data) => {
  if (game.system.id !== "dnd5e" || data.type !== "Item" || !data.uuid) return;
  const item = fromUuidSync(data.uuid);
  if (!canGive(item)) return;
  const token = canvas.tokens.placeables.find((tk) => tk.actor && tk.actor !== item.actor && tk.bounds.contains(data.x, data.y));
  if (!token?.actor?.hasPlayerOwner || token.actor.system.isGroup) return;
  giveItem(item, token.actor.id);
  return false;
});
