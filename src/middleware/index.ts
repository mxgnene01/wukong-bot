import { MiddlewarePipeline, type Middleware } from './types';
import { createDuplicateCheckMiddleware } from './duplicate_check';
import { createContextBuilderMiddleware } from './context_builder';
import { createSessionManagerMiddleware } from './session_manager';

export { MiddlewarePipeline, type Middleware, type MiddlewareContext } from './types';

export function createDefaultPipeline(): MiddlewarePipeline {
  const pipeline = new MiddlewarePipeline();

  pipeline.use(createDuplicateCheckMiddleware());
  pipeline.use(createContextBuilderMiddleware());
  pipeline.use(createSessionManagerMiddleware());

  return pipeline;
}

export function createNamedMiddlewares(): Record<string, Middleware> {
  return {
    duplicate_check: createDuplicateCheckMiddleware(),
    context_builder: createContextBuilderMiddleware(),
    session_manager: createSessionManagerMiddleware(),
  };
}
