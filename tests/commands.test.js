import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationCommandType } from 'discord.js';
import { getCommandDefinitions, getHelpEmbed } from '../src/commands.js';
import { config } from '../src/config.js';

describe('commands', () => {
  describe('getCommandDefinitions', () => {
    it('returns all required slash and context menu commands', () => {
      const commands = getCommandDefinitions();
      assert.ok(Array.isArray(commands));
      assert.strictEqual(commands.length, 9);

      const jsonCommands = commands.map((c) => c.toJSON());
      const names = jsonCommands.map((c) => c.name);

      assert.ok(names.includes('help'));
      assert.ok(names.includes('status'));
      assert.ok(names.includes('stats'));
      assert.ok(names.includes('rescan'));
      assert.ok(names.includes('export-links'));
      assert.ok(names.includes('restore'));
      assert.ok(names.includes('restore-links'));
      assert.ok(names.includes('stop'));
      assert.ok(names.includes('Repost / Archive Media'));
    });

    it('correctly configures context menu command as Message type', () => {
      const commands = getCommandDefinitions();
      const contextCmd = commands.find((c) => c.name === 'Repost / Archive Media');
      assert.ok(contextCmd);
      const json = contextCmd.toJSON();
      assert.strictEqual(json.type, ApplicationCommandType.Message);
    });

    it('verifies /rescan command options', () => {
      const commands = getCommandDefinitions();
      const rescan = commands.find((c) => c.name === 'rescan');
      assert.ok(rescan);
      const json = rescan.toJSON();
      const optionNames = json.options.map((o) => o.name);
      assert.ok(optionNames.includes('channel'));
      assert.ok(optionNames.includes('limit'));
      assert.ok(optionNames.includes('missing_only'));
      assert.ok(optionNames.includes('force'));
      assert.ok(optionNames.includes('concurrency'));
    });

    it('verifies /export-links format choices', () => {
      const commands = getCommandDefinitions();
      const exportCmd = commands.find((c) => c.name === 'export-links');
      assert.ok(exportCmd);
      const json = exportCmd.toJSON();
      const formatOpt = json.options.find((o) => o.name === 'format');
      assert.ok(formatOpt);
      const choiceValues = formatOpt.choices.map((c) => c.value);
      assert.deepStrictEqual(choiceValues, ['all', 'json', 'markdown', 'csv']);
    });

    it('verifies /restore command parameters', () => {
      const commands = getCommandDefinitions();
      const restoreCmd = commands.find((c) => c.name === 'restore');
      assert.ok(restoreCmd);
      const json = restoreCmd.toJSON();
      const optionNames = json.options.map((o) => o.name);
      assert.ok(optionNames.includes('source'));
      assert.ok(optionNames.includes('target_channel'));
      assert.ok(optionNames.includes('auto_create_channels'));
      assert.ok(optionNames.includes('attribution'));
      assert.ok(optionNames.includes('dry_run'));

      const sourceOpt = json.options.find((o) => o.name === 'source');
      assert.strictEqual(sourceOpt.required, true);
    });
  });

  describe('getHelpEmbed', () => {
    it('generates a rich embed including current version and command guide', () => {
      const embed = getHelpEmbed();
      assert.ok(embed);
      const json = embed.toJSON();
      assert.ok(json.title.includes(config.version));
      assert.ok(json.fields.length >= 3);
      assert.ok(json.fields.some((f) => f.name.includes('Slash Commands')));
      assert.ok(json.fields.some((f) => f.name.includes('Prefix Commands')));
    });
  });
});
