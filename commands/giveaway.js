const {
	EmbedBuilder,
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
} = require("discord.js");

function parseDuration(str) {
	const match = str.match(/^(\d+)(s|m|h|d)$/);
	if (!match) return null;
	const val = parseInt(match[1]);
	const unit = match[2];
	const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
	return val * (multipliers[unit] || 0);
}

function createGiveawayCommand(GiveawayModel, { defaultDuration = "1h", maxWinners = 10 } = {}) {
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
							maxValue: maxWinners,
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
			],
		},
		async execute(interaction) {
			const sub = interaction.options.getSubcommand();
			const guildId = interaction.guildId;

			if (sub === "start") {
				const prize = interaction.options.getString("prize");
				const durationInput = interaction.options.getString("duration") || defaultDuration;
				const winnerCount = interaction.options.getInteger("winners") || 1;
				const requiredRole = interaction.options.getRole("role");

				const ms = parseDuration(durationInput);
				if (!ms || ms < 10000) {
					return interaction.reply({
						content: "Invalid duration. Use e.g. `30m`, `2h`, `1d` (min 10s).",
						ephemeral: true,
					});
				}
				if (ms > 86400000 * 30) {
					return interaction.reply({ content: "Duration max 30 days.", ephemeral: true });
				}

				const endsAt = new Date(Date.now() + ms);

				const embed = new EmbedBuilder()
					.setColor(0xed4245)
					.setTitle("🎉 Giveaway!")
					.setDescription(
						`**Prize:** ${prize}\n**Ends:** <t:${Math.floor(endsAt.getTime() / 1000)}:R>\n**Winners:** ${winnerCount}\n**Hosted by:** ${interaction.user}`
					)
					.setFooter({ text: "Click the button to enter!" });

				if (requiredRole) {
					embed.addFields({ name: "Required Role", value: `${requiredRole}`, inline: true });
				}

				const row = new ActionRowBuilder().addComponents(
					new ButtonBuilder()
						.setCustomId("giveaway_enter")
						.setLabel("🎉 Enter")
						.setStyle(ButtonStyle.Primary)
				);

				const msg = await interaction.reply({
					embeds: [embed],
					components: [row],
					fetchReply: true,
				});

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

				return;
			}

			if (sub === "end") {
				const messageId = interaction.options.getString("message_id");
				const giveaway = await GiveawayModel.findOne({ guildId, messageId });
				if (!giveaway) {
					return interaction.reply({ content: "Giveaway not found.", ephemeral: true });
				}
				if (giveaway.ended) {
					return interaction.reply({ content: "Giveaway already ended.", ephemeral: true });
				}

				giveaway.endsAt = new Date();
				await pickWinners(giveaway, interaction.client);
				await giveaway.save();

				return interaction.reply({ content: "Giveaway ended early.", ephemeral: true });
			}

			if (sub === "reroll") {
				const messageId = interaction.options.getString("message_id");
				const giveaway = await GiveawayModel.findOne({ guildId, messageId });
				if (!giveaway) {
					return interaction.reply({ content: "Giveaway not found.", ephemeral: true });
				}
				if (!giveaway.ended) {
					return interaction.reply({ content: "Giveaway hasn't ended yet.", ephemeral: true });
				}

				const eligible = giveaway.entrants.filter((id) => id !== interaction.client.user.id);
				if (eligible.length === 0) {
					return interaction.reply({ content: "No eligible entrants.", ephemeral: true });
				}

				const newWinners = [];
				const pool = [...eligible];
				for (let i = 0; i < Math.min(giveaway.winnerCount, pool.length); i++) {
					const idx = Math.floor(Math.random() * pool.length);
					newWinners.push(pool.splice(idx, 1)[0]);
				}
				giveaway.winners = newWinners;
				await giveaway.save();

				const channel = await interaction.client.channels.fetch(giveaway.channelId).catch(() => null);
				if (channel) {
					await channel.send(
						`🎉 **Reroll!** New winner(s) for **${giveaway.prize}**: ${newWinners.map((id) => `<@${id}>`).join(", ")}`
					);
				}

				return interaction.reply({
					content: `Rerolled! New winners: ${newWinners.map((id) => `<@${id}>`).join(", ")}`,
					ephemeral: true,
				});
			}

			if (sub === "list") {
				const active = await GiveawayModel.find({ guildId, ended: false }).sort({ endsAt: 1 });
				if (active.length === 0) {
					return interaction.reply({ content: "No active giveaways.", ephemeral: true });
				}
				const lines = active.map(
					(g) =>
						`**${g.prize}** — <t:${Math.floor(g.endsAt.getTime() / 1000)}:R> — ${g.entrants.length} entrant(s) — [Jump](${g.messageId ? `https://discord.com/channels/${g.guildId}/${g.channelId}/${g.messageId}` : "#"})`
				);
				return interaction.reply({ content: lines.join("\n"), ephemeral: true });
			}
		},
	};
}

async function pickWinners(giveaway, client) {
	const eligible = giveaway.entrants.filter((id) => id !== client.user.id);
	if (eligible.length === 0) return;

	const winners = [];
	const pool = [...eligible];
	for (let i = 0; i < Math.min(giveaway.winnerCount, pool.length); i++) {
		const idx = Math.floor(Math.random() * pool.length);
		winners.push(pool.splice(idx, 1)[0]);
	}
	giveaway.winners = winners;
	giveaway.ended = true;
}

module.exports = { createGiveawayCommand, pickWinners };
