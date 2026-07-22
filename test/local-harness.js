"use strict";

/**
 * local-harness.js — offline smoke test for adb-plugin-giveaways.
 * Run: npm test   (node test/local-harness.js). No bot / no Mongo.
 *
 * load() starts a node-cron job that keeps the event loop alive; the final
 * process.exit() guarantees the harness terminates regardless.
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
const fakeClient = {
	user: { id: "mock-bot-id" },
	users: {
		fetch: async (id) => ({ id, send: async (msg) => dmLog.push({ id, msg }) }),
	},
	channels: {
		fetch: async () => ({
			send: async () => {},
			messages: { fetch: async () => ({ delete: async () => {} }) },
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
		reply: async (payload) => {
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
	const { ctx, registeredCommands, registeredEvents } = createMockCtx({
		pluginName: "adb-plugin-giveaways",
	});
	await load(ctx); // must not throw; starts cron (killed by process.exit)
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

	// --- factory options ----------------------------------------------
	const custom = createGiveawayCommand({}, { defaultDuration: "2h", maxWinners: 3 });
	assert(custom.data.name === "giveaway", "factory returns a giveaway command");

	console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
	process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
	console.error("Harness crashed:", err);
	process.exit(1);
});
