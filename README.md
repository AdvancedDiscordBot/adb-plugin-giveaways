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

## License

This project is licensed under the **GNU Affero General Public License v3.0**. See the [LICENSE](LICENSE) file for details.

This repository follows the policies of the main ADB project.

- **Contribution Guidelines**: [CONTRIBUTING.md](https://github.com/AdvancedDiscordBot/Advanced-Discord-Bot/blob/main/CONTRIBUTING.md)
- **Code of Conduct**: [CODE_OF_CONDUCT.md](https://github.com/AdvancedDiscordBot/Advanced-Discord-Bot/blob/main/CODE_OF_CONDUCT.md)
- **Security Policy**: [SECURITY.md](https://github.com/AdvancedDiscordBot/Advanced-Discord-Bot/blob/main/SECURITY.md)
