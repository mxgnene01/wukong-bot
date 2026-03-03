import { defaultConfig, validateConfig, type Config } from './schema';

let configInstance: Config | null = null;

export function loadConfig(overrides?: Partial<Config>): Config {
  if (configInstance && !overrides) {
    return configInstance;
  }

  let config: Config = { ...defaultConfig };

  if (overrides) {
    config = deepMerge(config, overrides);
  }

  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new Error(`Config validation failed:\n${errors.join('\n')}`);
  }

  configInstance = config;
  return config;
}

export function getConfig(): Config {
  if (!configInstance) {
    return loadConfig();
  }
  return configInstance;
}

function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
  const result = { ...target };

  for (const key in source) {
    const value = source[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = deepMerge((result[key] as any) || {}, value);
    } else {
      result[key] = value as any;
    }
  }

  return result;
}
