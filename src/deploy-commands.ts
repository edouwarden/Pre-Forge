import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import * as dotenv from 'dotenv';

dotenv.config();

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;

if (!token) throw new Error('DISCORD_TOKEN is required');
if (!clientId) throw new Error('CLIENT_ID is required');

const commands = [
  new SlashCommandBuilder()
    .setName('create-container')
    .setDescription('Create a Docker sandbox for a coding task')
    .addStringOption(option =>
      option
        .setName('folder')
        .setDescription('Workspace folder under projects/')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('name')
        .setDescription('Container name')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('command')
        .setDescription('Instruction for the worker agent')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('attachments')
        .setDescription('Optional comma-separated files or notes to pass to the planner')
        .setRequired(false)
    ),
];

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    console.log('Deploying application commands...');
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log('Commands deployed successfully.');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
})();
