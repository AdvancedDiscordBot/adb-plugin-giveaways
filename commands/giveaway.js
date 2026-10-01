const {
	EmbedBuilder,
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
} = require("discord.js");

function parseDuration(str) {
	if (typeof str !== "string") return null;
	const match = str.match(/^(\d+)(s|m|h|d)$/);
	if (!match) return null;
	const val = parseInt(match[1]);
	const unit = match[2];
	const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
	const duration = val * multipliers[unit];
	return Number.isSafeInteger(duration) ? duration : null;
}

const pending = new Map();
const drawing = new Set();

// Serialize the source record with its per-member projections in this process.
async function withGiveaway(key, work) {
	const task = (pending.get(key) || Promise.resolve()).catch(() => {}).then(work);
	pending.set(key, task);
	try {
		return await task;
	} finally {
		if (pending.get(key) === task) pending.delete(key);
	}
}

// DM each winner that they won. A user with DMs closed just throws — swallow
// it per-winner so one closed DM doesn't abort the rest.
async function dmWinners(giveaway, interaction) {
	for (const winnerId of giveaway.winners || []) {
		try {
			const user = await interaction.client.users.fetch(winnerId);
			await user.send(
				`🎉 Congratulations! You won **${giveaway.prize.slice(0, 256)}** in **${interaction.guild?.name || "the server"}**!`
			);
		} catch {
			// DMs disabled / user unreachable — ignore.
		}
	}
}

async function finishGiveaway(GiveawayModel, EntryModel, giveaway, client, { reroll = false, endNow = false, guild, logger = console } = {}) {
	const key = `${giveaway.guildId}:${giveaway.messageId}`;
	if (drawing.has(key)) return null;
	drawing.add(key);
	try {
		return await withGiveaway(key, async () => {
			const claimed = await GiveawayModel.findOneAndUpdate(
				{
					_id: giveaway._id, ended: reroll, drawing: { $ne: true },
					drawVersion: giveaway.drawVersion || { $in: [null, 0] },
				},
				{ $set: { drawing: true }, $inc: { drawVersion: 1 } },
				{ new: true }
			);
			if (!claimed) return null;
			try {
				if (endNow) claimed.endsAt = new Date();
				pickWinners(claimed, client);
				if (EntryModel) {
					const query = { guildId: claimed.guildId, giveawayId: claimed.messageId };
					await EntryModel.updateMany(query, { $set: { won: false, endsAt: claimed.endsAt } });
					for (const userId of claimed.winners) {
						await EntryModel.updateOne({ ...query, userId }, {
							$set: { won: true },
							$setOnInsert: { prize: claimed.prize, endsAt: claimed.endsAt },
						}, { upsert: true });
					}
				}
				await GiveawayModel.updateOne({ _id: claimed._id }, {
					$set: { ended: true, winners: claimed.winners, endsAt: claimed.endsAt },
				});

				const channel = await client.channels.fetch(claimed.channelId);
				if (!channel) throw new Error("Giveaway channel is unavailable; the draw has been saved");
				const message = await channel.messages.fetch(claimed.messageId).catch(() => null);
				if (message) {
					const embed = EmbedBuilder.from(message.embeds[0] || {}).setColor(0x57f287).setFooter({ text: "Giveaway ended" });
					const row = new ActionRowBuilder().addComponents(
						new ButtonBuilder().setCustomId("giveaway_enter_disabled").setLabel("Ended").setStyle(ButtonStyle.Secondary).setDisabled(true)
					);
					await message.edit({ embeds: [embed], components: [row] }).catch((error) => logger.warn("Failed to disable giveaway message", error));
				}
				const winners = claimed.winners.map((id) => `<@${id}>`).join(", ");
				const prize = claimed.prize.slice(0, 256);
				const content = winners
					? reroll ? `Reroll! New winner(s) for **${prize}**: ${winners}` : `Congratulations ${winners}! You won **${prize}**!`
					: `Giveaway **${prize}** ended. No eligible entrants.`;
				await channel.send({ content, allowedMentions: { parse: [], users: claimed.winners } });
				await dmWinners(claimed, { client, guild: guild || client.guilds?.cache.get(claimed.guildId) });
				return claimed;
			} finally {
				await GiveawayModel.updateOne({ _id: claimed._id }, { $set: { drawing: false } });
			}
		});
	} finally {
		drawing.delete(key);
	}
}

function createGiveawayCommand(GiveawayModel, EntryModel, { defaultDuration = "1h", maxWinners = 10, db, logger = console } = {}) {
	return {
		data: {
			name: "giveaway",
			description: "Host and manage giveaways",
			options: [
				{
					name: "start",
					description: "Start a new giveaway",
					type: 1,
					options: [
						{
							name: "prize",
							type: 3,
							description: "The prize to give away",
							required: true,
							maxLength: 256,
						},
						{
							name: "duration",
							type: 3,
							description: `Duration e.g. 30m, 2h, 1d (default: ${defaultDuration})`,
						},
						{
							name: "winners",
							type: 4,
							description: "Number of winners (default: 1)",
							minValue: 1,
							maxValue: 50,
						},
						{
							name: "role",
							type: 8, // ROLE
							description: "Required role to enter",
						},
					],
				},
				{
					name: "end",
					description: "End a giveaway early and pick winners",
					type: 1,
					options: [
						{
							name: "message_id",
							type: 3,
							description: "Message ID of the giveaway",
							required: true,
						},
					],
				},
				{
					name: "reroll",
					description: "Reroll winners for a giveaway",
					type: 1,
					options: [
						{
							name: "message_id",
							type: 3,
							description: "Message ID of the giveaway",
							required: true,
						},
					],
				},
				{
					name: "list",
					description: "List active giveaways in this server",
					type: 1,
				},
				{
					name: "cancel",
					description: "Cancel an active giveaway (no winners drawn)",
					type: 1,
					options: [
						{
							name: "message_id",
							type: 3,
							description: "Message ID of the giveaway to cancel",
							required: true,
						},
					],
				},
			],
		},
		async execute(interaction) {
			const sub = interaction.options.getSubcommand();
			const guildId = interaction.guildId;
			await interaction.deferReply({ ephemeral: sub !== "start" });
			try {
				if (sub === "start") {
					const config = db ? (await db.getPluginConfig(guildId, "adb-plugin-giveaways"))?.data || {} : {};
					const prize = interaction.options.getString("prize");
					const durationInput = interaction.options.getString("duration") || config.defaultDuration || defaultDuration;
					const winnerCount = interaction.options.getInteger("winners") ?? 1;
					const requiredRole = interaction.options.getRole("role");
					const configuredMax = config.maxWinners ?? maxWinners;
					const winnerLimit = Number.isInteger(configuredMax) && configuredMax >= 1 && configuredMax <= 50 ? configuredMax : 10;
					if (!prize?.trim() || prize.length > 256) return interaction.editReply({ content: "Prize must contain 1-256 characters." });
					if (!Number.isInteger(winnerCount) || winnerCount < 1 || winnerCount > winnerLimit) {
						return interaction.editReply({ content: `Choose between 1 and ${winnerLimit} winners.` });
					}

					const ms = parseDuration(durationInput);
					if (!ms || ms < 10000) {
						return interaction.editReply({ content: "Invalid duration. Use e.g. `30m`, `2h`, `1d` (min 10s)." });
					}
					if (ms > 86400000 * 30) return interaction.editReply({ content: "Duration max 30 days." });
					const endsAt = new Date(Date.now() + ms);
					const embed = new EmbedBuilder()
						.setColor(0xed4245)
						.setTitle("🎉 Giveaway!")
						.setDescription(
							`**Prize:** ${prize}\n**Ends:** <t:${Math.floor(endsAt.getTime() / 1000)}:R>\n**Winners:** ${winnerCount}\n**Hosted by:** ${interaction.user}`
						)
						.setFooter({ text: "Click the button to enter!" });
					if (requiredRole) embed.addFields({ name: "Required Role", value: `${requiredRole}`, inline: true });
					const row = new ActionRowBuilder().addComponents(
						new ButtonBuilder().setCustomId("giveaway_enter").setLabel("🎉 Enter").setStyle(ButtonStyle.Primary)
					);
					const msg = await interaction.fetchReply();
					await GiveawayModel.create({
						guildId,
						channelId: interaction.channelId,
						messageId: msg.id,
						prize,
						winnerCount,
						endsAt,
						hostId: interaction.user.id,
						entrants: [],
						requiredRole: requiredRole?.id || null,
					});
					try {
						return await interaction.editReply({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });
					} catch (error) {
						await GiveawayModel.deleteOne({ guildId, messageId: msg.id });
						throw error;
					}
				}

				if (sub === "end") {
					const messageId = interaction.options.getString("message_id");
					const giveaway = await GiveawayModel.findOne({ guildId, messageId });
					if (!giveaway) return interaction.editReply({ content: "Giveaway not found." });
					if (giveaway.ended) return interaction.editReply({ content: "Giveaway already ended." });
					const ended = await finishGiveaway(GiveawayModel, EntryModel, giveaway, interaction.client, { endNow: true, guild: interaction.guild, logger });
					return interaction.editReply({ content: ended ? "Giveaway ended early." : "Giveaway already ended or a draw is in progress." });
				}

				if (sub === "reroll") {
					const messageId = interaction.options.getString("message_id");
					const giveaway = await GiveawayModel.findOne({ guildId, messageId });
					if (!giveaway) return interaction.editReply({ content: "Giveaway not found." });
					if (!giveaway.ended) return interaction.editReply({ content: "Giveaway hasn't ended yet." });
					const eligible = giveaway.entrants.filter((id) => id !== interaction.client.user.id);
					if (eligible.length === 0) return interaction.editReply({ content: "No eligible entrants." });
					const result = await finishGiveaway(GiveawayModel, EntryModel, giveaway, interaction.client, { reroll: true, guild: interaction.guild, logger });
					return interaction.editReply({ content: result ? `Rerolled! New winners: ${result.winners.map((id) => `<@${id}>`).join(", ")}` : "A draw is already in progress or has just changed.", allowedMentions: { parse: [] } });
				}

				if (sub === "list") {
					const active = await GiveawayModel.find({ guildId, ended: false }).sort({ endsAt: 1 }).limit(20);
					if (active.length === 0) return interaction.editReply({ content: "No active giveaways." });
					const lines = active.map(
						(g) => `**${g.prize.slice(0, 256)}** — <t:${Math.floor(g.endsAt.getTime() / 1000)}:R> — ${g.entrants.length} entrant(s) — [Jump](https://discord.com/channels/${g.guildId}/${g.channelId}/${g.messageId})`
					);
					let content = "";
					for (const line of lines) {
						if (content.length + line.length > 1850) break;
						content += `${line}\n`;
					}
					return interaction.editReply({ content: content + "Showing the earliest active giveaways that fit in this message.", allowedMentions: { parse: [] } });
				}

				if (sub === "cancel") {
					const messageId = interaction.options.getString("message_id");
					return await withGiveaway(`${guildId}:${messageId}`, async () => {
						const giveaway = await GiveawayModel.findOneAndUpdate(
							{ guildId, messageId, ended: false, drawing: { $ne: true } },
							{ $set: { drawing: true } }, { new: true }
						);
						if (!giveaway) {
							return interaction.editReply({ content: "Giveaway not found, already ended, or a draw is in progress." });
						}
						try {
							if (EntryModel) await EntryModel.deleteMany({ guildId, giveawayId: messageId });
							await GiveawayModel.deleteOne({ _id: giveaway._id });
							const channel = await interaction.client.channels.fetch(giveaway.channelId).catch(() => null);
							if (channel) {
								const msg = await channel.messages.fetch(giveaway.messageId).catch(() => null);
								if (msg) await msg.delete().catch(() => {});
							}
							return interaction.editReply({ content: "Giveaway cancelled." });
						} finally {
							await GiveawayModel.updateOne({ _id: giveaway._id }, { $set: { drawing: false } });
						}
					});
				}
			} catch (error) {
				logger.error("Failed to manage giveaway", error);
				return interaction.editReply({ content: "Unable to complete the giveaway operation. The draw may already be saved; check its status before retrying.", embeds: [], components: [] });
			}
		},
	};
}

function pickWinners(giveaway, client) {
	// Mark ended first, unconditionally: an empty giveaway is still over. If we
	// only set this after drawing, a giveaway with zero entrants stays ended:false
	// and the 30s cron (and manual /giveaway end) re-processes it forever.
	giveaway.ended = true;
	giveaway.winners = [];

	const eligible = [...new Set(giveaway.entrants)].filter((id) => id !== client.user.id);
	if (eligible.length === 0) return;

	const winners = [];
	const pool = [...eligible];
	// pool shrinks via splice, so compute the count once up front.
	const drawCount = Math.min(Math.max(0, Math.floor(giveaway.winnerCount)), 50, pool.length);
	for (let i = 0; i < drawCount; i++) {
		const idx = Math.floor(Math.random() * pool.length);
		winners.push(pool.splice(idx, 1)[0]);
	}
	giveaway.winners = winners;
}

module.exports = { createGiveawayCommand, pickWinners, finishGiveaway, withGiveaway };
