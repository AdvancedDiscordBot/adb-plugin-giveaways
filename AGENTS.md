# AGENTS.md — hard rules for AI coding agents working on this plugin

You are in an **`adb-plugin-*` repository**. Good — this is the right place for
this work. Read [`AGENTS.md`](https://github.com/AdvancedDiscordBot/Advanced-Discord-Bot/blob/main/AGENTS.md)
in the core repo before writing code; it is the canonical version of these rules.
This file is the short local copy.

---

## 1. Do not touch the core repository

The `Advanced-Discord-Bot` repository is the **platform core**. You may clone it to
use as a local runtime host, but you must not create branches in it, commit into
it, or open pull requests against it — not for this plugin, not for a new feature,
not "just to fix a typo in the docs".

```bash
# allowed: cloning the core repo as a local runtime
git clone https://github.com/AdvancedDiscordBot/Advanced-Discord-Bot.git ../Advanced-Discord-Bot

# allowed: loading THIS plugin from local source
cd ../Advanced-Discord-Bot
npm install --no-save --package-lock=false ../<this-plugin-directory>
```

After that install, `git status` in the core repo **must be empty**. If it is not,
you changed something you were not supposed to change.

Do not add plugin code to the core repo's `plugins/` directory. Do not add a
`file:../…` dependency to the core repo's `package.json`. Do not add plugin
commands to the core repo's `commands/`.

---

## 2. Do not write code before the bot has been run and the plugin tested

If you have not seen this plugin running in a real bot, you are guessing. Before
your first edit, ask the user to:

1. create **their own** Discord application, bot token and test server — never
   borrow or reuse anyone else's, and never commit a token;
2. create **their own** MongoDB (Docker is fine);
3. clone the core repo, `npm install`, `cp .env.example .env`, fill it in;
4. install this plugin from the local directory (command above);
5. `npm run deploy && npm start`, and confirm the log line
   `[PluginManager] Loaded plugin <name>`;
6. **exercise the feature in the test server and tell you what happened.**

Then say: *"The bot is running and I've seen `<feature>` do X. Want me to try it
with `<change>` now?"* Full walkthrough:
[`LOCAL-SETUP.md`](https://github.com/AdvancedDiscordBot/Advanced-Discord-Bot/blob/main/LOCAL-SETUP.md).

Do not patch code to work around a symptom you have only seen in a log you have
not reproduced yourself.

---

## 3. Read the contract before you change anything

- `plugin.json` — the **declared** manifest. It is what the runtime enforces, not
  documentation. If your change needs a new capability, permission, or a newer
  `engines.core`, declare it here — an undeclared RPC call is denied at runtime.
- `README.md` — this plugin's own contract and the API surface it relies on.
- `test/local-harness.js` + `test/mock-ctx.js` — the existing tests. Run them
  before you change anything; they pass today.

### Both load modes must keep working

|  | isolated (`isolation: true`) | direct (`isolation: false` / `system:raw-client`) |
|---|---|---|
| runs in | a `worker_thread` | the main process |
| `ctx.client` | `null` | the real client |
| `ctx.discord` | present (RPC) | absent |
| Discord data | serialized plain values | real discord.js instances |

An npm-installed plugin runs isolated unless it declares
`capabilities.system: ["raw-client"]`, which is an owner-approved, deliberately
trust-granting escalation. Write for isolated mode by default.

### Easy ways to break this plugin

- Dereferencing `interaction.options.getUser()` / `getChannel()` without a null
  check. They return `null` for a departed member or deleted channel **even for a
  required option**, and the result is a generic "An error occurred" reply.
- `channel.messages.fetch({ limit })` returns messages **oldest → newest**. Reverse
  before taking a slice.
- Exceeding Discord limits: content 2000, embed description 4096, 25 fields, 6000
  total embed text, 100 messages per bulk delete, 3-second interaction window.
- Allowing `@everyone` / role pings in user-supplied text.
- Acting before `config.enabled === true`, including in independent cron callbacks.
- Changing a model schema and not restarting the bot (models are compiled at load).

---

## 4. Verify, then report honestly

```bash
npm install && npm test        # in this repo — offline, both load modes

# in the core-repo checkout, with this plugin installed from source
npm test
ADB_PLUGIN_WORKSPACE=<parent dir of this repo> \
ADB_INTEGRATION_MONGODB_URI=mongodb://127.0.0.1:32768/adb_verify_plugins \
npm run test:integration
```

- If you did not run it, do not describe the result. Say what you ran.
- Quote real output. Never invent a passing test run.
- The integration check has **known mock gaps** that produce false failures; see
  [`docs/VERIFICATION.md`](https://github.com/AdvancedDiscordBot/Advanced-Discord-Bot/blob/main/docs/VERIFICATION.md#known-limitations-of-the-integration-check).
  If it fails with a stack ending in the harness rather than in this plugin, that
  is a mock gap — say so instead of "fixing" the plugin.
- Passing tests are not proof of working behaviour on a real server. Say which
  parts you verified and which you did not.

---

## 5. Secrets

Never commit `.env`, tokens, client ids, OAuth secrets, session secrets or
database connection strings. Never point this plugin at production infrastructure
or a shared Discord application. Disposable test databases must be loopback with a
database name starting in `adb_verify_`.

---

## 6. Bugs and PRs

File bugs **in this repository**, with the `bug` label: version/commit, the
smallest reproduction you have, the actual log output, and expected behaviour. If
you cannot reproduce it, say so instead of speculating.

PRs: one change per PR, branch `fix|feat|docs|chore/<short>`, Conventional Commit
subject, and a body stating what changed, why, how you tested it, and what you
could not test. Bump `version` in `plugin.json`. Ask before pushing to `main`.

Ask before you proceed if: the fix would require changing the plugin API, the
manifest format or the capability model; the change is arguably a core change
rather than a plugin change; or you need a token, database or network access you
do not have.

Full reference: [`AGENTS.md`](https://github.com/AdvancedDiscordBot/Advanced-Discord-Bot/blob/main/AGENTS.md)
· [`CREATE-PLUGIN.md`](https://github.com/AdvancedDiscordBot/Advanced-Discord-Bot/blob/main/CREATE-PLUGIN.md)
· [`adb-plugin-template`](https://github.com/AdvancedDiscordBot/adb-plugin-template)