"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// index.ts
const discord_js_1 = require("discord.js");
/**
 * @type {Client}
 */
const client = new discord_js_1.Client({ intents: ["Guilds", "GuildMessages", "MessageContent", "DirectMessages"] });
client.once('ready', () => {
    console.log('Ready!');
});
//test the bot.
client.on('messageCreate', async (message) => {
    if (!message.content.trim()) {
        console.log('Ignoring empty message or non-textual event.');
        return;
    }
    console.log(`Processing message: ${message.content}`);
    if (message.content.startsWith('!ping')) {
        message.channel.send('Pong!');
    }
});
// Use the bot token from the environment variables
client.login(process.env.DISCORD_BOT_TOKEN);
