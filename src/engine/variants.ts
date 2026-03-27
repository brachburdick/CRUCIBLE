import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { VariantConfig } from '../types/index.js';
import type { DecompositionStrategyConfig } from './DecompositionEngine.js';
import { DEFAULT_STRATEGY_CONFIG } from './DecompositionEngine.js';

/**
 * Extended variant config that includes optional decomposition strategy.
 * This extends the base VariantConfig without modifying src/types/index.ts.
 */
export interface ExtendedVariantConfig extends VariantConfig {
  decompositionStrategy?: DecompositionStrategyConfig & {
    name: string;
    fallback?: string;
  };
}

/**
 * Load a variant config from a YAML file.
 *
 * If `systemPrompt` ends in `.md`, it is treated as a file path and read.
 * If `skills` are provided, each path is read and appended to the system prompt.
 *
 * All file paths are resolved relative to the YAML file's directory.
 */
export async function loadVariant(variantPath: string): Promise<VariantConfig> {
  const content = await fs.readFile(variantPath, 'utf-8');
  const raw = parseYaml(content) as Record<string, unknown>;
  const baseDir = path.dirname(path.resolve(variantPath));

  // Validate required fields
  if (typeof raw['name'] !== 'string' || !raw['name']) {
    throw new Error(`Variant file ${variantPath} must have a non-empty "name" field`);
  }
  if (typeof raw['description'] !== 'string' || !raw['description']) {
    throw new Error(`Variant file ${variantPath} must have a non-empty "description" field`);
  }

  const config: VariantConfig = {
    name: raw['name'],
    description: raw['description'],
    agent: typeof raw['agent'] === 'string' ? raw['agent'] : undefined,
    model: typeof raw['model'] === 'string' ? raw['model'] : undefined,
    budget: typeof raw['budget'] === 'number' ? raw['budget'] : undefined,
    ttl: typeof raw['ttl'] === 'number' ? raw['ttl'] : undefined,
    metadata: typeof raw['metadata'] === 'object' && raw['metadata'] !== null
      ? raw['metadata'] as Record<string, unknown>
      : undefined,
  };

  // Resolve system prompt — inline text or file path
  if (typeof raw['systemPrompt'] === 'string') {
    if (raw['systemPrompt'].endsWith('.md')) {
      const promptPath = path.resolve(baseDir, raw['systemPrompt']);
      config.systemPrompt = await fs.readFile(promptPath, 'utf-8');
    } else {
      config.systemPrompt = raw['systemPrompt'];
    }
  }

  // Resolve and append skills
  if (Array.isArray(raw['skills'])) {
    const skillContents: string[] = [];
    for (const skillPath of raw['skills']) {
      if (typeof skillPath !== 'string') continue;
      const resolved = path.resolve(baseDir, skillPath);
      const skillContent = await fs.readFile(resolved, 'utf-8');
      skillContents.push(skillContent);
    }

    if (skillContents.length > 0) {
      const base = config.systemPrompt ?? '';
      config.systemPrompt = [
        base,
        '',
        '--- SKILLS ---',
        '',
        ...skillContents,
      ].join('\n').trim();
    }

    config.skills = raw['skills'].filter((s): s is string => typeof s === 'string');
  }

  return config;
}

/**
 * Load a variant config with decomposition strategy support.
 *
 * Parses the standard VariantConfig fields plus `decomposition_strategy`
 * from the YAML file.
 */
export async function loadExtendedVariant(variantPath: string): Promise<ExtendedVariantConfig> {
  const base = await loadVariant(variantPath);
  const content = await fs.readFile(variantPath, 'utf-8');
  const raw = parseYaml(content) as Record<string, unknown>;

  const extended: ExtendedVariantConfig = { ...base };

  if (typeof raw['decomposition_strategy'] === 'object' && raw['decomposition_strategy'] !== null) {
    const ds = raw['decomposition_strategy'] as Record<string, unknown>;
    extended.decompositionStrategy = {
      ...DEFAULT_STRATEGY_CONFIG,
      name: typeof ds['name'] === 'string' ? ds['name'] : 'D0',
      fallback: typeof ds['fallback'] === 'string' ? ds['fallback'] : undefined,
      decomposition_trigger:
        (ds['decomposition_trigger'] as DecompositionStrategyConfig['decomposition_trigger']) ??
        DEFAULT_STRATEGY_CONFIG.decomposition_trigger,
      max_depth:
        typeof ds['max_depth'] === 'number' ? ds['max_depth'] : DEFAULT_STRATEGY_CONFIG.max_depth,
      max_files_hint:
        typeof ds['max_files_hint'] === 'number' ? ds['max_files_hint'] : DEFAULT_STRATEGY_CONFIG.max_files_hint,
      three_conditions:
        typeof ds['three_conditions'] === 'boolean' ? ds['three_conditions'] : DEFAULT_STRATEGY_CONFIG.three_conditions,
      compositionality_check:
        typeof ds['compositionality_check'] === 'boolean'
          ? ds['compositionality_check']
          : DEFAULT_STRATEGY_CONFIG.compositionality_check,
    };
  }

  return extended;
}
