import type {
  ModelRoute,
  ModelRouteDecision,
  ModelRoutingPolicy,
  ModelTaskClass,
} from "./types.js";

export class StaticModelRouter implements ModelRoutingPolicy {
  public readonly version: string;
  readonly #routes: Readonly<Record<ModelTaskClass, ModelRoute>>;

  public constructor(
    version: string,
    routes: Readonly<Record<ModelTaskClass, ModelRoute>>,
  ) {
    if (version.trim() === "") throw new Error("routing policy version is required");
    this.version = version;
    this.#routes = routes;
  }

  public route(taskClass: ModelTaskClass): ModelRouteDecision {
    const route = this.#routes[taskClass];
    if (route.modelId.trim() === "") {
      throw new Error(`model id is missing for task class ${taskClass}`);
    }
    return { ...route, taskClass, routingPolicyVersion: this.version };
  }
}
