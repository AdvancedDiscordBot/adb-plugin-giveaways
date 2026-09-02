const { Schema } = require("mongoose");

// Per-user projection of GiveawayModel.entrants for the member-scope
// /me/entries page. The giveaway doc's entrants array stays the source of
// truth; these docs mirror joins/leaves/wins so the platform's {guildId,
// userId} member query has something to serve.
module.exports = new Schema({
	guildId: { type: String, required: true, index: true },
	userId: { type: String, required: true, index: true },
	giveawayId: { type: String, required: true, index: true },
	prize: { type: String, required: true },
	endsAt: { type: Date, required: true },
	won: { type: Boolean, default: false },
	createdAt: { type: Date, default: Date.now },
});
