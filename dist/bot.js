"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const discord_js_1 = require("discord.js");
const openai_1 = __importDefault(require("openai"));
// Initialize Discord Client
const client = new discord_js_1.Client({ intents: ["Guilds", "GuildMessages", "MessageContent", "DirectMessages"] });
// Initialize OpenAI instance
const openai = new openai_1.default({
    apiKey: "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" // Replace with your actual OpenAI API key
});
client.once('ready', () => {
    console.log('Bot is online!');
});
client.on('messageCreate', async (message) => {
    if (!message.content.trim()) {
        console.log('Ignoring empty message or non-textual event.');
        return;
    }
    console.log(`Processing message: ${message.content}`);
    if (message.content.startsWith('!ping')) {
        message.channel.send('Pong!');
    }
    if (message.content.startsWith('!ask')) {
        const query = message.content.replace('!ask ', '');
        try {
            const completion = await openai.completions.create({
                model: "text-davinci-002",
                prompt: query,
                max_tokens: 50
            });
            message.channel.send(completion.choices[0].text);
        }
        catch (error) {
            console.error('An error occurred while querying OpenAI:', error);
        }
    }
});
/*client.on('messageCreate', message => {
    if (!message.content.trim()) {
      console.log('Ignoring empty message or non-textual event.');
      return;
    }
    
    console.log(`Processing message: ${message.content}`);
  
    if (message.content.startsWith('!ping')) {
      message.channel.send('Pong!');
    }
  });*/
// For debugging: log all received packets
//client.on('raw', packet => {
//    console.log(`Received packet: ${JSON.stringify(packet, null, 2)}`);
//  });
// Replace YOUR_BOT_TOKEN with your actual bot token
client.login('MTE2NjEwMDMzMzI1MzExMTk4OQ.Gl1Y3T.Bd6AT0uKm9CvxiHSMDuSVR2X3-XkAFGg5Aw4OY');
