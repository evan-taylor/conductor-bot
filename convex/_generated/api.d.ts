/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as actions from "../actions.js";
import type * as http from "../http.js";
import type * as lib_conductor from "../lib/conductor.js";
import type * as lib_config from "../lib/config.js";
import type * as lib_recipes from "../lib/recipes.js";
import type * as lib_security from "../lib/security.js";
import type * as lib_slack from "../lib/slack.js";
import type * as lib_slackEvents from "../lib/slackEvents.js";
import type * as runs from "../runs.js";
import type * as validators from "../validators.js";
import type * as workflow from "../workflow.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  actions: typeof actions;
  http: typeof http;
  "lib/conductor": typeof lib_conductor;
  "lib/config": typeof lib_config;
  "lib/recipes": typeof lib_recipes;
  "lib/security": typeof lib_security;
  "lib/slack": typeof lib_slack;
  "lib/slackEvents": typeof lib_slackEvents;
  runs: typeof runs;
  validators: typeof validators;
  workflow: typeof workflow;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  workflow: import("@convex-dev/workflow/_generated/component.js").ComponentApi<"workflow">;
};
