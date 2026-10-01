# adb-plugin-giveaways

Host and manage giveaways in your Discord server.

## Commands

- `/giveaway start <prize> [duration] [winners] [role]` — Start a giveaway
- `/giveaway end <message_id>` — End a giveaway early
- `/giveaway reroll <message_id>` — Reroll winners
- `/giveaway list` — Show active giveaways

Users enter by clicking the 🎉 button on the giveaway embed. Winners are auto-picked when time runs up.

## Config

| Key | Default | Description |
|-----|---------|-------------|
| `defaultDuration` | `1h` | Default duration string |
| `maxWinners` | 10 | Max winners per giveaway |

Settings are read from the dashboard's plugin-config store when starting a
giveaway. Prizes are limited to 256 characters and winners to the configured
maximum (at most 50). Expired giveaways reject entries even before the next sweep.

Manual ends and scheduled ends share the same draw and announcement path.
Concurrent draws use stored `drawing` and `drawVersion` guards; member projections
are serialized with entry changes within a process, not across multiple processes.
A database-phase failure leaves an unfinished draw retryable. A process crash can
leave a claim, and a Discord delivery failure after finalization is not retried
automatically. Check the saved winners and Discord messages before manually
reconciling such records. Database writes and Discord delivery are not transactional.

## License

This project is licensed under the **GNU Affero General Public License v3.0**. See the [LICENSE](LICENSE) file for details.

This repository follows the policies of the main ADB project.

- **Contribution Guidelines**: [CONTRIBUTING.md](https://github.com/AdvancedDiscordBot/Advanced-Discord-Bot/blob/main/CONTRIBUTING.md)
- **Code of Conduct**: [CODE_OF_CONDUCT.md](https://github.com/AdvancedDiscordBot/Advanced-Discord-Bot/blob/main/CODE_OF_CONDUCT.md)
- **Security Policy**: [SECURITY.md](https://github.com/AdvancedDiscordBot/Advanced-Discord-Bot/blob/main/SECURITY.md)
