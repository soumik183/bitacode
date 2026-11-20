/**
 * plugins command — `bitacode plugins [list|enable|disable|info]`.
 *
 * Lists discovered plugins and toggles them through a registry stored outside
 * the project, so enabling a project plugin does not require trusting it twice.
 */

import process from 'node:process';
import { canonicalProjectPath, isProjectTrusted } from '../utils/project-trust.js';
import {
  discoverPlugins,
  readPluginRegistry,
  setPluginEnabled,
  writePluginRegistry,
  type PluginDescriptor,
  type PluginRegistry,
} from '../utils/plugins.js';

export interface PluginsCommandOptions {
  cwd?: string;
  json?: boolean;
  write?: (line: string) => void;
  /** Override the registry file for tests. */
  registryFile?: string;
  userDir?: string;
  projectDir?: string;
}

interface PluginRow {
  name: string;
  version: string;
  description: string;
  scope: PluginDescriptor['scope'];
  enabled: boolean;
  entry: string;
}

function toRow(plugin: PluginDescriptor): PluginRow {
  return {
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    scope: plugin.scope,
    enabled: plugin.enabled,
    entry: plugin.entry,
  };
}

function findPlugin(plugins: readonly PluginDescriptor[], name: string | undefined): PluginDescriptor | undefined {
  if (!name) return undefined;
  const lowered = name.toLowerCase();
  return plugins.find((plugin) => plugin.name.toLowerCase() === lowered);
}

export function runPluginsCommand(args: string[], options: PluginsCommandOptions = {}): number {
  const cwd = options.cwd ?? process.cwd();
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const sub = (args[0] ?? 'list').toLowerCase();
  const name = args[1];

  let registry: PluginRegistry;
  try {
    registry = readPluginRegistry(options.registryFile);
  } catch (err) {
    write(`Could not read plugin registry: ${String(err instanceof Error ? err.message : err)}`);
    return 1;
  }
  const discovery = discoverPlugins({
    cwd,
    registry,
    ...(options.userDir ? { userDir: options.userDir } : {}),
    ...(options.projectDir ? { projectDir: options.projectDir } : {}),
  });

  switch (sub) {
    case 'enable':
    case 'disable': {
      if (!name) {
        write(`Usage: bitacode plugins ${sub} <name>`);
        return 1;
      }
      const plugin = findPlugin(discovery.plugins, name);
      if (!plugin) {
        write(`Plugin not found: ${name}`);
        return 1;
      }
      const enabled = sub === 'enable';
      const next = setPluginEnabled(registry, plugin.name, enabled);
      if (!writePluginRegistry(next, options.registryFile)) {
        write(`Could not save plugin registry for ${plugin.name}`);
        return 1;
      }
      if (options.json) write(JSON.stringify({ name: plugin.name, enabled }));
      else write(`${enabled ? 'Enabled' : 'Disabled'} ${plugin.name}`);
      return 0;
    }
    case 'info': {
      const plugin = findPlugin(discovery.plugins, name);
      if (!plugin) {
        write(name ? `Plugin not found: ${name}` : 'Usage: bitacode plugins info <name>');
        return 1;
      }
      if (options.json) {
        write(JSON.stringify({ ...toRow(plugin), dir: plugin.dir, manifest: plugin.manifestPath, trusted: isProjectTrusted(cwd) }));
      } else {
        write(`name: ${plugin.name}`);
        write(`version: ${plugin.version}`);
        write(`description: ${plugin.description || '(none)'}`);
        write(`scope: ${plugin.scope}`);
        write(`status: ${plugin.enabled ? 'enabled' : 'disabled'}`);
        write(`entry: ${plugin.entry}`);
      }
      return 0;
    }
    case 'list':
    default: {
      const rows = discovery.plugins.map(toRow);
      if (options.json) {
        write(JSON.stringify({
          cwd: canonicalProjectPath(cwd),
          trusted: isProjectTrusted(cwd),
          plugins: rows,
          errors: discovery.errors,
        }));
        return 0;
      }
      if (rows.length === 0) {
        write('No plugins found.');
      } else {
        for (const row of rows) {
          write(`${row.enabled ? '+' : '-'} ${row.name}@${row.version} (${row.scope})${row.description ? ` — ${row.description}` : ''}`);
        }
      }
      for (const error of discovery.errors) write(`! ${error}`);
      return 0;
    }
  }
}
