const cron = require("node-cron");
const { createGiveawayCommand, finishGiveaway, withGiveaway } = require("./commands/giveaway");
const giveawaySchema = require("./models/giveaway");
const entrySchema = require("./models/entry");

async function load(ctx) {
	const GiveawayModel = ctx.defineModel("giveaway", giveawaySchema);
	const EntryModel = ctx.defineModel("entry", entrySchema);
	ctx.registerCommand(createGiveawayCommand(GiveawayModel, EntryModel, { db: ctx.db, logger: ctx.logger }));
	if (ctx.config.commandCollection) return;

	ctx.registerEvent("interactionCreate", async (interaction) => {
		if (!interaction.isButton() || interaction.customId !== "giveaway_enter") return;
		await interaction.deferReply({ ephemeral: true });
		const guildId = interaction.guildId;
		const messageId = interaction.message.id;
		try {
			await withGiveaway(`${guildId}:${messageId}`, async () => {
				const query = { guildId, messageId, ended: false, drawing: { $ne: true } };
				const giveaway = await GiveawayModel.findOne({ ...query, endsAt: { $gt: new Date() } });
				if (!giveaway) return interaction.editReply({ content: "This giveaway is over or a draw is in progress." });
				const userId = interaction.user.id;
				const leaving = giveaway.entrants.includes(userId);
				if (!leaving && giveaway.requiredRole) {
					const member = await interaction.guild.members.fetch(userId).catch(() => null);
					if (!member || !member.roles.cache.has(giveaway.requiredRole)) {
						return interaction.editReply({ content: `You need the <@&${giveaway.requiredRole}> role to enter.`, allowedMentions: { parse: [] } });
					}
				}
				if (!leaving && giveaway.minAccountAge > 0) {
					const age = (Date.now() - interaction.user.createdAt.getTime()) / 86400000;
					if (age < giveaway.minAccountAge) {
						return interaction.editReply({ content: `Your account must be at least ${giveaway.minAccountAge} days old.` });
					}
				}

				// Recheck expiry after any slow Discord lookups, and update arrays atomically.
				const updated = await GiveawayModel.findOneAndUpdate(
					{ ...query, endsAt: { $gt: new Date() }, entrants: leaving ? userId : { $ne: userId } },
					leaving ? { $pull: { entrants: userId } } : { $addToSet: { entrants: userId } },
					{ new: true }
				);
				if (!updated) return interaction.editReply({ content: "This giveaway or your entry has changed. Check its status before trying again." });
				const entryQuery = { guildId, userId, giveawayId: messageId };
				if (leaving) {
					await EntryModel.deleteMany(entryQuery);
				} else {
					await EntryModel.updateOne(entryQuery, {
						$setOnInsert: { prize: giveaway.prize, endsAt: giveaway.endsAt },
					}, { upsert: true });
				}
				return interaction.editReply({ content: leaving ? "You left the giveaway." : "You entered the giveaway!" });
			});
		} catch (error) {
			ctx.logger.error("Failed to update giveaway entry", error);
			await interaction.editReply({ content: "Unable to finish updating your entry. Check its status before retrying." });
		}
	});

	const task = cron.schedule("*/30 * * * * *", async () => {
		try {
			const due = await GiveawayModel.find({ ended: false, drawing: { $ne: true }, endsAt: { $lte: new Date() } }).limit(20);
			for (const giveaway of due) {
				try {
					await finishGiveaway(GiveawayModel, EntryModel, giveaway, ctx.client, { logger: ctx.logger });
				} catch (error) {
					ctx.logger.error(`Failed to end giveaway ${giveaway._id}`, error);
				}
			}
		} catch (error) {
			ctx.logger.error("Failed to scan due giveaways", error);
		}
	});
	ctx.hooks.on("onPluginUnload", async ({ pluginName }) => {
		if (pluginName === "adb-plugin-giveaways") task.stop();
	});
	ctx.logger.info("Giveaways plugin loaded");
}

module.exports = { load };
