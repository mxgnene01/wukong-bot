export { TaskExecutor } from './executor';
export { WorkerEngine } from './engine';

import { WorkerEngine } from './engine';

let workerEngineInstance: WorkerEngine | null = null;

export function getWorkerEngine(): WorkerEngine {
  if (!workerEngineInstance) {
    workerEngineInstance = new WorkerEngine();
  }
  return workerEngineInstance;
}

export function startWorker() {
  const engine = getWorkerEngine();
  engine.start();
  return engine;
}

export function stopWorker() {
  if (workerEngineInstance) {
    workerEngineInstance.stop();
  }
}
