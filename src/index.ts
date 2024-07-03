// index.ts
import dotenv from 'dotenv';
dotenv.config();
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder, Interaction, Message, SlashCommandBuilder, ChannelType, REST, Routes, GuildMember, InteractionType, TextChannel, ThreadChannel, ChatInputCommandInteraction, ButtonInteraction, CommandInteraction, Guild, DiscordAPIError } from 'discord.js';
import { getDb } from './db';
import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
let ADMIN_USER: string
if (process.env.ADMIN_USER_ID) {
  ADMIN_USER = process.env.ADMIN_USER_ID
} else {
  ADMIN_USER = '248918075922055168'
}
let botIsLoggedIn = false;

if (typeof process.env.DISCORD_BOT_TOKEN !== 'string') {
  console.error("No bot token found in environment variables. Please set DISCORD_BOT_TOKEN.");
  process.exit(1);
}
const botToken = process.env.DISCORD_BOT_TOKEN as string;


const client = new Client({ intents: ["Guilds", "GuildMessages", "GuildMembers", "MessageContent", "DirectMessages"] });
// This is the new slash command registration
const commands = [
  new SlashCommandBuilder()
    .setName('listmembers')
    .setDescription('Lists all members in the guild!'),
  new SlashCommandBuilder()
    .setName('nominate')
    .setDescription('Nominate a user for role advancement.')
    .addUserOption(option => option.setName('user').setDescription('The user to nominate').setRequired(true)),
  new SlashCommandBuilder()
    .setName('getverified')
    .setDescription('Learn how to get verified.'),
  new SlashCommandBuilder()
    .setName('updatevote')
    .setDescription('Update the vote count in the current voting thread.'),
  new SlashCommandBuilder()
    .setName('listactivevotes')
    .setDescription('Lists all active voting threads.'),
].map(command => command.toJSON());

async function syncRoles(guild: Guild) {
  const db = await getDb(); // Your function to get a database connection
  const roles = await guild.roles.fetch();
  logger("Roles are being fetched")
  // Loop through roles and add/update each in the database
  roles.forEach(async (role) => {
    const existingRole = await db.get('SELECT role_id, role_name FROM roles WHERE role_id = ?', [role.id]);

    if (!existingRole || existingRole.role_name !== role.name) {
      await db.run(`
        INSERT INTO roles (role_id, role_name, guild_id)
        VALUES (?, ?, ?)
        ON CONFLICT(role_id)
        DO UPDATE SET role_name = EXCLUDED.role_name;
      `, [role.id, role.name, guild.id]);
    }
  });
}

// Helper function to split inserts into batches
const executeBatch = async (statement: string, inserts: any[], batchSize: number, variablesPerRow: number) => {
  const db = await getDb();
  logger('processing Database Batch')
  logger(`inserting ${inserts.length} records using ${statement}`)
  for (let i = 0; i < inserts.length; i += batchSize) {
    const batch = inserts.slice(i, i + batchSize);
    const values = batch.map(() => `(${new Array(variablesPerRow).fill('?').join(', ')})`).join(', ');
    await db.run(statement + values, batch.flat());
  }
};

async function getMemberRoles(member: GuildMember) {
  return Array.from(member.roles.cache.values())
}

async function syncMembers(guild: Guild) {
  const db = await getDb();
  const members = await guild.members.fetch();
  const roleCounts: { [key: string]: number } = {};
  // Collect all SQL statements in these arrays
  const memberInserts: any[] = [];
  const userRoleInserts: any[] = [];
  const scfTierRoles = ["SCF Verified", "SCF Pathfinder", "SCF Navigator", "SCF Pilot"];

  const memberPromises = members.map(async member => {
    console.log(`Member: ${member.user.tag} (${member.id})`)

    // Check if the member has more than one SCF role and fix it if necessary
    const currentRoles = member.roles.cache.filter(role => scfTierRoles.includes(role.name));
    if (currentRoles.size > 1 && guild.id === "897514728459468821") { // only do this for the developers server and not the test server.
      logger(`${member.user.tag} has more than one scf tier role in guild ${guild.name}`)
      await fixUserRoles(member);
    }

    const existingMember = await db.get('SELECT guild_id, username, discriminator FROM members WHERE member_id = ?', member.id);

    if (existingMember) {
      const currentGuildIds = existingMember.guild_id.split(',');
      if (!currentGuildIds.includes(guild.id)) {
        currentGuildIds.push(guild.id);
      }
      const updatedGuildIds = currentGuildIds.join(',');

      if (existingMember.username !== member.user.username || existingMember.discriminator !== member.user.discriminator || existingMember.guild_id !== updatedGuildIds) {
        // Collect member update statement
        memberInserts.push([
          member.id,
          member.user.username,
          member.user.discriminator,
          updatedGuildIds
        ]);
      }
    } else {
      // Collect member insert statement
      memberInserts.push([
        member.id,
        member.user.username,
        member.user.discriminator,
        guild.id
      ]);
    }

    const rolePromises = Array.from(member.roles.cache.values()).map(async role => {
      if (role.name.startsWith('SCF')) {
        if (!roleCounts[role.name]) {
          roleCounts[role.name] = 0;
        }
        roleCounts[role.name] += 1;
        console.log(`Incremented count for role: ${role.name}, new count: ${roleCounts[role.name]}`);
        const existingUserRole = await db.get('SELECT role_assigned_at FROM user_roles WHERE user_id = ? AND role_id = ? AND guild_id = ?', [member.id, role.id, guild.id]);

        if (!existingUserRole) {
          // Collect user role insert statement
          userRoleInserts.push([
            member.id,
            role.id,
            guild.id,
            new Date().toISOString() // Add the timestamp here
          ]);
        }
      }
    });
    await Promise.all(rolePromises);
  });
  await Promise.all(memberPromises);
  // Batch insert members
  if (memberInserts.length > 0) {
    const memberInsertStatement = 'INSERT OR REPLACE INTO members (member_id, username, discriminator, guild_id) VALUES ';
    const maxVariables = 999; // SQLite variable limit
    const batchSize = Math.floor(maxVariables / 4);// 4 variables per row
    await executeBatch(memberInsertStatement, memberInserts, batchSize, 4);
  }

  // Batch insert user roles
  if (userRoleInserts.length > 0) {
    const userRoleInsertStatement = 'INSERT INTO user_roles (user_id, role_id, guild_id, role_assigned_at) VALUES ';
    const maxVariables = 999; // SQLite variable limit
    const batchSize = Math.floor(maxVariables / 4);// 3 variables per row + CURRENT_TIMESTAMP
    await executeBatch(userRoleInsertStatement, userRoleInserts, batchSize, 4);
  }

  logger(`Processed roles, initial counts:`);
  logger(JSON.stringify(roleCounts));
}

const rest = new REST({ version: '10' }).setToken(botToken);
// Assuming 'voteCounts' is a Map where you track votes by thread ID.
const voteCounts: Map<string, Map<string, boolean>> = new Map();

client.once('ready', async () => {

  // Ensure the client user is not null
  if (!client.user) {
    console.error('Client is not ready, or user information is unavailable.');
    return;
  }
  botIsLoggedIn = true;
  const clientId = client.user.id as string; // You need to replace this with your actual client ID
  logger(`Logged in as ${client.user?.tag}! clientId is ${client.user?.id}!}`)

  const db = await getDb();

  const guilds = await client.guilds.fetch();

  for (const [guildId, partialGuild] of guilds) {
    const fullGuild = await client.guilds.fetch(guildId);

    let logmsg = `guild id: ${guildId}\n
    partial Guild: ${partialGuild.name} (${partialGuild.id})\n
    guildId: ${guildId}\n
    fullGuild: ${fullGuild.name} (${fullGuild.id})`;
    logger(logmsg);
    await syncRoles(fullGuild);

    //register and update commands:
    try {
      logger('Started refreshing application (/) commands.')

      await rest.put(
        Routes.applicationGuildCommands(clientId, fullGuild.id),
        { body: commands },
      );

      logger('Successfully reloaded application (/) commands.');
    } catch (error) {
      logger(`ERROR! ${error}`)
      console.error(error);
    }
    //write to the db
    await db.run('INSERT OR REPLACE INTO guilds (guild_id, guild_name) VALUES (?, ?)', fullGuild.id, fullGuild.name);

    // Fetch members for each guild
    const members = await fullGuild.members.fetch();
    logger(`Fetched ${members.size} members for guild ${fullGuild.name}`);
    await syncMembers(fullGuild);

    logger(`BOT IS Ready!`);
  }
});

// Express server setup
const app = express();
const PORT = process.env.BOT_API_PORT || 3939;

app.use(bodyParser.json());

app.post('/grantRole', async (req: Request, res: Response) => {
  console.log('Received an API request with body:', req.body);

  const { guildId, userId, roleName, auth } = req.body;

  if (!guildId || !userId || !roleName || !auth) {
    console.log('Missing required fields in request');
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const db = await getDb();

  // Simple authentication
  if (auth !== process.env.BOT_API_KEY) {
    console.log('Unauthorized attempt with auth:', auth);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const guild = await client.guilds.fetch(guildId);
    console.log('Fetched guild:', guild.name);

    let member;
    try {
      member = await guild.members.fetch(userId);
    } catch (error) {
      if (error instanceof DiscordAPIError && error.code === 10007) { // DiscordAPIError code for "Unknown Member"
        console.log(`User with ID ${userId} not found in guild ${guild.name}.`);
        return res.status(404).json({ error: 'User not found in the guild.' });
      } else {
        throw error;
      }
    }
    console.log('Fetched member:', member.user.tag);

    const existingRoles = await db.all('SELECT role_id FROM user_roles WHERE user_id = ?', [userId]);
    console.log('Existing roles in DB for member:', existingRoles);
    
    // Check if the user already has a higher role
    let higherRoles = ["SCF Navigator", "SCF Pilot"];
    if (roleName === "SCF Verified"){
      higherRoles = ["SCF Pathfinder", "SCF Navigator", "SCF Pilot"];
    }
    let higherRoleName = "";
    const hasHigherRole = member.roles.cache.some(role => {
      if (higherRoles.includes(role.name)) {
        higherRoleName = role.name;
        return true;
      }
      return false;
    });

    console.log(`User already hasHigherRole: ${higherRoleName}`);
    const thisRole = [roleName]
    const hasThisRole = member.roles.cache.some(role => thisRole.includes(role.name));
    if (hasThisRole) {
      console.log(`User ${member.user.tag} already has the ${roleName} role.`);
      return res.status(409).json({ error: `Conflict: User already has ${roleName} role.`, role: roleName });
    }
    if (hasHigherRole) {
      console.log(`User ${member.user.tag} already has a higher role: ${higherRoleName}`);
      return res.status(409).json({ error: 'Conflict: User already has a higher role.', role: higherRoleName });
    }

    const success = await updateUserRole(guild, userId, roleName);

    if (success) {
      console.log(`Role ${roleName} granted successfully to ${member.user.tag}`);
      res.json({ message: `Role: ${roleName} granted successfully.` });
    } else {
      console.log(`Failed to grant role ${roleName} to ${member.user.tag}`);
      res.status(500).json({ error: 'Failed to grant role.' });
    }
  } catch (error) {
    console.error('Error processing request:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.listen(PORT, () => {
  logger(`API Server running on port ${PORT}`);
  console.log(`API Server running on port ${PORT}`);
});

//test the bot.
client.on('messageCreate', async (message) => {
  if (!message.content.trim()) {
    console.log('Ignoring empty message or non-textual event.');
    return;
  }

  console.log(`Processing message: ${message.content}`);

  if (message.content.startsWith('!ping')) {
    await message.channel.send({ content: 'Pong!' });
  }

  if (message.content === '!listmembers') {
    const db = await getDb();
    if (message.guild) {
      const members = await db.all(
        'SELECT username FROM members WHERE guild_id = ?',
        message.guild.id
      );
      const memberList = members.map(m => m.username).join(', ');
      message.channel.send({ content: `Members: ${memberList}` });
    } else {
      console.error('Message does not belong to a guild.');
    }
  }

});

client.on('interactionCreate', async interaction => {
  // Handle the slash command interaction separately
  if (interaction.type === InteractionType.ApplicationCommand) {
    await handleCommandInteraction(interaction);
  }

  // Handle the button interaction separately
  if (interaction.type === InteractionType.MessageComponent) {
    await handleButtonInteraction(interaction as ButtonInteraction);
  }
});

async function processGetVerifiedCommand(interaction: ChatInputCommandInteraction) {
  // Create the button
  const getVerifiedButton = new ButtonBuilder()
    .setLabel('Get Verified')
    .setStyle(ButtonStyle.Link) // ButtonStyle.Link is used for URL buttons
    .setURL('https://communityfund.stellar.org/tiers'); // Set the button URL
  // Create an action row to hold the button
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(getVerifiedButton);
  // Send a message with the button
  await interaction.reply({
    content: 'Start your SCF journey by getting verified!',
    components: [row]
  });
}

async function processListMembersCommand(interaction: ChatInputCommandInteraction) {
  const db = await getDb();
  if (interaction.guild) {
    const members = await db.all(
      'SELECT username FROM members WHERE guild_id = ?',
      interaction.guild.id
    );

    const memberChunks = [];
    let currentChunk = '';

    members.forEach((member, index) => {
      const nextMemberString = `${member.username}${index < members.length - 1 ? ', ' : ''}`;
      if (currentChunk.length + nextMemberString.length > 1900) { // Keep some margin for safety
        memberChunks.push(currentChunk);
        currentChunk = nextMemberString;
      } else {
        currentChunk += nextMemberString;
      }
    });

    if (currentChunk) {
      memberChunks.push(currentChunk); // Push the last chunk
    }

    // If the list is too long, send multiple messages.
    if (memberChunks.length > 1) {
      await interaction.reply({ content: 'Members list is too long, sending in chunks:', ephemeral: true });
      for (const chunk of memberChunks) {
        await interaction.followUp({ content: chunk, ephemeral: true });
      }
    } else {
      // If there is only one chunk, send it as a single message.
      await interaction.reply({ content: `Members: ${memberChunks[0]}`, ephemeral: true });
    }
  } else {
    await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
  }
}

async function createVotingThread(
  interaction: CommandInteraction,
  nominee: GuildMember,
  nominator: GuildMember,
  nominateRole: string
): Promise<ThreadChannel | null> {
  // Ensure we're in a guild and the channel is a guild text channel
  if (!(interaction.channel instanceof TextChannel)) {
    await interaction.reply({ content: 'You can only create a voting thread within a server text channel.', ephemeral: true });
    return null;
  }
  // Create a public thread for voting
  const thread = await interaction.channel.threads.create({
    name: `Nomination: ${nominee.user.username} for ${nominateRole}`,
    autoArchiveDuration: 60,
    reason: `Nomination for ${nominee.user.username} to become a ${nominateRole}`,
  });
  logger('the thread for voting is being created')
  logger(JSON.stringify(thread))
  // Send an initial message to the thread with voting instructions
  const voteButton = new ButtonBuilder()
    .setCustomId(`vote-yes:${nominee.id}:${nominateRole}`)
    .setLabel('Vote Yes')
    .setStyle(ButtonStyle.Success);

  const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(voteButton);

  const embed = new EmbedBuilder()
    .setColor(0x0099FF)
    .setTitle(`Nomination for ${nominee.user.username}`)
    .setDescription(`Please cast your vote for ${nominee.displayName} to become a ${nominateRole}.`)
    .setTimestamp();

  await thread.send({
    content: `**Please Vote!*\n <@${nominator.user.id}> has nominated <@${nominee.user.id}> to become a ${nominateRole}. \n Their current SCF statistics are: \n put useful info here`,
    embeds: [embed],
    components: [actionRow],
  });

  await interaction.reply({ content: `Vote To Promote <@${nominee.user.id}> To ${nominateRole}`, ephemeral: true });
  const db = await getDb();
  //const roleId = await getRoleIdByName(interaction.guild as Guild, nominateRole);

  await db.run(`
  INSERT INTO voting_threads (thread_id, created_at, nominator_id, nominee_id, role_id, role_name, status)
  VALUES (?, ?, ?, ?, (SELECT role_id FROM roles WHERE role_name = ?), ?, ?)
`, [thread.id, new Date().toISOString(), nominator.id, nominee.id, nominateRole, nominateRole, "OPEN"]);
  return thread;
}

function checkNomineeRoles(nominee: GuildMember): { isPathFinder: boolean; isNavigator: boolean } {
  const isPathFinder = nominee.roles.cache.some(role => role.name === "SCF Pathfinder");
  const isNavigator = nominee.roles.cache.some(role => role.name === "SCF Navigator");
  return { isPathFinder, isNavigator };
}

function checkNominatorRole(nominator: GuildMember): { canNominateNavigator: boolean; canNominatePilot: boolean } {
  const canNominateNavigator = nominator.roles.cache.some(role => role.name === "SCF Navigator" || role.name === "SCF Pilot");
  const canNominatePilot = nominator.roles.cache.some(role => role.name === "SCF Pilot");
  return { canNominateNavigator, canNominatePilot };
}

function determineNomineeVoteLevel({ isPathFinder, isNavigator }: { isPathFinder: boolean; isNavigator: boolean }): string | null {
  if (isPathFinder) return "SCF Navigator";
  if (isNavigator) return "SCF Pilot";
  return null; // This case handles if a member has neither 'Path Finder' nor 'Navigator' role.
}

async function updateThreadVoteCount(thread: ThreadChannel, currentVoteCount: number): Promise<void> {
  // Ensure the thread's name is valid before attempting to split and update
  if (thread.name) {
    const baseName = thread.name.split('[')[0].trim();
    await thread.edit({ name: `${baseName} [Votes: ${currentVoteCount}]` });
  } else {
    logger('There was an error, the thread.name was not set')
    console.error('Thread name is not set.');
  }
}

async function grantRoleToNominee(guild: Guild, nomineeId: string, roleToAssignId: string): Promise<void> {
  const nominee = await guild.members.fetch(nomineeId);
  const role = guild.roles.cache.get(roleToAssignId);
  if (role) {
    await nominee.roles.add(role);
    logger(`Role ${role.name} granted to user ${nominee.user.tag}.`);
  } else {
    logger(`Error granting Role ID ${roleToAssignId} not found in guild.`)
    console.error(`Role ID ${roleToAssignId} not found in guild.`);
  }
}

async function processNominateCommand(interaction: CommandInteraction): Promise<void> {
  // Make sure this command is used in a guild and not in DMs.
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
    return;
  }

  // Make sure the command is called in a text channel where threads can be created.
  if (!(interaction.channel instanceof TextChannel)) {
    await interaction.reply({ content: 'You can only nominate within a server text channel.', ephemeral: true });
    return;
  }

  const nominator = interaction.member as GuildMember; // The member who initiated the command.
  const nominee = interaction.options.getMember('user') as GuildMember; // The member who is being nominated.

  // Prevent self-nomination
  if (nominator.id === nominee.id) {
    logger(`${nominator.id}, ${nominator.user.tag} tried to nominate themselves!`)
    await interaction.reply({ content: 'You cannot nominate yourself.', ephemeral: true });
    return;
  }

  // Perform role checks to ensure the nominator has the right to nominate.
  const nominatorRoles = checkNominatorRole(nominator);
  const nomineeRoles = checkNomineeRoles(nominee);
  logger(`Nominator ${nominator.user.tag} has roles: ${JSON.stringify(nominatorRoles)}`)
  logger(`Nominee ${nominee.user.tag} has roles: ${JSON.stringify(nomineeRoles)}`)

  // Determine the target role based on their current role
  let targetRole = determineNomineeVoteLevel(nomineeRoles);
  if (targetRole === null) {
    let msg = `User ${nominee.user.tag} does not have a role that can be nominated.`;
    logger(targetRole ? targetRole : msg);
    await interaction.reply({ content: msg, ephemeral: true });
    return;
  }

  // Ensure the nominee does not already have the target role.
  if (!targetRole || nominee.roles.cache.some(role => role.name === targetRole)) {
    let msg = `The user ${nominee.user.tag} already has the role ${targetRole} or cannot be promoted further.`;
    logger(msg);
    await interaction.reply({ content: msg, ephemeral: true });
    return;
  }

  // Check if the nominator has the permission to nominate someone for the target role.
  logger(targetRole)
  if (!targetRole || (targetRole === "SCF Pilot" && !nominatorRoles.canNominatePilot) || (targetRole === "SCF Navigator" && !nominatorRoles.canNominateNavigator)) {
    logger(`Nominator ${nominator.user.tag} does not have permission to nominate ${nominee.user.tag} for role ${targetRole}`)
    await interaction.reply({ content: `You do not have permission to nominate for the role: ${targetRole}`, ephemeral: true });
    return;
  }

  // Proceed to create the voting thread.
  logger("Creating Voting Thread")
  const thread = await createVotingThread(interaction, nominee, nominator, targetRole);
  if (!thread) {
    // If thread creation failed, the interaction reply is already handled in `createVotingThread`.
    return;
  }
}

async function processUpdateVoteCommand(interaction: CommandInteraction) {
  // Ensure this command is used within a thread
  if (!interaction.channel || !interaction.channel.isThread()) {
    await interaction.reply({ content: 'This command can only be used within a voting thread.', ephemeral: true });
    return;
  }

  const thread = interaction.channel as ThreadChannel;
  const db = await getDb();
  const result = await db.get(`SELECT vote_count FROM voting_threads WHERE thread_id = ?`, thread.id);

  if (!result) {
    await interaction.reply({ content: 'This thread does not correspond to a valid voting session.', ephemeral: true });
    return;
  }

  const currentVoteCount = result.vote_count;

  // Update the thread title with the new vote count
  await updateThreadVoteCount(thread, currentVoteCount);
  await interaction.reply({ content: `The vote count has been updated to ${currentVoteCount}.`, ephemeral: true });
}


async function handleCommandInteraction(interaction: CommandInteraction) {
  // Existing logic to handle slash commands
  // Place the slash command handling logic here.

  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  switch (commandName) {
    case 'listmembers':
      await processListMembersCommand(interaction);
      break;
    case 'nominate':
      await processNominateCommand(interaction);
      break;
    case 'getverified':
      await processGetVerifiedCommand(interaction);
      break;
    case 'updatevote':
      await processUpdateVoteCommand(interaction);
      break;
    case 'listactivevotes':
      await processListActiveVotesCommand(interaction);
      break;
  }
}

async function processListActiveVotesCommand(interaction: CommandInteraction): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: "This command can only be used within a server.", ephemeral: true });
    return;
  }
  const guild = interaction.guild; // Assign to a constant immediately after the check

  const db = await getDb();
  const activeVotes = await db.all(`
    SELECT thread_id, role_name, nominee_id, nominator_id, vote_count, datetime(created_at, 'localtime') as created_at
    FROM voting_threads
    WHERE (status IS NULL OR status = '' OR status = 'OPEN')
  `);

  const activeThreads = await interaction.guild.channels.fetchActiveThreads();
  const activeThreadIDs = new Set(activeThreads.threads.map(thread => thread.id));
  const filteredActiveVotes = activeVotes.filter(vote => activeThreadIDs.has(vote.thread_id));

  if (filteredActiveVotes.length === 0) {
    await interaction.reply({ content: "No active votes found.", ephemeral: true });
    return;
  }

  const navigatorVotes = filteredActiveVotes.filter(vote => vote.role_name === "SCF Navigator");
  const pilotVotes = filteredActiveVotes.filter(vote => vote.role_name === "SCF Pilot");

  const createAndSendEmbeds = async (title: string, votes: typeof filteredActiveVotes) => {
    let embed = new EmbedBuilder().setTitle(title).setColor(0x0099FF);
    let embedFieldsCount = 0;

    for (const vote of votes) {
      const threadLink = `[Vote Here](https://discord.com/channels/${guild.id}/${vote.thread_id})`;
      const fieldValue = `Date: ${vote.created_at.split(' ')[0]}\nNominee: <@${vote.nominee_id}>\nNominator: <@${vote.nominator_id}>\nVotes: ${vote.vote_count}\nLink: ${threadLink}`;

      if (embedFieldsCount + 1 > 25) { // Discord's embed field limit
        await interaction.followUp({ embeds: [embed], ephemeral: false });
        embed = new EmbedBuilder().setTitle(`${title} (cont.)`).setColor(0x0099FF);
        embedFieldsCount = 0;
      }

      embed.addFields({ name: "Nomination", value: fieldValue, inline: true });
      embedFieldsCount++;
    }

    if (embedFieldsCount > 0) {
      await interaction.followUp({ embeds: [embed], ephemeral: false });
    }
  };

  // Initially reply to confirm command reception and indicate processing
  await interaction.reply({ content: "Processing active votes...", ephemeral: true });

  // Separate handling to ensure the initial reply is sent before follow-ups
  if (navigatorVotes.length > 0) {
    await createAndSendEmbeds("Navigator Nominations", navigatorVotes);
  }
  if (pilotVotes.length > 0) {
    await createAndSendEmbeds("Pilot Nominations", pilotVotes);
  }
}

async function getRoleIdByName(guild: Guild, roleName: string): Promise<string | null> {
  const role = guild.roles.cache.find(r => r.name === roleName);
  return role ? role.id : null;
}

async function updateUserRole(guild: Guild, userId: string, roleName: string): Promise<boolean> {
  const member = await guild.members.fetch(userId);

  logger(`trying to **assign role** [${roleName}] to userid [${userId}]`)
  try {
    let previousRoleName;
    if (roleName == "SCF Pathfinder") {
      previousRoleName = "SCF Verified"
    }
    if (roleName == "SCF Navigator") {
      previousRoleName = "SCF Pathfinder"
    }
    if (roleName == "SCF Pilot") {
      previousRoleName = "SCF Navigator"
    }
    const voterRoleName = "SCF Voter";
    logger(`previous role was ${previousRoleName}`)
    const roleId = await getRoleIdByName(guild, roleName);
    const voterRoleId = await getRoleIdByName(guild, voterRoleName);
    const previousRoleId = previousRoleName ? await getRoleIdByName(guild, previousRoleName): null;
    if (!voterRoleId) {
      let msg = `**ERROR:** Role ${voterRoleName} not found in guild.`
      logger(msg)
      console.error(msg);
      return false;
    }
    if (!roleId) {
      let msg = `**ERROR:** Role ${roleName} not found in guild.`
      logger(msg)
      console.error(msg);
      return false;
    }
    if (!previousRoleId && previousRoleName) {
      let msg = `**ERROR:** Role ${previousRoleName} not found in guild.`
      logger(msg)
      console.error(msg);
      return false;
    }


    if (previousRoleName == "SCF Pathfinder") {
      await member.roles.add(voterRoleId, `${member.user.tag} has passed the vote to become a *SCF Voter*`)
      logger(`Role ${voterRoleName} assigned to user ${member.user.tag}.`);
    }
    if (!previousRoleId) {
      await member.roles.add(roleId, `${member.user.tag} has earned the role ${roleName}`);
      logger(`${member.user.tag} has earned the role ${roleName}`)
      return true
    }
    if (previousRoleName === "SCF Verified") {
      if (previousRoleName && previousRoleId) {
        await member.roles.remove(previousRoleId, `${member.user.tag} has earned ${roleName}, and no longer needs the ${previousRoleName} role.`)
        logger(`${previousRoleName} role has been removed from ${member.user.tag} because they have earned pathfinder`)
      }
      await member.roles.add(roleId, `${member.user.tag} has earned the role ${roleName}`);
      logger(`${member.user.tag} has earned the role ${roleName}`)
      return true
    }

    await member.roles.remove(previousRoleId, `${member.user.tag} has passed the vote to become a ${roleName}, and no longer needs the ${previousRoleName} role.`)
    logger(`Role ${previousRoleName} has been removed from ${member.user.tag}.`)

    await member.roles.add(roleId, `${member.user.tag} has passed the vote to become a ${roleName}`);
    logger(`Role ${roleName} assigned to user ${member.user.tag}.`);

    return true;
  } catch (error) {
    logger(`Error assigning or removing role: ${error}`)
    console.error('Error assigning or removing role:', error);
    return false;
  }
}

// a function that makes sure a user only has one of the 4 roles at a given time. if they have more than one then remove the others, and assign only the highest role they are entitled to.
async function fixUserRoles(member: GuildMember) {
  const scfRoles = ["SCF Verified", "SCF Pathfinder", "SCF Navigator", "SCF Pilot"];
  const currentRoles = member.roles.cache.filter(role => scfRoles.includes(role.name));
  logger(`${member.user.tag} roles are currently being fixed`)
  if (currentRoles.size > 1) {
    let highestRole = null;
    let highestRoleIndex = -1;

    // Find the highest role
    for (const role of currentRoles.values()) {
      const roleIndex = scfRoles.indexOf(role.name);
      if (roleIndex > highestRoleIndex) {
        highestRoleIndex = roleIndex;
        highestRole = role;
      }
      logger(`${member.user.tag} has role: ${role.name} ${role.id}. highest role is ${highestRole?.name}`)

    }

    // Remove lower roles
    for (const role of currentRoles.values()) {
      if (scfRoles.indexOf(role.name) < highestRoleIndex) {
        logger(`to fix roles for ${member.user.tag}, we will remove ${role.name}, ${role.id}`)
        await member.roles.remove(role.id, `${member.user.tag} had an extra role ${role.name}, and should only have had ${highestRole?.name}`);
      }
    }
  }
}

// This function checks if a member has any of the roles provided in the 'allowedRoles' array.
function memberHasRole(member: GuildMember, allowedRoles: string[]): boolean {
  return member.roles.cache.some(role => allowedRoles.includes(role.name));
}

async function handleButtonInteraction(interaction: ButtonInteraction): Promise<void> {
  const [action, nomineeId, roleName] = interaction.customId.split(':');
  if (action !== 'vote-yes') return; // or handle other actions as needed

  if (!(await validateVoterRole(interaction, roleName))) return;

  if (await recordVote(interaction, nomineeId, roleName)) {
    await interaction.reply({ content: 'Your vote has been recorded!', ephemeral: true });
  }
}

async function validateVoterRole(interaction: ButtonInteraction, roleName: string): Promise<boolean> {
  if (!interaction.guild) {
    await interaction.reply({ content: 'Voting is only permitted within a server thread channel.', ephemeral: true });
    return false;
  }
  const voter: GuildMember = await interaction.guild.members.fetch(interaction.user.id);
  const allowedVotingRoles = roleName === 'SCF Navigator' ? ['SCF Pilot', 'SCF Navigator'] : ['SCF Pilot'];

  if (!memberHasRole(voter, allowedVotingRoles)) {
    await interaction.reply({ content: `You do not have permission to vote for this role.`, ephemeral: true });
    return false;
  }
  return true;
}

async function recordVote(interaction: ButtonInteraction, nomineeId: string, roleName: string): Promise<boolean> {
  const db = await getDb();
  const thread = interaction.channel as ThreadChannel;
  const userId = interaction.user.id;

  // Fetch all votes for this thread from the database to update voteCounts
  const dbVotes = await db.all('SELECT voter_id FROM votes WHERE thread_id = ?', [thread.id]);
  const voteRecord = new Map(dbVotes.map(vote => [vote.voter_id, true]));

  // Update or initialize the voteRecord in voteCounts map
  voteCounts.set(thread.id, voteRecord);

  // Check if the current user has already voted
  if (voteRecord.has(userId)) {
    await interaction.reply({ content: 'You have already voted in this thread.', ephemeral: true });
    return false;
  }

  // Record the new vote
  voteRecord.set(userId, true);
  await db.run('INSERT INTO votes (thread_id, voter_id, vote_timestamp) VALUES (?, ?, ?)', [thread.id, userId, new Date().toISOString()]);

  // Update vote count in the database and thread title
  const newVoteCount = voteRecord.size;
  await updateVoteCountAndCheckRoleAssignment(interaction, thread, nomineeId, roleName, newVoteCount);
  return true;
}


async function updateVoteCountAndCheckRoleAssignment(
  interaction: ButtonInteraction,
  thread: ThreadChannel,
  nomineeId: string,
  roleName: string,
  currentVoteCount: number
): Promise<void> {
  const db = await getDb();

  if (!interaction.guild) {
    await interaction.reply({ content: 'Voting is only permitted within a server thread channel.', ephemeral: true });
    return;
  }

  // Check the thread's creation timestamp from the database
  const threadData = await db.get(`
    SELECT created_at
    FROM voting_threads
    WHERE thread_id = ?
  `, thread.id);

  // If threadData is not found, it's a logic error or missing data case
  if (!threadData) {
    await interaction.reply({ content: 'The voting thread data could not be found in the database.', ephemeral: true });
    return;
  }
  // Calculate the time difference from now to the thread's creation time
  const creationTime = new Date(threadData.creation_timestamp);
  const currentTime = new Date();
  const timeDiff = currentTime.getTime() - creationTime.getTime();
  const dayInMs = 24 * 60 * 60 * 1000
  // Check if the current time is beyond the 5-day limit
  if (timeDiff > (5 * dayInMs)) {
    // Close the thread as the voting period has expired
    await thread.setLocked(true);
    await thread.setArchived(true);

    // Update the status in the database
    await db.run(`
    UPDATE voting_threads
    SET status = 'CLOSED'
    WHERE thread_id = ?
  `, thread.id);


    await interaction.reply({ content: 'The voting period for this thread has expired and it has been closed. This user will need to wait at least 30 days before trying again.', ephemeral: false });
    return;
  }

  const requiredVotesForRole = 5;
  // we could also require different votes for each role.
  const requiredVotesForPilot = 5;
  const requiredVotesForNavigator = 3;
  // Update the vote count if within the 5-day limit
  if (currentVoteCount < requiredVotesForRole) {
    logger(currentVoteCount + "Current vote count")
    logger(requiredVotesForRole + "Required votes for role")
    await interaction.reply({ content: 'Vote recorded but not enough votes to assign the role yet.', ephemeral: false });
    // Increment the vote count in the database
    await db.run(`
    UPDATE voting_threads
    SET vote_count = vote_count + 1
    WHERE thread_id = ?
  `, thread.id);
    await updateThreadVoteCount(thread, currentVoteCount); // Reflect the new vote count in the thread's name
    return;
  } else {
    // Assign role since the required votes have been reached
    const assignRoleSuccess = await updateUserRole(interaction.guild, nomineeId, roleName);
    if (assignRoleSuccess) {
      // Close the thread after role assignment
      await interaction.reply({ content: `The vote is complete, and the role ${roleName} has been assigned.`, components: [], ephemeral: false });

      await thread.setLocked(true);
      await thread.setArchived(true);

      // Update the status in the database
      await db.run(`
      UPDATE voting_threads
      SET status = 'CLOSED'
      WHERE thread_id = ?
    `, thread.id);
    } else {
      await interaction.reply({ content: '**ERROR:** Unable to assign role, contact the admin', ephemeral: false });
    }
  }

}

async function logger(message: string) {
  try {
    let userId = ADMIN_USER
    if (botIsLoggedIn) {
      const user = await client.users.fetch(userId);
      await user.send(message);
      console.log('ADMIN LOG: ', message);
    } else {
      console.log('ADMIN LOG: ', message);
    }
  } catch (error) {
    console.error('Error sending direct message:', error);
  }
}


// Use the bot token from the environment variables
client.login(process.env.DISCORD_BOT_TOKEN);

logger("This is a test message")
