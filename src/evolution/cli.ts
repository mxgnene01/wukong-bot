import { getEvolutionEngine } from './index';
import { logger } from '../utils/logger';

// Parse arguments
const args = process.argv.slice(2);
const command = args[0];
const query = args[1];

if (!command || !query) {
  console.error('Usage: bun src/evolution/cli.ts <acquire|evolve> <query>');
  process.exit(1);
}

async function main() {
  const engine = getEvolutionEngine();
  
  try {
    if (command === 'acquire') {
      const result = await engine.acquireCapability(query);
      if (result) {
        console.log(`Successfully acquired capability: ${query}`);
      } else {
        console.log(`Failed to acquire capability: ${query}. Try manual creation.`);
      }
    } else if (command === 'evolve') {
      await engine.evolveFromInsight(query);
      console.log(`Processed evolution from insight: ${query}`);
    } else {
      console.error(`Unknown command: ${command}`);
      process.exit(1);
    }
  } catch (error) {
    logger.error('[EvolutionCLI] Error:', error);
    process.exit(1);
  }
}

main();
