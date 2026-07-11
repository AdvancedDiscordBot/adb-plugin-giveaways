const cron = require("node-cron");
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require("discord.js");
const { createGiveawayCommand, pickWinners } = require("./commands/giveaway");
const giveawaySchema = require("./models/giveaway");

async function load(ctx) {
	const GiveawayModel = ctx.defineModel("giveaway", giveawaySchema);

	ctx.registerCommand(createGiveawayCommand(GiveawayModel));

	// Button interaction handler for entering giveaways
	ctx.registerEvent("interactionCreate", async (interaction, client) => {
		if (!interaction.isButton() || interaction.customId !== "giveaway_enter") return;

		const giveaway = await GiveawayModel.findOne({
			guildId: interaction.guildId,
			messageId: interaction.message.id,
			ended: false,
		});
		if (!giveaway) {
			return interaction.reply({ content: "This giveaway is over.", ephemeral: true });
		}

		// Role check
		if (giveaway.requiredRole) {
			const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
			if (!member || !member.roles.cache.has(giveaway.requiredRole)) {
				return interaction.reply({
					content: `You need the <@&${giveaway.requiredRole}> role to enter.`,
					ephemeral: true,
				});
			}
		}

		// Account age check (disabled by default)
		if (giveaway.minAccountAge > 0) {
			const age = (Date.now() - interaction.user.createdAt.getTime()) / 86400000;
			if (age < giveaway.minAccountAge) {
				return interaction.reply({
					content: `Your account must be at least ${giveaway.minAccountAge} days old.`,
					ephemeral: true,
				});
			}
		}

		if (giveaway.entrants.includes(interaction.user.id)) {
			giveaway.entrants = giveaway.entrants.filter((id) => id !== interaction.user.id);
			await giveaway.save();
			return interaction.reply({ content: "You left the giveaway.", ephemeral: true });
		}

		giveaway.entrants.push(interaction.user.id);
		await giveaway.save();

		await interaction.reply({ content: "You entered the giveaway! 🎉", ephemeral: true });
	});

	// Check every 30s for ended giveaways
	const task = cron.schedule("*/30 * * * * *", async () => {
		const due = await GiveawayModel.find({
			ended: false,
			endsAt: { $lte: new Date() },
		}).limit(20);

		for (const giveaway of due) {
			try {
				await pickWinners(giveaway, ctx.client);
				await giveaway.save();

				const channel = await ctx.client.channels.fetch(giveaway.channelId).catch(() => null);
				if (!channel) continue;

				const msg = await channel.messages.fetch(giveaway.messageId).catch(() => null);

				const winText =
					giveaway.winners.length > 0
						? `Congratulations ${giveaway.winners.map((id) => `<@${id}>`).join(", ")}! You won **${giveaway.prize}**!`
						: "No eligible entrants.";

				// Edit the original message
				if (msg) {
					const endedEmbed = EmbedBuilder.from(msg.embeds[0] || {})
						.setColor(0x57f287)
						.setFooter({ text: "Giveaway ended" });
					const disabledRow = new ActionRowBuilder().addComponents(
						new ButtonBuilder()
							.setCustomId("giveaway_enter_disabled")
							.setLabel("🎉 Ended")
							.setStyle(ButtonStyle.Secondary)
							.setDisabled(true)
					);
					await msg.edit({ embeds: [endedEmbed], components: [disabledRow] }).catch(() => {});
				}

				await channel.send(winText);
				ctx.logger.info(`Giveaway "${giveaway.prize}" ended with ${giveaway.winners.length} winner(s)`);
			} catch (error) {
				ctx.logger.error(`Failed to end giveaway ${giveaway._id}`, error);
			}
		}
	});

	ctx.hooks.on("onPluginUnload", async ({ pluginName }) => {
		if (pluginName === "adb-plugin-giveaways") task.stop();
	});

	ctx.logger.info("Giveaways plugin loaded");
}

module.exports = { load };
