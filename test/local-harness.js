"use strict";

/**
 * local-harness.js — offline smoke test for adb-plugin-giveaways.
 * Run: npm test   (node test/local-harness.js). No bot / no Mongo.
 *
 * Captures load()'s scheduled callback and runs it explicitly with offline clients.
 */

const { createMockCtx } = require("./mock-ctx");
const { load } = require("../index");
const { createGiveawayCommand, pickWinners } = require("../commands/giveaway");

let passed = 0;
let failed = 0;
function assert(cond, label) {
	if (cond) {
		console.log(`  PASS  ${label}`);
		passed++;
	} else {
		console.error(`  FAIL  ${label}`);
		failed++;
	}
}

// pickWinners only needs client.user.id. The command paths also touch
// client.users.fetch (DM winners on `end`) and client.channels.fetch
// (reroll/cancel); both return offline stubs so the harness never hits the net.
const dmLog = [];
const announcements = [];
const edits = [];
const fakeClient = {
	user: { id: "mock-bot-id" },
	users: {
		fetch: async (id) => ({ id, send: async (msg) => dmLog.push({ id, msg }) }),
	},
	channels: {
		fetch: async () => ({
			send: async (payload) => announcements.push(payload),
			messages: { fetch: async () => ({ embeds: [{ title: "Giveaway!" }], edit: async (payload) => edits.push(payload), delete: async () => {} }) },
		}),
	},
};

function makeGiveaway(entrants, winnerCount) {
	return { entrants: [...entrants], winnerCount, winners: [], ended: false };
}

// Minimal fake interaction for the giveaway command. `msgId` sets the id the
// mock reply returns, which becomes the giveaway's messageId — pass distinct
// ids so multiple started giveaways don't collide in the in-memory store.
function fakeInteraction(sub, opts = {}, msgId = "msg-1") {
	const replies = [];
	return {
		deferred: false,
		guildId: "guild-1",
		channelId: "chan-1",
		guild: { id: "guild-1", name: "Test Guild" },
		user: { id: "host-1", toString: () => "<@host-1>" },
		client: fakeClient,
		options: {
			getSubcommand: () => sub,
			getString: (n) => (n in opts ? opts[n] : null),
			getInteger: (n) => (n in opts ? opts[n] : null),
			getRole: (n) => (n in opts ? opts[n] : null),
		},
		async deferReply(options) { this.deferred = true; this.ephemeral = options?.ephemeral ?? false; },
		async fetchReply() { return { id: msgId }; },
		async editReply(payload) {
			if (!this.deferred) throw new Error("editReply before acknowledgement");
			replies.push(payload);
			return { id: msgId };
		},
		async reply(payload) {
			if (this.deferred) throw new Error("reply after acknowledgement");
			replies.push(payload);
			// start uses fetchReply:true and reads msg.id
			return { id: msgId, react: async () => {} };
		},
		replies,
	};
}

async function run() {
	console.log("\n=== adb-plugin-giveaways — Local Harness ===\n");

	// --- load() ---------------------------------------------------------
	const { ctx, registeredCommands, registeredEvents, models, emitEvent } = createMockCtx({
		pluginName: "adb-plugin-giveaways",
	});
	Object.assign(ctx.client, fakeClient);
	const cron = require("node-cron");
	const schedule = cron.schedule;
	let sweep;
	let stopped = false;
	cron.schedule = (_pattern, callback) => { sweep = callback; return { stop: () => { stopped = true; } }; };
	try { await load(ctx); } finally { cron.schedule = schedule; }
	assert(registeredCommands.has("giveaway"), "/giveaway registered");
	assert((registeredEvents.get("interactionCreate") || []).length === 1, "interactionCreate handler registered");

	// --- pickWinners unit tests ----------------------------------------
	// fewer entrants than winners -> all become winners
	{
		const g = makeGiveaway(["a", "b"], 5);
		pickWinners(g, fakeClient);
		assert(g.winners.length === 2, "fewer entrants than winners: all win");
		assert(g.ended === true, "fewer entrants: giveaway marked ended");
	}
	// exact
	{
		const g = makeGiveaway(["a", "b", "c"], 3);
		pickWinners(g, fakeClient);
		assert(g.winners.length === 3, "exact entrants == winners: all win");
	}
	// more entrants than winners -> exactly winnerCount
	{
		const g = makeGiveaway(["a", "b", "c", "d", "e"], 2);
		pickWinners(g, fakeClient);
		assert(g.winners.length === 2, "more entrants than winners: winnerCount winners");
		const uniq = new Set(g.winners);
		assert(uniq.size === g.winners.length, "more entrants: no duplicate winners");
		assert(g.winners.every((id) => g.entrants.includes(id)), "more entrants: winners drawn from entrants");
	}
	// no duplicate winners across a larger draw
	{
		const g = makeGiveaway(["a", "b", "c", "d", "e", "f"], 6);
		pickWinners(g, fakeClient);
		assert(new Set(g.winners).size === 6, "full draw: no duplicate winners");
	}
	// empty entrants -> no winners, early return (not marked ended)
	{
		const g = makeGiveaway([], 3);
		pickWinners(g, fakeClient);
		assert(g.winners.length === 0, "empty entrants: no winners");
	}
	// bot's own id is excluded from the pool
	{
		const g = makeGiveaway(["mock-bot-id", "real-user"], 5);
		pickWinners(g, fakeClient);
		assert(g.winners.length === 1 && g.winners[0] === "real-user", "bot id excluded from winners");
	}

	// --- start path ----------------------------------------------------
	const giveaway = registeredCommands.get("giveaway");

	// invalid duration
	const bad = fakeInteraction("start", { prize: "Nitro", duration: "5s" });
	await giveaway.execute(bad);
	assert(/Invalid duration/.test(bad.replies[0].content), "start rejects sub-10s duration");

	// valid start -> announces embed and persists a giveaway doc
	const start = fakeInteraction("start", { prize: "Nitro", duration: "1h", winners: 2 });
	await giveaway.execute(start);
	assert(!!start.replies[0].embeds, "start replies with a giveaway embed");

	// the created doc should now show up in `list`
	const list = fakeInteraction("list");
	await giveaway.execute(list);
	assert(/Nitro/.test(list.replies[0].content), "list shows the started giveaway");

	// --- end path ------------------------------------------------------
	// The started "Nitro" giveaway persisted with messageId "msg-1" (the mock
	// reply id). Ending it draws winners (none: no entrants) and DMs them
	// (none), then reports success — exercises the end branch end-to-end.
	const end = fakeInteraction("end", { message_id: "msg-1" });
	await giveaway.execute(end);
	assert(/ended early/i.test(end.replies[0].content), "end reports the giveaway ended");

	// ending an already-ended giveaway is rejected
	const endAgain = fakeInteraction("end", { message_id: "msg-1" });
	await giveaway.execute(endAgain);
	assert(/already ended/i.test(endAgain.replies[0].content), "end rejects an already-ended giveaway");

	// --- cancel path ---------------------------------------------------
	const startForCancel = fakeInteraction("start", { prize: "Cancelme", duration: "1h" }, "msg-cancel");
	await giveaway.execute(startForCancel);
	const cancel = fakeInteraction("cancel", { message_id: "msg-cancel" });
	await giveaway.execute(cancel);
	assert(/cancelled/i.test(cancel.replies[0].content), "cancel reports the giveaway cancelled");

	// cancel of a non-existent giveaway is rejected cleanly
	const cancelMissing = fakeInteraction("cancel", { message_id: "does-not-exist" });
	await giveaway.execute(cancelMissing);
	assert(/not found/i.test(cancelMissing.replies[0].content), "cancel rejects unknown message_id");

	// --- member entry projection (/me/entries) -------------------------
	const entryModel = models.get("plugin_adb-plugin-giveaways_entry");
	assert(!!entryModel, "entry model defined for the member page");
	const entries = () => entryModel._store.filter((e) => e.giveawayId === "msg-entries");

	const startEntries = fakeInteraction("start", { prize: "Keycap Set", duration: "1h" }, "msg-entries");
	await giveaway.execute(startEntries);

	// Minimal button interaction for the giveaway_enter handler.
	function buttonPress(userId, messageId = "msg-entries") {
		return {
			...fakeInteraction(null),
			isButton: () => true,
			customId: "giveaway_enter",
			guildId: "guild-1",
			message: { id: messageId },
			user: { id: userId, createdAt: new Date(Date.now() - 100 * 86400000) },
			guild: { members: { fetch: async () => null } },
		};
	}

	await emitEvent("interactionCreate", buttonPress("joiner-1"));
	assert(entries().length === 1, "joining creates an entry doc");
	assert(entries()[0].userId === "joiner-1", "entry doc's userId is the joiner");
	assert(entries()[0].prize === "Keycap Set", "entry doc carries the giveaway prize");

	// leaving deletes the doc; rejoin so the end-with-winner check has an entrant
	await emitEvent("interactionCreate", buttonPress("joiner-1"));
	assert(entries().length === 0, "leaving deletes the entry doc");
	await emitEvent("interactionCreate", buttonPress("joiner-1"));

	const endEntries = fakeInteraction("end", { message_id: "msg-entries" });
	await giveaway.execute(endEntries);
	assert(/ended early/i.test(endEntries.replies[0].content), "entrant giveaway ends cleanly");
	assert(entries().length === 1 && entries()[0].won === true, "finishing with a winner marks the entry won: true");

	// --- factory options ----------------------------------------------
	const custom = createGiveawayCommand({}, null, { defaultDuration: "2h", maxWinners: 3 });
	assert(custom.data.name === "giveaway", "factory returns a giveaway command");

	const Model = models.get("plugin_adb-plugin-giveaways_giveaway");
	const text = (payload) => typeof payload === "string" ? payload : payload.content || "";
	assert(announcements.filter((p) => text(p).includes("Keycap Set")).length === 1 && edits.length > 0, "manual end announces winners and disables the original button");
	const duplicatePool = makeGiveaway(["a", "a", "b"], 3);
	await pickWinners(duplicatePool, fakeClient);
	assert(new Set(duplicatePool.winners).size === duplicatePool.winners.length, "persisted duplicate entrants cannot win twice");

	await giveaway.execute(fakeInteraction("start", { prize: "Concurrency", duration: "1h" }, "concurrent"));
	await Promise.all([1, 2].map(() => emitEvent("interactionCreate", buttonPress("same-user", "concurrent"))));
	assert(await entryModel.countDocuments({ giveawayId: "concurrent", userId: "same-user" }) <= 1, "overlapping entry clicks cannot create duplicate member projections");
	await emitEvent("interactionCreate", buttonPress("leaver", "concurrent"));
	await Promise.all([
		emitEvent("interactionCreate", buttonPress("leaver", "concurrent")),
		emitEvent("interactionCreate", buttonPress("joiner", "concurrent")),
	]);
	const entrantState = await Model.findOne({ messageId: "concurrent" });
	assert(!entrantState.entrants.includes("leaver") && entrantState.entrants.includes("joiner"), "overlapping leave and join preserve both changes");

	await Model.updateOne({ messageId: "concurrent" }, { endsAt: new Date(Date.now() - 1) });
	const late = buttonPress("late", "concurrent");
	await emitEvent("interactionCreate", late);
	assert(!(await Model.findOne({ messageId: "concurrent" })).entrants.includes("late"), "expired giveaways reject entries before the cron sweep");
	assert(late.deferred && late.ephemeral, "entry interactions defer privately before DB work");

	const beforeDraw = announcements.length;
	await Promise.all([sweep(), sweep(), giveaway.execute(fakeInteraction("end", { message_id: "concurrent" }))]);
	assert(announcements.length - beforeDraw === 1, "overlapping sweeps and manual end announce exactly one draw");
	const drawn = await Model.findOne({ messageId: "concurrent" });
	const won = await entryModel.find({ giveawayId: "concurrent", won: true });
	assert(won.length === drawn.winners.length && won.every((entry) => drawn.winners.includes(entry.userId)), "winner projections match the one committed draw");
	const beforeReroll = announcements.length;
	await Promise.all([1, 2].map(() => giveaway.execute(fakeInteraction("reroll", { message_id: "concurrent" }))));
	assert(announcements.length - beforeReroll === 1, "overlapping rerolls publish only one new draw");
	const rerolled = await Model.findOne({ messageId: "concurrent" });
	const rerolledEntries = await entryModel.find({ giveawayId: "concurrent", won: true });
	assert(rerolledEntries.length === rerolled.winners.length && rerolledEntries.every((entry) => rerolled.winners.includes(entry.userId)), "reroll replaces previous winner badges consistently");

	await ctx.db.updatePluginConfig("guild-1", "adb-plugin-giveaways", { defaultDuration: "3m", maxWinners: 2 });
	const configuredStart = fakeInteraction("start", { prize: "Configured" }, "configured");
	await giveaway.execute(configuredStart);
	assert(Math.abs((await Model.findOne({ messageId: "configured" })).endsAt - Date.now() - 180000) < 2000, "start reads default duration from dashboard settings");
	const tooMany = fakeInteraction("start", { prize: "Too many", winners: 3 }, "too-many");
	await giveaway.execute(tooMany);
	assert(!await Model.findOne({ messageId: "too-many" }), "start enforces the guild's configured winner maximum");
	const longPrize = fakeInteraction("start", { prize: "x".repeat(5000) }, "long-prize");
	await giveaway.execute(longPrize).catch(() => {});
	assert(!await Model.findOne({ messageId: "long-prize" }) && longPrize.replies.length === 1, "oversized prizes are rejected with a response, not a builder crash");

	for (let i = 0; i < 15; i++) await Model.create({
		guildId: "guild-1", channelId: "chan-1", messageId: `long-list-${i}`, prize: "p".repeat(256),
		endsAt: new Date(Date.now() + 60000), hostId: "host-1",
	});
	const longList = fakeInteraction("list");
	await giveaway.execute(longList);
	assert(longList.replies.every((p) => text(p).length <= 2000), "giveaway list respects Discord's content limit");

	const errors = [];
	ctx.logger.error = (...args) => errors.push(args);
	const create = Model.create;
	Model.create = async () => { throw new Error("database unavailable"); };
	const failedStart = fakeInteraction("start", { prize: "Do not enter" }, "failed-start");
	await giveaway.execute(failedStart).catch(() => {});
	Model.create = create;
	assert(failedStart.replies.length > 0 && !failedStart.replies.at(-1).components?.length, "failed persistence cannot leave a live entry button behind");
	assert(start.deferred && list.deferred && end.deferred, "giveaway commands acknowledge before DB work");
	await giveaway.execute(fakeInteraction("start", { prize: "Cancel retry" }, "cancel-retry"));
	const deleteOne = Model.deleteOne;
	Model.deleteOne = async () => { throw new Error("delete unavailable"); };
	const failedCancel = fakeInteraction("cancel", { message_id: "cancel-retry" });
	await giveaway.execute(failedCancel).catch(() => {});
	Model.deleteOne = deleteOne;
	assert(failedCancel.replies.length === 1 && !(await Model.findOne({ messageId: "cancel-retry" })).drawing, "failed cancellation releases its claim and returns a response");
	await giveaway.execute(fakeInteraction("cancel", { message_id: "cancel-retry" }));
	assert(!await Model.findOne({ messageId: "cancel-retry" }), "cancellation can be retried after a storage error");

	await giveaway.execute(fakeInteraction("start", { prize: "Cancel entry cleanup" }, "cancel-entry-retry"));
	await emitEvent("interactionCreate", buttonPress("cancel-member", "cancel-entry-retry"));
	const deleteEntries = entryModel.deleteMany;
	entryModel.deleteMany = async () => { throw new Error("entry cleanup unavailable"); };
	try {
		await giveaway.execute(fakeInteraction("cancel", { message_id: "cancel-entry-retry" }));
	} finally {
		entryModel.deleteMany = deleteEntries;
	}
	const retainedCancel = await Model.findOne({ messageId: "cancel-entry-retry" });
	assert(retainedCancel && !retainedCancel.drawing && await entryModel.countDocuments({ giveawayId: "cancel-entry-retry" }) === 1, "failed entry cleanup retains a retryable cancellation source");
	const retryCancel = fakeInteraction("cancel", { message_id: "cancel-entry-retry" });
	await giveaway.execute(retryCancel);
	assert(!await Model.findOne({ messageId: "cancel-entry-retry" }) && await entryModel.countDocuments({ giveawayId: "cancel-entry-retry" }) === 0 && /cancelled/i.test(retryCancel.replies[0].content), "retrying cancellation removes both the source and member entries");

	const find = Model.find;
	Model.find = () => { throw new Error("scan unavailable"); };
	const beforeErrors = errors.length;
	await sweep();
	Model.find = find;
	assert(errors.length === beforeErrors + 1, "cron query failure is handled and logged");

	await giveaway.execute(fakeInteraction("start", { prize: "Expires during role lookup", role: { id: "required", toString: () => "<@&required>" } }, "role-expiry"));
	const roleExpiry = buttonPress("late-role", "role-expiry");
	roleExpiry.guild.members.fetch = async () => {
		await Model.updateOne({ messageId: "role-expiry" }, { endsAt: new Date(Date.now() - 1) });
		return { roles: { cache: new Map([["required", {}]]) } };
	};
	await emitEvent("interactionCreate", roleExpiry);
	assert(!(await Model.findOne({ messageId: "role-expiry" })).entrants.length, "entry eligibility rechecks expiration after slow role lookups");

	await Model.create({ guildId: "guild-1", channelId: "chan-1", messageId: "legacy-limits", prize: "@everyone" + "p".repeat(5000), hostId: "host-1", endsAt: new Date(Date.now() + 100000), winnerCount: 50, entrants: Array.from({ length: 50 }, (_, i) => String(100000000000000000n + BigInt(i))) });
	const beforeLongDraw = announcements.length;
	await giveaway.execute(fakeInteraction("end", { message_id: "legacy-limits" }));
	const longDraw = announcements[beforeLongDraw];
	assert(longDraw && text(longDraw).length <= 2000 && longDraw.allowedMentions.parse.length === 0 && longDraw.allowedMentions.users.length === 50, "legacy long prizes and 50 winners fit Discord limits and only winners may be pinged");
	await Model.create({ guildId: "guild-1", channelId: "chan-1", messageId: "projection-retry", prize: "Projection retry", hostId: "host-1", endsAt: new Date(Date.now() - 1), entrants: ["retry-winner"] });
	const updateEntries = entryModel.updateMany;
	entryModel.updateMany = async (query, ...args) => {
		if (query.giveawayId === "projection-retry") throw new Error("entry storage unavailable");
		return updateEntries(query, ...args);
	};
	await sweep();
	entryModel.updateMany = updateEntries;
	const retryDraw = await Model.findOne({ messageId: "projection-retry" });
	assert(!retryDraw.ended && !retryDraw.drawing, "failed winner tracking does not finalize the giveaway or retain its claim");
	await sweep();
	assert((await Model.findOne({ messageId: "projection-retry" })).ended && announcements.filter((p) => text(p).includes("Projection retry")).length === 1, "cron retries a failed database phase without duplicate announcements");
	await ctx.hooks.emitHook("onPluginUnload", { pluginName: "adb-plugin-giveaways" });
	assert(stopped, "plugin unload stops the registered sweep");
	const collection = createMockCtx({ pluginName: "adb-plugin-giveaways" });
	collection.ctx.config.commandCollection = true;
	let collectionSchedules = 0;
	cron.schedule = () => { collectionSchedules++; return { stop() {} }; };
	try { await load(collection.ctx); } finally { cron.schedule = schedule; }
	assert(collection.registeredCommands.has("giveaway") && collectionSchedules === 0, "host command collection registers commands without starting a giveaway sweep");

	console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
	process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
	console.error("Harness crashed:", err);
	process.exit(1);
});
