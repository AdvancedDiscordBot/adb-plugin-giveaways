const { Schema } = require("mongoose");

module.exports = new Schema({
	guildId: { type: String, required: true, index: true },
	channelId: { type: String, required: true },
	messageId: { type: String, required: true, unique: true, index: true },
	prize: { type: String, required: true },
	winnerCount: { type: Number, required: true, default: 1 },
	endsAt: { type: Date, required: true, index: true },
	ended: { type: Boolean, default: false },
	hostId: { type: String, required: true },
	entrants: [{ type: String }], // user IDs
	winners: [{ type: String }],
	requiredRole: { type: String, default: null },
	minAccountAge: { type: Number, default: 0 }, // in days
	createdAt: { type: Date, default: Date.now },
});
